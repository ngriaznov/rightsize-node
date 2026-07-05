import * as http from "node:http";
import "../backend-msb/index.js";
import "../backend-docker/index.js";
import { describe, itIntegration, assert } from "../../test/harness.js";
import { FlinkContainer } from "./flink.js";
import { UnsupportedByBackendError } from "../core/errors.js";
import { Backends } from "../core/backends.js";

function getJson(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 10_000 }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("request timed out"));
    });
  });
}

async function retryUntil(fn: () => Promise<boolean>, attempts: number, delayMs: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      if (await fn()) {
        return true;
      }
    } catch {
      // keep retrying — same rationale as the Pinot IT's retryUntil.
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

describe("Flink module", () => {
  itIntegration("bare JobManager: /overview responds on both backends", async () => {
    const flink = await FlinkContainer.start();
    try {
      const res = await getJson(`${flink.restUrl}/overview`);
      assert.equal(res.status, 200);
      assert.match(res.body, /"taskmanagers"/);
    } finally {
      await flink.stop();
    }
  });

  itIntegration(
    "withTaskManager() on docker: a real two-container session cluster registers one TaskManager",
    async () => {
      if (Backends.active().name !== "docker") {
        return;
      }
      const flink = new FlinkContainer().withTaskManager();
      await flink.start();
      try {
        // The TaskManager's heartbeat registration with the JobManager
        // lands a beat after both containers individually report ready —
        // bounded retry rather than a fixed sleep.
        const registered = await retryUntil(
          async () => {
            const overview = await getJson(`${flink.restUrl}/overview`);
            return overview.status === 200 && /"taskmanagers":1/.test(overview.body);
          },
          30,
          1_000,
        );
        assert.ok(registered, "TaskManager never registered with the JobManager");

        const taskmanagers = await getJson(`${flink.restUrl}/taskmanagers`);
        assert.equal(taskmanagers.status, 200);
        assert.match(taskmanagers.body, /"taskmanagers"\s*:\s*\[/);
      } finally {
        await flink.stop();
      }
    },
  );

  itIntegration(
    "withTaskManager() on microsandbox: throws UnsupportedByBackendError naming the nc/busybox cause",
    async () => {
      if (Backends.active().name !== "microsandbox") {
        return;
      }
      const flink = new FlinkContainer().withTaskManager();
      let caught: unknown;
      try {
        await flink.start();
      } catch (err) {
        caught = err;
      } finally {
        await flink.stop();
      }
      assert.ok(caught instanceof UnsupportedByBackendError, "expected UnsupportedByBackendError");
      const typed = caught as UnsupportedByBackendError;
      assert.equal(typed.backend, "microsandbox");
      assert.match(typed.message, /nc\/busybox/);
    },
  );
});
