import mysql from "mysql2/promise";
import "../backend-msb/index.js";
import "../backend-docker/index.js";
import { describe, itIntegration, assert } from "../../test/harness.js";
import { MySQLContainer } from "./mysql.js";

describe("MySQL module", () => {
  itIntegration("real client round-trip: CREATE TABLE, INSERT, SELECT", async () => {
    const mysqlContainer = await MySQLContainer.start();
    try {
      const connection = await mysql.createConnection(mysqlContainer.connectionString);
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
      await mysqlContainer.stop();
    }
  });
});
