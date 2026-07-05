import * as http from "node:http";
import "../backend-msb/index.js";
import "../backend-docker/index.js";
import { describe, itIntegration, assert } from "../../test/harness.js";
import { Wait } from "../core/wait.js";
import { SpringCloudConfigContainer } from "./spring-cloud-config.js";

function httpGetJson(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 5_000 }, (res) => {
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

describe("SpringCloudConfig module", () => {
  itIntegration(
    "boots on the default 1024MB memory limit and serves actuator health",
    async () => {
      const server = new SpringCloudConfigContainer()
        // The "native" profile serves config from the classpath so no
        // external git repo is required; without it the default git
        // EnvironmentRepository refuses to start ("configure a uri...").
        .withEnv("SPRING_PROFILES_ACTIVE", "native")
        .waitingFor(Wait.forHttp("/actuator/health").forPort(8888).withStartupTimeout(180_000));
      await server.start();
      try {
        const res = await httpGetJson(`${server.uri}/actuator/health`);
        assert.equal(res.status, 200);
        assert.match(res.body, /"status":"UP"/);
      } finally {
        await server.stop();
      }
    },
  );
});
