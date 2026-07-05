import * as http from "node:http";
import "../backend-msb/index.js";
import "../backend-docker/index.js";
import { describe, itIntegration, assert } from "../../test/harness.js";
import { ClickHouseContainer } from "./clickhouse.js";

/**
 * HTTP query round-trip via the plain HTTP interface (no client dependency
 * — ClickHouse's HTTP protocol is just "POST a SQL statement as the body,
 * read the body back").
 */
function query(httpUrl: string, username: string, password: string, sql: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(httpUrl);
    const auth = Buffer.from(`${username}:${password}`).toString("base64");
    const body = sql;
    const req = http.request(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: "/",
        method: "POST",
        timeout: 10_000,
        headers: {
          authorization: `Basic ${auth}`,
          "content-length": Buffer.byteLength(body),
        },
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
    req.write(body);
    req.end();
  });
}

describe("ClickHouse module", () => {
  itIntegration("HTTP query round-trip: CREATE TABLE, INSERT, SELECT", async () => {
    const clickhouse = await ClickHouseContainer.start();
    try {
      const { username, password, httpUrl } = clickhouse;

      const createRes = await query(httpUrl, username, password, "CREATE TABLE t (x Int32) ENGINE=Memory");
      assert.equal(createRes.status, 200, createRes.body);

      const insertRes = await query(httpUrl, username, password, "INSERT INTO t VALUES (1)");
      assert.equal(insertRes.status, 200, insertRes.body);

      const selectRes = await query(httpUrl, username, password, "SELECT x FROM t FORMAT TSV");
      assert.equal(selectRes.status, 200, selectRes.body);
      assert.equal(selectRes.body.trim(), "1");
    } finally {
      await clickhouse.stop();
    }
  });
});
