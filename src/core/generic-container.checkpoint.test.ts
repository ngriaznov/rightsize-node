import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert } from "../../test/harness.js";
import { GenericContainer } from "./generic-container.js";
import { Network } from "./network.js";
import { CheckpointUnsupportedError, CheckpointBackendMismatchError, ReuseFromCheckpointError, InvalidCheckpointNameError } from "./errors.js";
import type { WaitStrategy, WaitTarget } from "./wait.js";
import type { BackendCapabilities, SandboxBackend, SandboxHandle, NetworkLink, ReaperKillCommand } from "./backend.js";
import type { ContainerSpec, ExecResult } from "./model.js";
import { registerBackend, Backends, _resetRegistryForTests, _providersSnapshotForTests } from "./backends.js";
import type { BackendProvider } from "./backend.js";
import { readSandboxNames } from "./reaper/ledger.js";
import { readCheckpointRegistry, listCheckpointNames } from "./checkpoint/registry.js";

function instantReady(): WaitStrategy {
  return {
    waitUntilReady: async () => {},
    withStartupTimeout(): WaitStrategy {
      return this;
    },
  };
}

/** Counts how many times `waitUntilReady` runs — proves (or disproves) the post-checkpoint re-wait `checkpointRestartsWorkload` gates. */
function countingWait(counter: { count: number }): WaitStrategy {
  return {
    waitUntilReady: async (_target: WaitTarget) => {
      counter.count += 1;
    },
    withStartupTimeout(): WaitStrategy {
      return this;
    },
  };
}

/** A minimal fake backend whose `capabilities` and `createCheckpoint` behavior are set by the test, recording every call it receives. */
class FakeCheckpointBackend implements SandboxBackend {
  readonly name: string;
  readonly supportsNativeNetworks = true;
  readonly capabilities: BackendCapabilities;
  readonly calls: string[] = [];
  /** Every `installNetworkLinks` call this backend received, in order — kept separate from `calls` so existing exact-call-sequence assertions are unaffected. */
  readonly linkCalls: Array<ReadonlyArray<NetworkLink>> = [];
  private idSeq = 0;
  private createdSpecs: ContainerSpec[] = [];

  constructor(name: string, capabilities: BackendCapabilities) {
    this.name = name;
    this.capabilities = capabilities;
  }

  /** The most recent spec passed to `create()` — lets a test inspect what `fromCheckpoint()`'s builder state actually produced. */
  lastCreatedSpec(): ContainerSpec | undefined {
    return this.createdSpecs.at(-1);
  }

  async create(spec: ContainerSpec): Promise<SandboxHandle> {
    this.calls.push("create");
    this.idSeq += 1;
    this.createdSpecs.push(spec);
    return { id: `fake-${this.idSeq}`, spec };
  }
  async start(): Promise<void> {
    this.calls.push("start");
  }
  async stop(): Promise<void> {
    this.calls.push("stop");
  }
  async remove(): Promise<void> {
    this.calls.push("remove");
  }
  /** Every ref this fake has ever "created" and not since removed — lets a test assert replace semantics (old ref cleared before the new one lands) without a real backend. */
  readonly artifacts = new Set<string>();
  /** Test seam: when set, the next `createCheckpoint` call rejects with this instead of succeeding. */
  failNextCreateCheckpoint: Error | undefined;

