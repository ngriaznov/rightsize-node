import * as http from "node:http";
import "../backend-msb/index.js";
import "../backend-docker/index.js";
import { describe, itIntegration, assert } from "../../test/harness.js";
import { Neo4jContainer } from "./neo4j.js";

interface CypherResult {
  results: Array<{ columns: string[]; data: Array<{ row: unknown[] }> }>;
  errors: unknown[];
}

function txCommit(httpUrl: string, username: string, password: string, statement: string, parameters?: Record<string, unknown>): Promise<CypherResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(`${httpUrl}/db/neo4j/tx/commit`);
    const auth = Buffer.from(`${username}:${password}`).toString("base64");
    const body = JSON.stringify({ statements: [{ statement, parameters: parameters ?? {} }] });
    const req = http.request(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        timeout: 10_000,
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let chunks = "";
        res.on("data", (chunk: Buffer) => (chunks += chunk.toString("utf8")));
        res.on("end", () => {
          try {
            resolve(JSON.parse(chunks) as CypherResult);
          } catch (err) {
            reject(err);
          }
        });
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

describe("Neo4j module", () => {
  itIntegration("HTTP Cypher transaction round-trip: CREATE then MATCH returns the created value", async () => {
    const neo4j = await Neo4jContainer.start();
    try {
      const created = await txCommit(
        neo4j.httpUrl,
        neo4j.username,
        neo4j.password,
        "CREATE (n:RightsizeIt {name: $name}) RETURN n.name",
        { name: "hello-neo4j" },
      );
      assert.equal(created.errors.length, 0);
      assert.equal(created.results[0]?.data[0]?.row[0], "hello-neo4j");

      const matched = await txCommit(
        neo4j.httpUrl,
        neo4j.username,
        neo4j.password,
        "MATCH (n:RightsizeIt {name: $name}) RETURN n.name",
        { name: "hello-neo4j" },
      );
      assert.equal(matched.errors.length, 0);
      assert.equal(matched.results[0]?.data[0]?.row[0], "hello-neo4j");
    } finally {
      await neo4j.stop();
    }
  });
});
