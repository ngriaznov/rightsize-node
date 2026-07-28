import * as http from "node:http";
import "../backend-msb/index.js";
import "../backend-docker/index.js";
import { describe, itIntegration, assert } from "../../test/harness.js";
import { QdrantContainer } from "./qdrant.js";

/** A bare JSON HTTP round-trip against the REST API — no Qdrant client enters this repo. */
function requestJson(url: string, method: string, payload?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = payload !== undefined ? JSON.stringify(payload) : undefined;
    const parsed = new URL(url);
    const req = http.request(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        timeout: 15_000,
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

describe("Qdrant module", () => {
  itIntegration("create a collection, upsert a point, search and assert the score", async () => {
    const qdrant = await QdrantContainer.start();
    try {
      const createRes = await requestJson(`${qdrant.restUrl}/collections/books`, "PUT", {
        vectors: { size: 4, distance: "Dot" },
      });
      assert.equal(createRes.status, 200, createRes.body);

      // A point vector of [0.3, 0, 0, 0] against the query vector [1, 0, 0,
      // 0] below gives a Dot-distance score of exactly 0.3 — the value
      // verified live against qdrant/qdrant:v1.18.3.
      const upsertRes = await requestJson(`${qdrant.restUrl}/collections/books/points?wait=true`, "PUT", {
        points: [{ id: 1, vector: [0.3, 0, 0, 0], payload: { title: "The Hobbit" } }],
      });
      assert.equal(upsertRes.status, 200, upsertRes.body);

      const searchRes = await requestJson(`${qdrant.restUrl}/collections/books/points/search`, "POST", {
        vector: [1, 0, 0, 0],
        limit: 1,
      });
      assert.equal(searchRes.status, 200, searchRes.body);
      const parsed = JSON.parse(searchRes.body) as { result: Array<{ id: number; score: number }> };
      assert.equal(parsed.result.length, 1);
      assert.equal(parsed.result[0]?.id, 1);
      assert.ok(Math.abs((parsed.result[0]?.score ?? Number.NaN) - 0.3) < 0.001, `expected score ~0.3, got ${parsed.result[0]?.score}`);
    } finally {
      await qdrant.stop();
    }
  });
});
