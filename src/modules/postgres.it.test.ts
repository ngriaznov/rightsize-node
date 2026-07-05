import pg from "pg";
import "../backend-msb/index.js";
import "../backend-docker/index.js";
import { describe, itIntegration, assert } from "../../test/harness.js";
import { PostgresContainer } from "./postgres.js";

describe("PostgreSQL module", () => {
  itIntegration("real client round-trip: CREATE TABLE, INSERT, SELECT", async () => {
    const postgres = await PostgresContainer.start();
    try {
      const client = new pg.Client({ connectionString: postgres.connectionString });
      await client.connect();
      try {
        await client.query("CREATE TABLE t (x INT)");
        await client.query("INSERT INTO t (x) VALUES (1)");
        const result = await client.query("SELECT x FROM t");
        assert.equal(result.rows.length, 1);
        assert.equal(result.rows[0].x, 1);
      } finally {
        await client.end();
      }
    } finally {
      await postgres.stop();
    }
  });
});
