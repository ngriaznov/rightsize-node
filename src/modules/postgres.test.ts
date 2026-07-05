import { describe, it, assert } from "../../test/harness.js";
import { PostgresContainer } from "./postgres.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";

describe("PostgresContainer", () => {
  it("exposes port 5432 with test/test/test defaults and overrides the LLVM-deps env", async () => {
    const backend = new FakeModuleBackend();
    const postgres = new PostgresContainer().withBackend(backend).waitingFor(instantReadyWait());
    await postgres.start();
    try {
      assert.equal(backend.lastSpec?.image, "postgres:18-alpine");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [5432]);
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("POSTGRES_USER"), "test");
      assert.equal(env.get("POSTGRES_PASSWORD"), "test");
      assert.equal(env.get("POSTGRES_DB"), "test");
      assert.equal(env.get("DOCKER_PG_LLVM_DEPS"), "");
    } finally {
      await postgres.stop();
    }
  });

  it("withUsername/withPassword/withDatabase override the defaults and the accessors reflect them", async () => {
    const backend = new FakeModuleBackend();
    const postgres = new PostgresContainer()
      .withBackend(backend)
      .waitingFor(instantReadyWait())
      .withUsername("alice")
      .withPassword("s3cret")
      .withDatabase("appdb");
    await postgres.start();
    try {
      assert.equal(postgres.username, "alice");
      assert.equal(postgres.password, "s3cret");
      assert.equal(postgres.databaseName, "appdb");
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("POSTGRES_USER"), "alice");
      assert.equal(env.get("POSTGRES_PASSWORD"), "s3cret");
      assert.equal(env.get("POSTGRES_DB"), "appdb");
    } finally {
      await postgres.stop();
    }
  });

  it("builds a postgres:// connection string from user, password, host, mapped port, and database", async () => {
    const backend = new FakeModuleBackend();
    const postgres = new PostgresContainer().withBackend(backend).waitingFor(instantReadyWait());
    await postgres.start();
    try {
      const mapped = postgres.getMappedPort(5432);
      assert.equal(postgres.connectionString, `postgres://test:test@127.0.0.1:${mapped}/test`);
    } finally {
      await postgres.stop();
    }
  });

  it("accepts a custom image tag via the constructor", async () => {
    const backend = new FakeModuleBackend();
    const postgres = new PostgresContainer("postgres:17-alpine").withBackend(backend).waitingFor(instantReadyWait());
    await postgres.start();
    try {
      assert.equal(backend.lastSpec?.image, "postgres:17-alpine");
    } finally {
      await postgres.stop();
    }
  });
});
