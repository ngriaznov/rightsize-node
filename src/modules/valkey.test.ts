import { describe, it, assert } from "../../test/harness.js";
import { ValkeyContainer } from "./valkey.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";

describe("ValkeyContainer", () => {
  it("exposes port 6379 with no env required", async () => {
    const backend = new FakeModuleBackend();
    const valkey = new ValkeyContainer().withBackend(backend).waitingFor(instantReadyWait());
    await valkey.start();
    try {
      assert.equal(backend.lastSpec?.image, "valkey/valkey:9.1-alpine");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [6379]);
      assert.deepEqual(backend.lastSpec?.env, []);
    } finally {
      await valkey.stop();
    }
  });

  it("builds a redis:// uri from host and mapped port", async () => {
    const backend = new FakeModuleBackend();
    const valkey = new ValkeyContainer().withBackend(backend).waitingFor(instantReadyWait());
    await valkey.start();
    try {
      const mapped = valkey.getMappedPort(6379);
      assert.equal(valkey.uri, `redis://127.0.0.1:${mapped}`);
    } finally {
      await valkey.stop();
    }
  });

  it("accepts a custom image tag via the constructor", async () => {
    const backend = new FakeModuleBackend();
    const valkey = new ValkeyContainer("valkey/valkey:9-alpine").withBackend(backend).waitingFor(instantReadyWait());
    await valkey.start();
    try {
      assert.equal(backend.lastSpec?.image, "valkey/valkey:9-alpine");
    } finally {
      await valkey.stop();
    }
  });
});