  async createCheckpoint(_handle: SandboxHandle, ref: string): Promise<void> {
    this.calls.push(`createCheckpoint:${ref}`);
    if (this.failNextCreateCheckpoint !== undefined) {
      const err = this.failNextCreateCheckpoint;
      this.failNextCreateCheckpoint = undefined;
      throw err;
    }
    this.artifacts.add(ref);
  }
  async removeCheckpoint(ref: string): Promise<void> {
    this.calls.push(`removeCheckpoint:${ref}`);
    this.artifacts.delete(ref);
  }
  async hasCheckpoint(ref: string): Promise<boolean> {
    this.calls.push(`hasCheckpoint:${ref}`);
    return this.artifacts.has(ref);
  }
  async removeByName(): Promise<void> {}
  async findRunning(): Promise<SandboxHandle | undefined> {
    return undefined;
  }
  async reaperKillCommand(): Promise<ReaperKillCommand> {
    return { stop: [], remove: [], removeNetwork: [] };
  }
  async exec(): Promise<ExecResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  async logs(): Promise<string> {
    return "";
  }
  async followLogs() {
    return { close: async (): Promise<void> => {} };
  }
  async ensureNetwork(): Promise<void> {}
  async removeNetwork(): Promise<void> {}
  async installNetworkLinks(_handle: SandboxHandle, links: ReadonlyArray<NetworkLink>): Promise<void> {
    this.linkCalls.push(links);
  }
  async copyToContainer(): Promise<void> {}
  async copyFromContainer(): Promise<void> {}
  async close(): Promise<void> {}
  cleanupSync(): void {}
}

