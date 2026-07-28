import { describe, it, assert } from "../../test/harness.js";
import { RedisContainer } from "./redis.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";
import { DockerImageName } from "../core/docker-image-name.js";
import { IncompatibleImageError } from "../core/errors.js";

describe("RedisContainer", () => {
  it("exposes port 6379 and waits on a listening port by default", async () => {
    const backend = new FakeModuleBackend();
    const redis = new RedisContainer().withBackend(backend).waitingFor(instantReadyWait());
    await redis.start();
    try {
      assert.equal(backend.lastSpec?.image, "redis:latest");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [6379]);
    } finally {
      await redis.stop();
    }
  });

  it("builds a redis:// uri from host and mapped port", async () => {
    const backend = new FakeModuleBackend();
    const redis = new RedisContainer().withBackend(backend).waitingFor(instantReadyWait());
    await redis.start();
    try {
      const mapped = redis.getMappedPort(6379);
      assert.equal(redis.uri, `redis://127.0.0.1:${mapped}`);
    } finally {
      await redis.stop();
    }
  });

  it("accepts a custom image tag via the constructor", async () => {
    const backend = new FakeModuleBackend();
    const redis = new RedisContainer("redis:8-alpine").withBackend(backend).waitingFor(instantReadyWait());
    await redis.start();
    try {
      assert.equal(backend.lastSpec?.image, "redis:8-alpine");
    } finally {
      await redis.stop();
    }
  });

  it("accepts a DockerImageName instance whose repository matches", async () => {
    const backend = new FakeModuleBackend();
    const image = DockerImageName.parse("redis:8-alpine");
    const redis = new RedisContainer(image).withBackend(backend).waitingFor(instantReadyWait());
    await redis.start();
    try {
      assert.equal(backend.lastSpec?.image, "redis:8-alpine");
    } finally {
      await redis.stop();
    }
  });

  it("throws IncompatibleImageError before start() for a mismatched repository", () => {
    try {
      new RedisContainer("valkey/valkey:latest");
      assert.ok(false, "expected the constructor to throw");
    } catch (err) {
      assert.ok(err instanceof IncompatibleImageError);
      assert.equal((err as IncompatibleImageError).suppliedRepository, "valkey/valkey");
      assert.equal((err as IncompatibleImageError).expectedRepository, "redis");
    }
  });

  it("accepts a mismatched image explicitly marked asCompatibleSubstituteFor('redis')", async () => {
    const backend = new FakeModuleBackend();
    const substitute = DockerImageName.parse("mycorp/redis-hardened:8.6").asCompatibleSubstituteFor("redis");
    const redis = new RedisContainer(substitute).withBackend(backend).waitingFor(instantReadyWait());
    await redis.start();
    try {
      assert.equal(backend.lastSpec?.image, "mycorp/redis-hardened:8.6");
    } finally {
      await redis.stop();
    }
  });
});
