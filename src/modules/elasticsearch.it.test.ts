import * as http from "node:http";
import "../backend-msb/index.js";
import "../backend-docker/index.js";
import { describe, itIntegration, assert } from "../../test/harness.js";
import { ElasticsearchContainer } from "./elasticsearch.js";

/** A bare JSON HTTP round-trip against the REST API — no Elasticsearch client enters this repo. */
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

describe("Elasticsearch module", () => {
  itIntegration("index a document with ?refresh=true, then search and find it", async () => {
    const es = await ElasticsearchContainer.start("elasticsearch:9.4.4");
    try {
      const indexRes = await requestJson(`${es.restUrl}/books/_doc/1?refresh=true`, "PUT", {
        title: "The Hobbit",
        author: "Tolkien",
      });
      assert.equal(indexRes.status, 201, indexRes.body);

      const searchRes = await requestJson(`${es.restUrl}/books/_search`, "POST", {
        query: { match: { title: "Hobbit" } },
      });
      assert.equal(searchRes.status, 200, searchRes.body);
      const parsed = JSON.parse(searchRes.body) as {
        hits: { hits: Array<{ _id: string; _source: { title: string } }> };
      };
      assert.equal(parsed.hits.hits.length, 1);
      assert.equal(parsed.hits.hits[0]?._id, "1");
      assert.equal(parsed.hits.hits[0]?._source.title, "The Hobbit");
    } finally {
      await es.stop();
    }
  });
});