describe("GenericContainer.checkpoint()", () => {
  it("rejects with CheckpointUnsupportedError before any backend call when capabilities.checkpoint is false", async () => {
    const backend = new FakeCheckpointBackend("fake-no-checkpoint", {
      hardwareIsolated: true,
      checkpoint: false,
      checkpointRestartsWorkload: false,
    });
    const container = new GenericContainer("alpine:3.19")
      .withBackend(backend)
      .withCommand("sleep", "60")
      .waitingFor(instantReady());
    await container.start();
    backend.calls.length = 0;

    let thrown: unknown;
    try {
      await container.checkpoint();
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof CheckpointUnsupportedError, `expected CheckpointUnsupportedError, got: ${String(thrown)}`);
    assert.equal((thrown as CheckpointUnsupportedError).backend, "fake-no-checkpoint");
    assert.deepEqual(backend.calls, [], "createCheckpoint must never be called once capabilities.checkpoint is false");

    await container.stop();
  });

  it("names the active backend and the capabilities.checkpoint requirement, without steering to any specific backend", async () => {
    const backend = new FakeCheckpointBackend("fake-no-checkpoint", {
      hardwareIsolated: true,
      checkpoint: false,
      checkpointRestartsWorkload: false,
    });
    const container = new GenericContainer("alpine:3.19")
      .withBackend(backend)
      .withCommand("sleep", "60")
      .waitingFor(instantReady());
    await container.start();

    let thrown: unknown;
    try {
      await container.checkpoint();
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof CheckpointUnsupportedError);
    const message = (thrown as CheckpointUnsupportedError).message;
    assert.match(message, /'fake-no-checkpoint'/);
    assert.match(message, /capabilities\.checkpoint/);

    await container.stop();
  });

  it("throws a state error on a container that never started", async () => {
    const container = new GenericContainer("alpine:3.19");
    let thrown: unknown;
    try {
      await container.checkpoint();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error);
    assert.match((thrown as Error).message, /not running/);
  });

  it("throws a state error on a container that has already been stopped", async () => {
    const backend = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true, checkpointRestartsWorkload: false });
    const container = new GenericContainer("alpine:3.19")
      .withBackend(backend)
      .withCommand("sleep", "60")
      .waitingFor(instantReady());
    await container.start();
    await container.stop();

    let thrown: unknown;
    try {
      await container.checkpoint();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error);
    assert.match((thrown as Error).message, /not running/);
  });

  it("returns a Checkpoint carrying a rightsize/checkpoint:<12-hex> ref, the creating backend's name, and the container's full spec", async () => {
    const backend = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true, checkpointRestartsWorkload: false });
    const container = new GenericContainer("alpine:3.19")
      .withBackend(backend)
      .withEnv("FOO", "bar")
      .withCommand("sleep", "60")
      .withExposedPorts(80)
      .withMemoryLimit(256)
      .waitingFor(instantReady());
    await container.start();

    const cp = await container.checkpoint();

    assert.match(cp.ref, /^rightsize\/checkpoint:[0-9a-f]{12}$/);
    assert.equal(cp.backend, "docker");
    assert.equal(cp.spec.image, "alpine:3.19");
    assert.deepEqual(cp.spec.env, [["FOO", "bar"]]);
    assert.deepEqual(cp.spec.command, ["sleep", "60"]);
    assert.equal(cp.spec.memoryLimitMb, 256);
    assert.equal(cp.spec.ports.length, 1);
    assert.equal(cp.spec.ports[0]?.guestPort, 80);
    assert.deepEqual(backend.calls, ["create", "start", `createCheckpoint:${cp.ref}`]);

    await container.stop();
  });

  it("mints a rz-ckpt-<12-hex> ref on a backend named 'microsandbox'", async () => {
    const backend = new FakeCheckpointBackend("microsandbox", {
      hardwareIsolated: true,
      checkpoint: true,
      checkpointRestartsWorkload: true,
    });
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withCommand("sleep", "60").waitingFor(instantReady());
    await container.start();

    const cp = await container.checkpoint();

    assert.match(cp.ref, /^rz-ckpt-[0-9a-f]{12}$/);
    assert.equal(cp.backend, "microsandbox");

    await container.stop();
  });

  it("two checkpoints of the same running container mint two different refs", async () => {
    const backend = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true, checkpointRestartsWorkload: false });
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withCommand("sleep", "60").waitingFor(instantReady());
    await container.start();

    const first = await container.checkpoint();
    const second = await container.checkpoint();

    assert.ok(first.ref !== second.ref, "expected two checkpoints to mint distinct refs");

    await container.stop();
  });

  it("re-runs the wait strategy after checkpoint() when capabilities.checkpointRestartsWorkload is true", async () => {
    const backend = new FakeCheckpointBackend("microsandbox", {
      hardwareIsolated: true,
      checkpoint: true,
      checkpointRestartsWorkload: true,
    });
    const counter = { count: 0 };
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withCommand("sleep", "60").waitingFor(countingWait(counter));
    await container.start();
    assert.equal(counter.count, 1, "expected one wait during start()");

    await container.checkpoint();

    assert.equal(counter.count, 2, "expected checkpoint() to have re-run the wait strategy once");

    await container.stop();
  });

  it("does NOT re-run the wait strategy after checkpoint() when capabilities.checkpointRestartsWorkload is false", async () => {
    const backend = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true, checkpointRestartsWorkload: false });
    const counter = { count: 0 };
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withCommand("sleep", "60").waitingFor(countingWait(counter));
    await container.start();
    assert.equal(counter.count, 1);

    await container.checkpoint();

    assert.equal(counter.count, 1, "docker's commit-to-image never disturbs the container, so no re-wait is needed");

    await container.stop();
  });

  it("leaves the reaper ledger untouched across the msb stop/snapshot/reboot checkpoint cycle", async () => {
    const savedProviders = _providersSnapshotForTests();
    const savedBackendEnv = process.env["RIGHTSIZE_BACKEND"];
    const savedReaperEnv = process.env["RIGHTSIZE_REAPER"];
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-checkpoint-ledger-untouched-test-"));
    process.env["RIGHTSIZE_CACHE_DIR"] = cacheDir;
    _resetRegistryForTests();
    Backends._resetActiveForTests();
    delete process.env["RIGHTSIZE_BACKEND"];
    process.env["RIGHTSIZE_REAPER"] = "sweep";

    // microsandbox, not docker: this is the backend whose createCheckpoint
    // actually runs a stop/snapshot/reboot cycle (see MsbCliBackend) rather
    // than a plain image commit, so this fake stands in for that same
    // shape via capabilities.checkpointRestartsWorkload — the ledger
    // assertion below is about GenericContainer's own bookkeeping, which
    // never calls trackSandbox/untrackSandbox from checkpoint() on either
    // backend.
    const backend = new FakeCheckpointBackend("microsandbox", {
      hardwareIsolated: true,
      checkpoint: true,
      checkpointRestartsWorkload: true,
    });
    const provider: BackendProvider = {
      name: "microsandbox",
      priority: 10,
      isSupported: () => true,
      unsupportedReason: () => "n/a",
      create: () => backend,
    };
    registerBackend(provider);

    try {
      const container = new GenericContainer("alpine:3.19").withCommand("sleep", "60").waitingFor(instantReady());
      await container.start();

      const runsDir = path.join(cacheDir, "runs");
      const entries = await fs.readdir(runsDir).catch(() => []);
      const jsonFile = entries.find((f) => f.endsWith(".json"));
      assert.ok(jsonFile !== undefined, "expected a run record to exist");
      if (jsonFile !== undefined) {
        const runId = jsonFile.slice(0, -".json".length);

        const before = await readSandboxNames(cacheDir, runId);
        assert.ok(before.length > 0, "expected the running container to already be tracked in the ledger");

        await container.checkpoint();

        const after = await readSandboxNames(cacheDir, runId);
        assert.deepEqual(
          after,
          before,
          "the stop/snapshot/reboot checkpoint cycle must never touch the reaper ledger — same sandbox name, still owned by this run",
        );
      }

      await container.stop();
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
      delete process.env["RIGHTSIZE_CACHE_DIR"];
      _resetRegistryForTests();
      for (const p of savedProviders) {
        registerBackend(p);
      }
      Backends._resetActiveForTests();
      if (savedBackendEnv === undefined) {
        delete process.env["RIGHTSIZE_BACKEND"];
      } else {
        process.env["RIGHTSIZE_BACKEND"] = savedBackendEnv;
      }
      if (savedReaperEnv === undefined) {
        delete process.env["RIGHTSIZE_REAPER"];
      } else {
        process.env["RIGHTSIZE_REAPER"] = savedReaperEnv;
      }
    }
  });
});

