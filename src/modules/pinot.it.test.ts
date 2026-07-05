import * as http from "node:http";
import "../backend-msb/index.js";
import "../backend-docker/index.js";
import { describe, itIntegration, assert } from "../../test/harness.js";
import { PinotContainer } from "./pinot.js";

/**
 * Real REST round-trip against a live Pinot QuickStart cluster: POST a
 * minimal schema to the controller, GET it back, then confirm the broker's
 * health endpoint too — proving the whole four-JVM cluster actually came up,
 * not just that the controller's HTTP port answers. On msb this doubles as
 * the de-facto stress test of the 4096MB memory floor documented on the
 * module.
 */

interface HttpJsonResult {
  status: number;
  body: string;
}

function requestJson(url: string, method: string, payload?: unknown): Promise<HttpJsonResult> {
  return new Promise((resolve, reject) => {
    const body = payload !== undefined ? JSON.stringify(payload) : undefined;
    const parsed = new URL(url);
    const req = http.request(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method,
        timeout: 10_000,
        headers: body !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {},
        // Pin HTTP/1.1 explicitly: node:http defaults to 1.1 already, but the
        // broker's slightly-later readiness (it comes up just after the
        // controller reports healthy) means the round-trip needs bounded
        // retries below, not a protocol change here.
      },
      (res) => {
        let chunks = "";
        res.on("data", (chunk: Buffer) => (chunks += chunk.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: chunks }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("request timed out"));
    });
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

async function retryUntil(fn: () => Promise<boolean>, attempts: number, delayMs: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      if (await fn()) {
        return true;
      }
    } catch {
      // The broker's listening socket can reset an in-flight connection
      // attempt (ECONNRESET/"socket hang up") in the seconds before it
      // actually comes up — not just answer slowly. Treat a failed attempt
      // the same as a non-200: keep retrying rather than aborting the gate.
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

describe("Pinot module", () => {
  itIntegration("QuickStart cluster: schema POST/GET on the controller, health on both controller and broker", async () => {
    const pinot = await PinotContainer.start();
    try {
      const schema = {
        schemaName: "rightsizeTest",
        dimensionFieldSpecs: [{ name: "id", dataType: "STRING" }],
      };
      const postRes = await requestJson(`${pinot.controllerUrl}/schemas`, "POST", schema);
      assert.equal(postRes.status, 200);

      const getRes = await requestJson(`${pinot.controllerUrl}/schemas/rightsizeTest`, "GET");
      assert.equal(getRes.status, 200);
      assert.match(getRes.body, /"schemaName"\s*:\s*"rightsizeTest"/);

      const controllerHealth = await requestJson(`${pinot.controllerUrl}/health`, "GET");
      assert.equal(controllerHealth.status, 200);

      // The broker can become ready a beat after the controller reports
      // healthy — bounded retry rather than a fixed sleep.
      const brokerHealthy = await retryUntil(
        async () => (await requestJson(`${pinot.brokerUrl}/health`, "GET")).status === 200,
        60,
        2_000,
      );
      assert.ok(brokerHealthy, "broker /health never returned 200");
    } finally {
      await pinot.stop();
    }
  });
});
