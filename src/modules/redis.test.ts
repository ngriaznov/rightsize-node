import { describe, it, assert } from "../../test/harness.js";
import { RedisContainer } from "./redis.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";

describe("RedisContainer", () => {
  it("exposes port 6379 and waits on a listening port by default", async () => {
    const backend = new FakeModuleBackend();
    const redis = new RedisContainer().withBackend(backend).waitingFor(instantReadyWait());
    await redis.start();
    try {
      assert.equal(backend.lastSpec?.image, "redis:8.6-alpine");
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
});
