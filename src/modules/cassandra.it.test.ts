import "../backend-msb/index.js";
import "../backend-docker/index.js";
import { describe, itIntegration, assert } from "../../test/harness.js";
import { CassandraContainer } from "./cassandra.js";

describe("Cassandra module", () => {
  itIntegration("cqlsh round-trip via the image's bundled client: CREATE KEYSPACE/TABLE, INSERT, SELECT returns the row", async () => {
    const cassandra = await CassandraContainer.start();
    try {
      // `cqlsh` ships inside the image itself — no Cassandra driver enters
      // this repo. A single `-e` invocation runs all four statements.
      const cql = [
        "CREATE KEYSPACE IF NOT EXISTS rightsize_it WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};",
        "CREATE TABLE IF NOT EXISTS rightsize_it.t (id int PRIMARY KEY, x text);",
        "INSERT INTO rightsize_it.t (id, x) VALUES (1, 'hello');",
        "SELECT x FROM rightsize_it.t WHERE id = 1;",
      ].join(" ");

      // --request-timeout=60: cqlsh's ~10s per-request default is too tight for
      // the FIRST statement on a cold Cassandra JVM on a loaded CI runner — the
      // same first-request warmup the Elasticsearch IT budgets for.
      const result = await cassandra.exec("cqlsh", "--request-timeout=60", "-e", cql);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /hello/);
    } finally {
      await cassandra.stop();
    }
  });
});
