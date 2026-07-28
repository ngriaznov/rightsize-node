import { describe, it, assert } from "../../test/harness.js";
import { ValkeyContainer } from "./valkey.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";
import { DockerImageName } from "../core/docker-image-name.js";
import { IncompatibleImageError } from "../core/errors.js";

describe("ValkeyContainer", () => {
  it("exposes port 6379 with no env required", async () => {
    const backend = new FakeModuleBackend();
    const valkey = new ValkeyContainer().withBackend(backend).waitingFor(instantReadyWait());
    await valkey.start();
    try {
      assert.equal(backend.lastSpec?.image, "valkey/valkey:latest");
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

  it("accepts a DockerImageName instance whose repository matches", async () => {
    const backend = new FakeModuleBackend();
    const image = DockerImageName.parse("valkey/valkey:9-alpine");
    const valkey = new ValkeyContainer(image).withBackend(backend).waitingFor(instantReadyWait());
    await valkey.start();
    try {
      assert.equal(backend.lastSpec?.image, "valkey/valkey:9-alpine");
    } finally {
      await valkey.stop();
    }
  });

  it("throws IncompatibleImageError before start() for a mismatched repository", () => {
    try {
      new ValkeyContainer("redis:latest");
      assert.ok(false, "expected the constructor to throw");
    } catch (err) {
      assert.ok(err instanceof IncompatibleImageError);
      assert.equal((err as IncompatibleImageError).suppliedRepository, "redis");
      assert.equal((err as IncompatibleImageError).expectedRepository, "valkey/valkey");
    }
  });

  it("accepts a mismatched image explicitly marked asCompatibleSubstituteFor('valkey/valkey')", async () => {
    const backend = new FakeModuleBackend();
    const substitute = DockerImageName.parse("mycorp/valkey-hardened:9.1").asCompatibleSubstituteFor("valkey/valkey");
    const valkey = new ValkeyContainer(substitute).withBackend(backend).waitingFor(instantReadyWait());
    await valkey.start();
    try {
      assert.equal(backend.lastSpec?.image, "mycorp/valkey-hardened:9.1");
    } finally {
      await valkey.stop();
    }
  });
});
