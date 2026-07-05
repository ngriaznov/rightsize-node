import mysql from "mysql2/promise";
import "../backend-msb/index.js";
import "../backend-docker/index.js";
import { describe, itIntegration, assert } from "../../test/harness.js";
import { MariaDBContainer } from "./mariadb.js";

/**
 * Reuses the MySQL round-trip shape: `mysql2` speaks the MySQL wire
 * protocol MariaDB implements, so no MariaDB-specific client is needed.
 */
describe("MariaDB module", () => {
  itIntegration("real client round-trip: CREATE TABLE, INSERT, SELECT", async () => {
    const mariadb = await MariaDBContainer.start();
    try {
      const connection = await mysql.createConnection(mariadb.connectionString);
      try {
        await connection.query("CREATE TABLE t (x INT)");
        await connection.query("INSERT INTO t (x) VALUES (1)");
        const [rows] = await connection.query("SELECT x FROM t");
        const result = rows as Array<{ x: number }>;
        assert.equal(result.length, 1);
        assert.equal(result[0]?.x, 1);
      } finally {
        await connection.end();
      }
    } finally {
      await mariadb.stop();
    }
  });
});
