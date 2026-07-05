import * as http from "node:http";
import "../backend-msb/index.js";
import "../backend-docker/index.js";
import { describe, itIntegration, assert } from "../../test/harness.js";
import { WireMockContainer } from "./wiremock.js";

function requestJson(url: string, method: string, payload?: unknown): Promise<{ status: number; body: string }> {
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
        headers:
          body !== undefined
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
            : {},
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

describe("WireMock module", () => {
  itIntegration("stub round-trip: POST a mapping, then GET the stubbed path and assert the body", async () => {
    const wiremock = await WireMockContainer.start();
    try {
      const mapping = {
        request: { method: "GET", url: "/hello" },
        response: { status: 200, body: "hello from a stub", headers: { "Content-Type": "text/plain" } },
      };
      const postRes = await requestJson(`${wiremock.adminUrl}/mappings`, "POST", mapping);
      assert.equal(postRes.status, 201);

      const getRes = await requestJson(`${wiremock.baseUrl}/hello`, "GET");
      assert.equal(getRes.status, 200);
      assert.equal(getRes.body, "hello from a stub");
    } finally {
      await wiremock.stop();
    }
  });
});