/** Runs `fn` with `RIGHTSIZE_CACHE_DIR` pointed at a fresh temp directory, then removes it and restores the prior env value regardless of outcome. */
async function withTempCacheDirEnv(fn: (cacheDirPath: string) => Promise<void>): Promise<void> {
  const cacheDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-named-checkpoint-test-"));
  const saved = process.env["RIGHTSIZE_CACHE_DIR"];
  process.env["RIGHTSIZE_CACHE_DIR"] = cacheDirPath;
  try {
    await fn(cacheDirPath);
  } finally {
    if (saved === undefined) {
      delete process.env["RIGHTSIZE_CACHE_DIR"];
    } else {
      process.env["RIGHTSIZE_CACHE_DIR"] = saved;
    }
    await fs.rm(cacheDirPath, { recursive: true, force: true });
  }
}

describe("GenericContainer.checkpoint(name) — named checkpoints", () => {
  it("rejects with InvalidCheckpointNameError before any backend call for a name that fails the pattern", async () => {
    const backend = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true, checkpointRestartsWorkload: false });
    const container = new GenericContainer("alpine:3.19")
      .withBackend(backend)
      .withCommand("sleep", "60")
      .waitingFor(instantReady());
    await container.start();
    backend.calls.length = 0;

    let thrown: unknown;
    try {
      await container.checkpoint("Bad_Name");
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof InvalidCheckpointNameError, `expected InvalidCheckpointNameError, got: ${String(thrown)}`);
    assert.equal((thrown as InvalidCheckpointNameError).checkpointName, "Bad_Name");
    assert.deepEqual(backend.calls, [], "no backend call must have been made before the name was validated");

    await container.stop();
  });

  it("mints a deterministic ref from the name: rightsize/checkpoint:<name> on docker, rz-ckpt-<name> on microsandbox", async () => {
    // A named checkpoint also writes a registry entry, so this test must run against a
    // temp cache dir like the other named-checkpoint tests — never the real one.
    await withTempCacheDirEnv(async () => {
      const docker = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true, checkpointRestartsWorkload: false });
      const dockerContainer = new GenericContainer("alpine:3.19").withBackend(docker).withCommand("sleep", "60").waitingFor(instantReady());
      await dockerContainer.start();
      const dockerCp = await dockerContainer.checkpoint("seeded-db");
      assert.equal(dockerCp.ref, "rightsize/checkpoint:seeded-db");
      await dockerContainer.stop();

      const msb = new FakeCheckpointBackend("microsandbox", { hardwareIsolated: true, checkpoint: true, checkpointRestartsWorkload: true });
      const msbContainer = new GenericContainer("alpine:3.19").withBackend(msb).withCommand("sleep", "60").waitingFor(instantReady());
      await msbContainer.start();
      const msbCp = await msbContainer.checkpoint("seeded-db");
      assert.equal(msbCp.ref, "rz-ckpt-seeded-db");
      await msbContainer.stop();
    });
  });

  it("writes the pinned registry JSON — exact field names, only after the backend checkpoint succeeded", async () => {
    await withTempCacheDirEnv(async (cacheDirPath) => {
      const backend = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true, checkpointRestartsWorkload: false });
      const container = new GenericContainer("alpine:3.19")
        .withBackend(backend)
        .withEnv("A", "1")
        .withCommand("sleep", "60")
        .withExposedPorts(80)
        .withMemoryLimit(256)
        .waitingFor(instantReady());
      await container.start();

      const cp = await container.checkpoint("seeded-db");
      assert.equal(cp.ref, "rightsize/checkpoint:seeded-db");

      const read = await readCheckpointRegistry(cacheDirPath, "seeded-db");
      assert.equal(read.kind, "found");
      if (read.kind === "found") {
        assert.deepEqual(Object.keys(read.entry).sort(), ["backend", "createdIso", "name", "ref", "spec"]);
        assert.deepEqual(Object.keys(read.entry.spec).sort(), ["command", "env", "exposedPorts", "memoryLimitMb"]);
        assert.equal(read.entry.name, "seeded-db");
        assert.equal(read.entry.ref, cp.ref);
        assert.equal(read.entry.backend, "docker");
        assert.deepEqual(read.entry.spec, { env: { A: "1" }, command: ["sleep", "60"], exposedPorts: [80], memoryLimitMb: 256 });
      }

      await container.stop();
    });
  });

  it("a failed backend checkpoint never writes a registry entry", async () => {
    await withTempCacheDirEnv(async (cacheDirPath) => {
      const backend = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true, checkpointRestartsWorkload: false });
      backend.failNextCreateCheckpoint = new Error("commit failed");
      const container = new GenericContainer("alpine:3.19").withBackend(backend).withCommand("sleep", "60").waitingFor(instantReady());
      await container.start();

      let thrown: unknown;
      try {
        await container.checkpoint("seeded-db");
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof Error, `expected the backend failure to propagate, got: ${String(thrown)}`);
      assert.match((thrown as Error).message, /commit failed/);

      const read = await readCheckpointRegistry(cacheDirPath, "seeded-db");
      assert.equal(read.kind, "missing", "expected no registry entry after a failed backend checkpoint");

      await container.stop();
    });
  });

  it("an unnamed checkpoint() writes no registry entry at all", async () => {
    await withTempCacheDirEnv(async (cacheDirPath) => {
      const backend = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true, checkpointRestartsWorkload: false });
      const container = new GenericContainer("alpine:3.19").withBackend(backend).withCommand("sleep", "60").waitingFor(instantReady());
      await container.start();

      const cp = await container.checkpoint();
      assert.match(cp.ref, /^rightsize\/checkpoint:[0-9a-f]{12}$/);

      const names = await listCheckpointNames(cacheDirPath);
      assert.deepEqual(names, [], "expected an unnamed checkpoint to never write a registry entry");

      await container.stop();
    });
  });

  it("re-checkpointing the same name replaces it: removeCheckpoint(ref) runs before createCheckpoint, and the registry holds the latest", async () => {
    await withTempCacheDirEnv(async (cacheDirPath) => {
      const backend = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true, checkpointRestartsWorkload: false });
      const container = new GenericContainer("alpine:3.19").withBackend(backend).withCommand("sleep", "60").waitingFor(instantReady());
      await container.start();

      const first = await container.checkpoint("seeded-db");
      backend.calls.length = 0;

      const second = await container.checkpoint("seeded-db");
      assert.equal(second.ref, first.ref, "expected the ref to be the same deterministic value both times");
      assert.deepEqual(backend.calls, [`removeCheckpoint:${first.ref}`, `createCheckpoint:${first.ref}`]);

      const read = await readCheckpointRegistry(cacheDirPath, "seeded-db");
      assert.equal(read.kind, "found");
      if (read.kind === "found") {
        assert.equal(read.entry.ref, first.ref);
      }

      await container.stop();
    });
  });
});

