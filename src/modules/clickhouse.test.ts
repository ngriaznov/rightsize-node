import { describe, it, assert } from "../../test/harness.js";
import { ClickHouseContainer } from "./clickhouse.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";
import { DockerImageName } from "../core/docker-image-name.js";
import { IncompatibleImageError } from "../core/errors.js";

describe("ClickHouseContainer", () => {
  it("exposes HTTP (8123) and native (9000) ports with test/test/test defaults", async () => {
    const backend = new FakeModuleBackend();
    const clickhouse = new ClickHouseContainer().withBackend(backend).waitingFor(instantReadyWait());
    await clickhouse.start();
    try {
      assert.equal(backend.lastSpec?.image, "clickhouse/clickhouse-server:latest");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [8123, 9000]);
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("CLICKHOUSE_USER"), "test");
      assert.equal(env.get("CLICKHOUSE_PASSWORD"), "test");
      assert.equal(env.get("CLICKHOUSE_DB"), "test");
    } finally {
      await clickhouse.stop();
    }
  });

  it("withUsername/withPassword/withDatabase override the defaults and the accessors reflect them", async () => {
    const backend = new FakeModuleBackend();
    const clickhouse = new ClickHouseContainer()
      .withBackend(backend)
      .waitingFor(instantReadyWait())
      .withUsername("alice")
      .withPassword("s3cret")
      .withDatabase("appdb");
    await clickhouse.start();
    try {
      assert.equal(clickhouse.username, "alice");
      assert.equal(clickhouse.password, "s3cret");
      assert.equal(clickhouse.databaseName, "appdb");
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("CLICKHOUSE_USER"), "alice");
      assert.equal(env.get("CLICKHOUSE_PASSWORD"), "s3cret");
      assert.equal(env.get("CLICKHOUSE_DB"), "appdb");
    } finally {
      await clickhouse.stop();
    }
  });

  it("builds httpUrl from host and the mapped HTTP port", async () => {
    const backend = new FakeModuleBackend();
    const clickhouse = new ClickHouseContainer().withBackend(backend).waitingFor(instantReadyWait());
    await clickhouse.start();
    try {
      const mapped = clickhouse.getMappedPort(8123);
      assert.equal(clickhouse.httpUrl, `http://127.0.0.1:${mapped}`);
    } finally {
      await clickhouse.stop();
    }
  });

  it("accepts a custom image tag via the constructor", async () => {
    const backend = new FakeModuleBackend();
    const clickhouse = new ClickHouseContainer("clickhouse/clickhouse-server:25.8.1").withBackend(backend).waitingFor(instantReadyWait());
    await clickhouse.start();
    try {
      assert.equal(backend.lastSpec?.image, "clickhouse/clickhouse-server:25.8.1");
    } finally {
      await clickhouse.stop();
    }
  });

  it("accepts a DockerImageName instance whose repository matches", async () => {
    const backend = new FakeModuleBackend();
    const image = DockerImageName.parse("clickhouse/clickhouse-server:25.8.1");
    const clickhouse = new ClickHouseContainer(image).withBackend(backend).waitingFor(instantReadyWait());
    await clickhouse.start();
    try {
      assert.equal(backend.lastSpec?.image, "clickhouse/clickhouse-server:25.8.1");
    } finally {
      await clickhouse.stop();
    }
  });

  it("throws IncompatibleImageError before start() for a mismatched repository", () => {
    try {
      new ClickHouseContainer("postgres:latest");
      assert.ok(false, "expected the constructor to throw");
    } catch (err) {
      assert.ok(err instanceof IncompatibleImageError);
      assert.equal((err as IncompatibleImageError).suppliedRepository, "postgres");
      assert.equal((err as IncompatibleImageError).expectedRepository, "clickhouse/clickhouse-server");
    }
  });

  it("accepts a mismatched image explicitly marked asCompatibleSubstituteFor('clickhouse/clickhouse-server')", async () => {
    const backend = new FakeModuleBackend();
    const substitute = DockerImageName.parse("mycorp/clickhouse-hardened:25.8").asCompatibleSubstituteFor(
      "clickhouse/clickhouse-server",
    );
    const clickhouse = new ClickHouseContainer(substitute).withBackend(backend).waitingFor(instantReadyWait());
    await clickhouse.start();
    try {
      assert.equal(backend.lastSpec?.image, "mycorp/clickhouse-hardened:25.8");
    } finally {
      await clickhouse.stop();
    }
  });
});
