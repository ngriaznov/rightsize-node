import { describe, it, assert } from "../../test/harness.js";
import { MariaDBContainer } from "./mariadb.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";

describe("MariaDBContainer", () => {
  it("exposes port 3306 with test/test/test defaults plus MARIADB_ROOT_PASSWORD", async () => {
    const backend = new FakeModuleBackend();
    const mariadb = new MariaDBContainer().withBackend(backend).waitingFor(instantReadyWait());
    await mariadb.start();
    try {
      assert.equal(backend.lastSpec?.image, "mariadb:11.4");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [3306]);
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("MARIADB_USER"), "test");
      assert.equal(env.get("MARIADB_PASSWORD"), "test");
      assert.equal(env.get("MARIADB_DATABASE"), "test");
      assert.equal(env.get("MARIADB_ROOT_PASSWORD"), "test");
    } finally {
      await mariadb.stop();
    }
  });

  it("withUsername/withPassword/withDatabase override the defaults and the accessors reflect them", async () => {
    const backend = new FakeModuleBackend();
    const mariadb = new MariaDBContainer()
      .withBackend(backend)
      .waitingFor(instantReadyWait())
      .withUsername("alice")
      .withPassword("s3cret")
      .withDatabase("appdb");
    await mariadb.start();
    try {
      assert.equal(mariadb.username, "alice");
      assert.equal(mariadb.password, "s3cret");
      assert.equal(mariadb.databaseName, "appdb");
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("MARIADB_USER"), "alice");
      assert.equal(env.get("MARIADB_PASSWORD"), "s3cret");
      assert.equal(env.get("MARIADB_DATABASE"), "appdb");
    } finally {
      await mariadb.stop();
    }
  });

  it("builds a mysql:// connection string from user, password, host, mapped port, and database", async () => {
    const backend = new FakeModuleBackend();
    const mariadb = new MariaDBContainer().withBackend(backend).waitingFor(instantReadyWait());
    await mariadb.start();
    try {
      const mapped = mariadb.getMappedPort(3306);
      assert.equal(mariadb.connectionString, `mysql://test:test@127.0.0.1:${mapped}/test`);
    } finally {
      await mariadb.stop();
    }
  });

  it("accepts a custom image tag via the constructor", async () => {
    const backend = new FakeModuleBackend();
    const mariadb = new MariaDBContainer("mariadb:11.4.3").withBackend(backend).waitingFor(instantReadyWait());
    await mariadb.start();
    try {
      assert.equal(backend.lastSpec?.image, "mariadb:11.4.3");
    } finally {
      await mariadb.stop();
    }
  });

  describe("the anchored readiness regex", () => {
    // Captured verbatim from a real `docker run mariadb:11.4` boot (see the
    // module's class doc). The real server's Version line carries `port:
    // 3306` and `mariadb.org binary distribution` together; the temp
    // server's equivalent line has `port: 0` instead, so it can never
    // false-match.
    const capturedBootLog = [
      "2026-07-04 21:32:11 0 [Note] mariadbd: ready for connections.",
      "Version: '11.4.12-MariaDB-ubu2404'  socket: '/run/mysqld/mysqld.sock'  port: 0  mariadb.org binary distribution",
      "2026-07-04 21:32:14 0 [Note] Server socket created on IP: '0.0.0.0', port: '3306'.",
      "2026-07-04 21:32:14 0 [Note] Server socket created on IP: '::', port: '3306'.",
      "2026-07-04 21:32:14 0 [Note] mariadbd: ready for connections.",
      "Version: '11.4.12-MariaDB-ubu2404'  socket: '/run/mysqld/mysqld.sock'  port: 3306  mariadb.org binary distribution",
    ];

    it("matches exactly once, on the real server's Version line, against the captured boot log", () => {
      const re = /.*port: 3306.*mariadb\.org binary distribution.*/;
      const matches = capturedBootLog.filter((line) => re.test(line));
      assert.equal(matches.length, 1);
      assert.equal(matches[0], capturedBootLog[5]);
    });

    it("is not satisfied by the temp server's port-0 Version line", () => {
      const re = /.*port: 3306.*mariadb\.org binary distribution.*/;
      assert.equal(re.test(capturedBootLog[1] ?? ""), false, "temp server port-0 Version line must not match");
    });
  });
});
