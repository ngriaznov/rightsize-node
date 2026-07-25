import * as http from "node:http";
import "../backend-msb/index.js";
import "../backend-docker/index.js";
import { describe, itIntegration, assert } from "../../test/harness.js";
import { MinIOContainer } from "./minio.js";

/** A bare unauthenticated GET — no signing, no credentials — used both for the health probe and the anonymous-denial assertion. */
function get(url: string): Promise<{ status: number; body: string }> {
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

describe("MinIO module", () => {
  itIntegration("mc round-trip (mb/cp/cat) via the image's bundled client; health check and auth are enforced", async () => {
    const minio = await MinIOContainer.start();
    try {
      // `mc` ships inside the image itself — no S3 SDK enters this repo.
      // `MC_HOST_local` is set per-exec (each exec() call is its own
      // process, so nothing set by one invocation persists to the next).
      const mcHost = `MC_HOST_local=http://${minio.rootUser}:${minio.rootPassword}@127.0.0.1:9000`;

      const mb = await minio.exec("sh", "-c", `${mcHost} mc mb local/rightsize-it`);
      assert.equal(mb.exitCode, 0, mb.stderr);

      // Writes a guest file and uploads it with `mc cp` rather than feeding
      // `mc pipe` over stdin: `mc pipe` reads stdin, and an exec'd `mc pipe`
      // under the microsandbox backend either dumps its goroutines and exits
      // non-zero or hangs outright (both observed directly). `mc cp` needs no
      // stdin and round-trips reliably. /srv, not /tmp — the guest mounts /tmp
      // as a small tmpfs.
      const put = await minio.exec(
        "sh",
        "-c",
        `printf 'hello from rightsize' > /srv/hello.txt && ${mcHost} mc cp /srv/hello.txt local/rightsize-it/hello.txt`,
      );
      assert.equal(put.exitCode, 0, put.stderr);

      const cat = await minio.exec("sh", "-c", `${mcHost} mc cat local/rightsize-it/hello.txt`);
      assert.equal(cat.exitCode, 0, cat.stderr);
      assert.equal(cat.stdout.trim(), "hello from rightsize");

      const health = await get(`${minio.endpointUrl}/minio/health/live`);
      assert.equal(health.status, 200);

      const anonymous = await get(`${minio.endpointUrl}/`);
      assert.equal(anonymous.status, 403);
      assert.match(anonymous.body, /AccessDenied/);
    } finally {
      await minio.stop();
    }
  });
});
