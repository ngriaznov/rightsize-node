import * as http from "node:http";
import "../backend-msb/index.js";
import "../backend-docker/index.js";
import { describe, itIntegration, assert } from "../../test/harness.js";
import { FlociContainer } from "./floci.js";

function request(url: string, method: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method,
        timeout: 10_000,
        headers: body !== undefined ? { "content-length": Buffer.byteLength(body) } : {},
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

describe("Floci module", () => {
  itIntegration("AWS variant: S3 create-bucket/put-object/get-object round-trips with no request signing", async () => {
    const floci = FlociContainer.aws();
    await floci.start();
    try {
      const endpoint = floci.endpointUrl;

      const createBucket = await request(`${endpoint}/rightsize-test-bucket`, "PUT");
      assert.ok(createBucket.status >= 200 && createBucket.status < 300, `create-bucket failed: ${createBucket.status}`);

      const putObject = await request(`${endpoint}/rightsize-test-bucket/hello.txt`, "PUT", "hello world");
      assert.ok(putObject.status >= 200 && putObject.status < 300, `put-object failed: ${putObject.status}`);

      const getObject = await request(`${endpoint}/rightsize-test-bucket/hello.txt`, "GET");
      assert.ok(getObject.status >= 200 && getObject.status < 300, `get-object failed: ${getObject.status}`);
      assert.equal(getObject.body, "hello world");
    } finally {
      await floci.stop();
    }
  });

  itIntegration("Azure variant: /health answers UP", async () => {
    const floci = FlociContainer.azure();
    await floci.start();
    try {
      const res = await request(`${floci.endpointUrl}/health`, "GET");
      assert.equal(res.status, 200);
      assert.match(res.body, /"status":"UP"/);
    } finally {
      await floci.stop();
    }
  });

  itIntegration("GCP variant: /health answers with a services map", async () => {
    const floci = FlociContainer.gcp();
    await floci.start();
    try {
      const res = await request(`${floci.endpointUrl}/health`, "GET");
      assert.equal(res.status, 200);
      assert.match(res.body, /"services"/);
    } finally {
      await floci.stop();
    }
  });
});
