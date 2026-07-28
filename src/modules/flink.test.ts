import { describe, it, assert } from "../../test/harness.js";
import { FlinkContainer } from "./flink.js";
import { UnsupportedByBackendError, IncompatibleImageError } from "../core/errors.js";
import { DockerImageName } from "../core/docker-image-name.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";

/** A fake backend whose `name` reads "microsandbox" — proves the msb guard branches on the real resolved backend name. */
class FakeMsbBackend extends FakeModuleBackend {
  override readonly name = "microsandbox";
}

describe("FlinkContainer", () => {
  it("exposes RPC (6123) and REST (8081), runs the jobmanager command, and sets jobmanager.rpc.address", async () => {
    const backend = new FakeModuleBackend();
    const flink = new FlinkContainer().withBackend(backend).waitingFor(instantReadyWait());
    await flink.start();
    try {
      assert.equal(backend.lastSpec?.image, "flink:latest");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [6123, 8081]);
      assert.deepEqual(backend.lastSpec?.command, ["jobmanager"]);
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("FLINK_PROPERTIES"), "jobmanager.rpc.address: flink-jobmanager");
    } finally {
      await flink.stop();
    }
  });

  it("defaults to a 1024MB memory limit", async () => {
    const backend = new FakeModuleBackend();
    const flink = new FlinkContainer().withBackend(backend).waitingFor(instantReadyWait());
    await flink.start();
    try {
      assert.equal(backend.lastSpec?.memoryLimitMb, 1024);
    } finally {
      await flink.stop();
    }
  });

  it("builds restUrl from host and the mapped REST port", async () => {
    const backend = new FakeModuleBackend();
    const flink = new FlinkContainer().withBackend(backend).waitingFor(instantReadyWait());
    await flink.start();
    try {
      const mapped = flink.getMappedPort(8081);
      assert.equal(flink.restUrl, `http://127.0.0.1:${mapped}`);
    } finally {
      await flink.stop();
    }
  });

  it("without withTaskManager(), boots as a bare JobManager on any backend (including microsandbox)", async () => {
    const backend = new FakeMsbBackend();
    const flink = new FlinkContainer().withBackend(backend).waitingFor(instantReadyWait());
    await flink.start();
    try {
      assert.equal(flink.isRunning, true);
    } finally {
      await flink.stop();
    }
  });

  it("withTaskManager() on the microsandbox backend throws a typed UnsupportedByBackendError naming the real cause", async () => {
    const backend = new FakeMsbBackend();
    const flink = new FlinkContainer().withBackend(backend).waitingFor(instantReadyWait()).withTaskManager();
    let caught: unknown;
    try {
      await flink.start();
    } catch (err) {
      caught = err;
    } finally {
      // containerIsStarting() throws before anything was ever created (no
      // handle was assigned), so stop() here is a harmless no-op — kept for
      // symmetry with every other start()-then-cleanup call in this file.
      await flink.stop();
    }
    assert.ok(caught instanceof UnsupportedByBackendError, "expected UnsupportedByBackendError");
    const typed = caught as UnsupportedByBackendError;
    assert.equal(typed.feature, "Flink TaskManager registration");
    assert.equal(typed.backend, "microsandbox");
    assert.match(typed.message, /nc\/busybox/);
    assert.match(typed.message, /RIGHTSIZE_BACKEND=docker/);
  });

  it("withTaskManager() on microsandbox rejects before any create() call — no JobManager boot is ever attempted", async () => {
    const backend = new FakeMsbBackend();
    const flink = new FlinkContainer().withBackend(backend).waitingFor(instantReadyWait()).withTaskManager();
    await assert.rejects(() => flink.start());
    // The msb rejection fires from containerIsStarting(), the instant
    // start() resolves a backend — strictly before ensureNetwork, port
    // allocation, and this container's own create()/start(). lastSpec
    // staying undefined proves the fake backend's create() was never
    // reached, not merely that some later assertion happened not to run.
    assert.equal(backend.lastSpec, undefined);
    await flink.stop();
  });

  it("withTaskManager() on a non-microsandbox backend starts a second GenericContainer as taskmanager on a shared network", async () => {
    const backend = new FakeModuleBackend();
    const flink = new FlinkContainer().withBackend(backend).waitingFor(instantReadyWait()).withTaskManager();
    await flink.start();
    try {
      // Two creates were issued against the fake backend: the JobManager
      // (this container) and the TaskManager companion started from
      // containerIsStarted(). lastSpec reflects the most recent create,
      // which is the TaskManager's.
      assert.deepEqual(backend.lastSpec?.command, ["taskmanager"]);
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("FLINK_PROPERTIES"), "jobmanager.rpc.address: flink-jobmanager");
      assert.equal(backend.lastSpec?.memoryLimitMb, 1024);
    } finally {
      await flink.stop();
    }
  });

  it("accepts a custom image tag via the constructor", async () => {
    const backend = new FakeModuleBackend();
    const flink = new FlinkContainer("flink:1.20.5-scala_2.12").withBackend(backend).waitingFor(instantReadyWait());
    await flink.start();
    try {
      assert.equal(backend.lastSpec?.image, "flink:1.20.5-scala_2.12");
    } finally {
      await flink.stop();
    }
  });

  it("accepts a DockerImageName instance whose repository matches", async () => {
    const backend = new FakeModuleBackend();
    const image = DockerImageName.parse("flink:1.20.5-scala_2.12");
    const flink = new FlinkContainer(image).withBackend(backend).waitingFor(instantReadyWait());
    await flink.start();
    try {
      assert.equal(backend.lastSpec?.image, "flink:1.20.5-scala_2.12");
    } finally {
      await flink.stop();
    }
  });

  it("throws IncompatibleImageError before start() for a mismatched repository", () => {
    try {
      new FlinkContainer("mongo:latest");
      assert.ok(false, "expected the constructor to throw");
    } catch (err) {
      assert.ok(err instanceof IncompatibleImageError);
      assert.equal((err as IncompatibleImageError).suppliedRepository, "mongo");
      assert.equal((err as IncompatibleImageError).expectedRepository, "flink");
    }
  });

  it("accepts a mismatched image explicitly marked asCompatibleSubstituteFor('flink')", async () => {
    const backend = new FakeModuleBackend();
    const substitute = DockerImageName.parse("mycorp/flink-hardened:1.20").asCompatibleSubstituteFor("flink");
    const flink = new FlinkContainer(substitute).withBackend(backend).waitingFor(instantReadyWait());
    await flink.start();
    try {
      assert.equal(backend.lastSpec?.image, "mycorp/flink-hardened:1.20");
    } finally {
      await flink.stop();
    }
  });

  it("withTaskManager() companion resolves the substituted image, not the raw DockerImageName", async () => {
    const backend = new FakeModuleBackend();
    const substitute = DockerImageName.parse("mycorp/flink-hardened:1.20").asCompatibleSubstituteFor("flink");
    const flink = new FlinkContainer(substitute).withBackend(backend).waitingFor(instantReadyWait()).withTaskManager();
    await flink.start();
    try {
      // lastSpec reflects the TaskManager companion's create() call (the most
      // recent one) — proving containerIsStarted() constructs it from the
      // resolved raw image string, not from a DockerImageName instance.
      assert.equal(backend.lastSpec?.image, "mycorp/flink-hardened:1.20");
    } finally {
      await flink.stop();
    }
  });
});
