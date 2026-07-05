import { describe, it, assert } from "../../test/harness.js";
import { MySQLContainer } from "./mysql.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";

describe("MySQLContainer", () => {
  it("exposes port 3306 with test/test/test defaults plus MYSQL_ROOT_PASSWORD", async () => {
    const backend = new FakeModuleBackend();
    const mysql = new MySQLContainer().withBackend(backend).waitingFor(instantReadyWait());
    await mysql.start();
    try {
      assert.equal(backend.lastSpec?.image, "mysql:8.4");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [3306]);
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("MYSQL_USER"), "test");
      assert.equal(env.get("MYSQL_PASSWORD"), "test");
      assert.equal(env.get("MYSQL_DATABASE"), "test");
      assert.equal(env.get("MYSQL_ROOT_PASSWORD"), "test");
    } finally {
      await mysql.stop();
    }
  });

  it("withUsername/withPassword/withDatabase override the defaults and the accessors reflect them", async () => {
    const backend = new FakeModuleBackend();
    const mysql = new MySQLContainer()
      .withBackend(backend)
      .waitingFor(instantReadyWait())
      .withUsername("alice")
      .withPassword("s3cret")
      .withDatabase("appdb");
    await mysql.start();
    try {
      assert.equal(mysql.username, "alice");
      assert.equal(mysql.password, "s3cret");
      assert.equal(mysql.databaseName, "appdb");
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("MYSQL_USER"), "alice");
      assert.equal(env.get("MYSQL_PASSWORD"), "s3cret");
      assert.equal(env.get("MYSQL_DATABASE"), "appdb");
    } finally {
      await mysql.stop();
    }
  });

  it("builds a mysql:// connection string from user, password, host, mapped port, and database", async () => {
    const backend = new FakeModuleBackend();
    const mysql = new MySQLContainer().withBackend(backend).waitingFor(instantReadyWait());
    await mysql.start();
    try {
      const mapped = mysql.getMappedPort(3306);
      assert.equal(mysql.connectionString, `mysql://test:test@127.0.0.1:${mapped}/test`);
    } finally {
      await mysql.stop();
    }
  });

  it("accepts a custom image tag via the constructor", async () => {
    const backend = new FakeModuleBackend();
    const mysql = new MySQLContainer("mysql:8.4.10").withBackend(backend).waitingFor(instantReadyWait());
    await mysql.start();
    try {
      assert.equal(backend.lastSpec?.image, "mysql:8.4.10");
    } finally {
      await mysql.stop();
    }
  });

  describe("the anchored readiness regex", () => {
    // Captured verbatim from a real `docker run mysql:8.4` boot (see the
    // module's class doc) — proves the regex rejects the temp server's
    // port-0 line and the X Plugin's port-33060 line, matching only the
    // real server's port-3306 line, exactly once.
    const capturedBootLog = [
      "2026-07-04T21:01:43.353698Z 0 [System] [MY-011323] [Server] X Plugin ready for connections. Socket: /var/run/mysqld/mysqlx.sock",
      "2026-07-04T21:01:43.353743Z 0 [System] [MY-010931] [Server] /usr/sbin/mysqld: ready for connections. Version: '8.4.10'  socket: '/var/run/mysqld/mysqld.sock'  port: 0  MySQL Community Server - GPL.",
      "2026-07-04T21:01:45.554963Z 0 [System] [MY-011323] [Server] X Plugin ready for connections. Bind-address: '::' port: 33060, socket: /var/run/mysqld/mysqlx.sock",
      "2026-07-04T21:01:45.555029Z 0 [System] [MY-010931] [Server] /usr/sbin/mysqld: ready for connections. Version: '8.4.10'  socket: '/var/run/mysqld/mysqld.sock'  port: 3306  MySQL Community Server - GPL.",
    ];

    it("matches exactly once, on the real server's line, against the captured boot log", () => {
      const re = /.*mysqld: ready for connections.*port: 3306($|[^0-9]).*/;
      const matches = capturedBootLog.filter((line) => re.test(line));
      assert.equal(matches.length, 1);
      assert.match(matches[0] ?? "", /port: 3306 {2}MySQL Community Server/);
    });

    it("is not satisfied by the temp server's port-0 line or the X Plugin's port-33060 line alone", () => {
      const re = /.*mysqld: ready for connections.*port: 3306($|[^0-9]).*/;
      assert.equal(re.test(capturedBootLog[1] ?? ""), false, "temp server port:0 line must not match");
      assert.equal(re.test(capturedBootLog[2] ?? ""), false, "X Plugin port:33060 line must not match");
    });
  });
});