describe("GenericContainer.fromCheckpoint()", () => {
  it("builds a container whose image is cp.ref and whose env/command/ports/memory default from cp.spec", async () => {
    const backend = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true, checkpointRestartsWorkload: false });
    const source = new GenericContainer("alpine:3.19")
      .withBackend(backend)
      .withEnv("A", "1")
      .withCommand("sleep", "60")
      .withExposedPorts(80)
      .withMemoryLimit(128)
      .waitingFor(instantReady());
    await source.start();
    const cp = await source.checkpoint();
    await source.stop();

    const restored = GenericContainer.fromCheckpoint(cp).withBackend(backend).waitingFor(instantReady());
    await restored.start();

    assert.equal(backend.lastCreatedSpec()?.image, cp.ref);
    assert.deepEqual(backend.lastCreatedSpec()?.env, [["A", "1"]]);
    assert.deepEqual(backend.lastCreatedSpec()?.command, ["sleep", "60"]);
    assert.equal(backend.lastCreatedSpec()?.memoryLimitMb, 128);
    assert.equal(backend.lastCreatedSpec()?.ports.length, 1);
    assert.equal(backend.lastCreatedSpec()?.ports[0]?.guestPort, 80);
    assert.equal(backend.lastCreatedSpec()?.checkpointRef, cp.ref, "expected checkpointRef to be threaded onto the built spec");

    await restored.stop();
  });

  it("allows the caller to override builder state after fromCheckpoint()", async () => {
    const backend = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true, checkpointRestartsWorkload: false });
    const cp = {
      ref: "rightsize/checkpoint:abcdef012345",
      backend: "docker",
      spec: {
        name: "rz-source-1",
        image: "alpine:3.19",
        env: [["A", "1"] as const],
        command: ["sleep", "60"],
        ports: [],
        mounts: [],
        networkId: undefined,
        aliases: [],
        runId: "deadbeef",
        memoryLimitMb: undefined,
        keepAlive: false,
        checkpointRef: "rightsize/checkpoint:abcdef012345",
      },
    };

    const restored = GenericContainer.fromCheckpoint(cp)
      .withBackend(backend)
      .withEnv("A", "overridden")
      .withCommand("sleep", "120")
      .waitingFor(instantReady());
    await restored.start();

    assert.equal(backend.lastCreatedSpec()?.image, cp.ref);
    assert.deepEqual(backend.lastCreatedSpec()?.env, [["A", "overridden"]]);
    assert.deepEqual(backend.lastCreatedSpec()?.command, ["sleep", "120"]);

    await restored.stop();
  });

  it("throws CheckpointBackendMismatchError before any backend call when the active backend differs from the checkpoint's creator", async () => {
    const creator = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true, checkpointRestartsWorkload: false });
    const source = new GenericContainer("alpine:3.19").withBackend(creator).withCommand("sleep", "60").waitingFor(instantReady());
    await source.start();
    const cp = await source.checkpoint();
    await source.stop();

    const differentBackend = new FakeCheckpointBackend("microsandbox", {
      hardwareIsolated: true,
      checkpoint: true,
      checkpointRestartsWorkload: true,
    });
    const restored = GenericContainer.fromCheckpoint(cp).withBackend(differentBackend).waitingFor(instantReady());

    let thrown: unknown;
    try {
      await restored.start();
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof CheckpointBackendMismatchError, `expected CheckpointBackendMismatchError, got: ${String(thrown)}`);
    assert.equal((thrown as CheckpointBackendMismatchError).createdOnBackend, "docker");
    assert.equal((thrown as CheckpointBackendMismatchError).activeBackend, "microsandbox");
    assert.deepEqual(differentBackend.calls, [], "no backend call must have been made before the mismatch was detected");
  });

  it("throws ReuseFromCheckpointError before any backend call when a restored container is also marked withReuse()", async () => {
    const savedReuseEnv = process.env["RIGHTSIZE_REUSE"];
    process.env["RIGHTSIZE_REUSE"] = "true";
    try {
      const backend = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true, checkpointRestartsWorkload: false });
      const source = new GenericContainer("alpine:3.19").withBackend(backend).withCommand("sleep", "60").waitingFor(instantReady());
      await source.start();
      const cp = await source.checkpoint();
      await source.stop();
      backend.calls.length = 0;

      const restored = GenericContainer.fromCheckpoint(cp).withBackend(backend).withReuse().waitingFor(instantReady());

      let thrown: unknown;
      try {
        await restored.start();
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof ReuseFromCheckpointError, `expected ReuseFromCheckpointError, got: ${String(thrown)}`);
      assert.deepEqual(backend.calls, [], "no backend call must have been made before the conflict was detected");
    } finally {
      if (savedReuseEnv === undefined) {
        delete process.env["RIGHTSIZE_REUSE"];
      } else {
        process.env["RIGHTSIZE_REUSE"] = savedReuseEnv;
      }
    }
  });

  it("a restored container is ordinary in every respect: fresh host ports, normal reaping ledger, normal stop", async () => {
    const savedProviders = _providersSnapshotForTests();
    const savedBackendEnv = process.env["RIGHTSIZE_BACKEND"];
    const savedReaperEnv = process.env["RIGHTSIZE_REAPER"];
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-checkpoint-ledger-test-"));
    process.env["RIGHTSIZE_CACHE_DIR"] = cacheDir;
    _resetRegistryForTests();
    Backends._resetActiveForTests();
    delete process.env["RIGHTSIZE_BACKEND"];
    process.env["RIGHTSIZE_REAPER"] = "sweep";

    const backend = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true, checkpointRestartsWorkload: false });
    const provider: BackendProvider = {
      name: "docker",
      priority: 10,
      isSupported: () => true,
      unsupportedReason: () => "n/a",
      create: () => backend,
    };
    registerBackend(provider);

    try {
      const source = new GenericContainer("alpine:3.19").withCommand("sleep", "60").waitingFor(instantReady());
      await source.start();
      const cp = await source.checkpoint();

      // source stays running while restored boots — the ledger's own
      // run-record-cleanup rule (pruned once BOTH .sandboxes and .networks
      // go empty) is orthogonal to this assertion and exercised elsewhere;
      // keeping source up avoids that transient empty-ledger window here.
      const restored = GenericContainer.fromCheckpoint(cp).waitingFor(instantReady());
      await restored.start();
      try {
        assert.equal(restored.isRunning, true);
        // Ordinary reaping: the restored container's own name shows up in
        // this run's .sandboxes ledger, exactly like any other container
        // started against Backends.active() — never the reuse/checkpoint
        // special-cased path.
        const runsDir = path.join(cacheDir, "runs");
        const entries = await fs.readdir(runsDir).catch(() => []);
        const jsonFile = entries.find((f) => f.endsWith(".json"));
        assert.ok(jsonFile !== undefined, "expected a run record to exist");
        if (jsonFile !== undefined) {
          const runId = jsonFile.slice(0, -".json".length);
          const names = await readSandboxNames(cacheDir, runId);
          const restoredHandle = backend.lastCreatedSpec();
          assert.ok(restoredHandle !== undefined);
          assert.ok(names.includes(restoredHandle?.name ?? ""), `expected ${restoredHandle?.name} in .sandboxes, got: ${JSON.stringify(names)}`);
        }
      } finally {
        await restored.stop();
        await source.stop();
      }
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
      delete process.env["RIGHTSIZE_CACHE_DIR"];
      _resetRegistryForTests();
      for (const p of savedProviders) {
        registerBackend(p);
      }
      Backends._resetActiveForTests();
      if (savedBackendEnv === undefined) {
        delete process.env["RIGHTSIZE_BACKEND"];
      } else {
        process.env["RIGHTSIZE_BACKEND"] = savedBackendEnv;
      }
      if (savedReaperEnv === undefined) {
        delete process.env["RIGHTSIZE_REAPER"];
      } else {
        process.env["RIGHTSIZE_REAPER"] = savedReaperEnv;
      }
    }
  });
});

describe("GenericContainer.checkpoint() — network links across a workload-restarting checkpoint", () => {
  it("re-installs a networked container's links after checkpoint() when checkpointRestartsWorkload is true", async () => {
    const backend = new FakeCheckpointBackend("microsandbox", {
      hardwareIsolated: true,
      checkpoint: true,
      checkpointRestartsWorkload: true,
    });
    const net = Network.newNetwork();

    const sibling = new GenericContainer("redis:8.6-alpine")
      .withBackend(backend)
      .withExposedPorts(6379)
      .withNetwork(net)
      .withNetworkAliases("redis")
      .waitingFor(instantReady());
    await sibling.start();

    const container = new GenericContainer("consumer:latest")
      .withBackend(backend)
      .withNetwork(net)
      .withNetworkAliases("consumer")
      .waitingFor(instantReady());
    await container.start();

    assert.equal(
      backend.linkCalls.length,
      2,
      "expected one installNetworkLinks call per start() — sibling's own (empty) and container's (one link)",
    );
    const linksAtStart = backend.linkCalls[1];
    assert.equal(linksAtStart?.length, 1);
    assert.equal(linksAtStart?.[0]?.alias, "redis");

    await container.checkpoint();

    assert.equal(
      backend.linkCalls.length,
      3,
      "expected checkpoint() to have re-run installNetworkLinks exactly once, before the wait-strategy re-run",
    );
    assert.deepEqual(
      backend.linkCalls[2],
      linksAtStart,
      "expected the exact same links from start() to be reinstalled after the workload reboot",
    );

    await container.stop();
    await sibling.stop();
  });

  it("does NOT reinstall network links after checkpoint() when checkpointRestartsWorkload is false", async () => {
    const backend = new FakeCheckpointBackend("docker", {
      hardwareIsolated: false,
      checkpoint: true,
      checkpointRestartsWorkload: false,
    });
    const net = Network.newNetwork();

    const sibling = new GenericContainer("redis:8.6-alpine")
      .withBackend(backend)
      .withExposedPorts(6379)
      .withNetwork(net)
      .withNetworkAliases("redis")
      .waitingFor(instantReady());
    await sibling.start();

    const container = new GenericContainer("consumer:latest")
      .withBackend(backend)
      .withNetwork(net)
      .withNetworkAliases("consumer")
      .waitingFor(instantReady());
    await container.start();

    const callsAtStart = backend.linkCalls.length;
    assert.equal(callsAtStart, 2);

    await container.checkpoint();

    assert.equal(
      backend.linkCalls.length,
      callsAtStart,
      "docker's commit-to-image never disturbs the running container, so links must not be reinstalled",
    );

    await container.stop();
    await sibling.stop();
  });
});
