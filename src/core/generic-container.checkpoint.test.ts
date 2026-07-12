import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert } from "../../test/harness.js";
import { GenericContainer } from "./generic-container.js";
import { CheckpointUnsupportedError } from "./errors.js";
import type { WaitStrategy } from "./wait.js";
import type { BackendCapabilities, SandboxBackend, SandboxHandle, NetworkLink, ReaperKillCommand } from "./backend.js";
import type { ContainerSpec, ExecResult } from "./model.js";
import { registerBackend, Backends, _resetRegistryForTests, _providersSnapshotForTests } from "./backends.js";
import type { BackendProvider } from "./backend.js";
import { readSandboxNames } from "./reaper/ledger.js";

function instantReady(): WaitStrategy {
  return {
    waitUntilReady: async () => {},
    withStartupTimeout(): WaitStrategy {
      return this;
    },
  };
}

/** A minimal fake backend whose `capabilities.checkpoint` and `commitToImage` behavior are set by the test, recording every call it receives. */
class FakeCheckpointBackend implements SandboxBackend {
  readonly name: string;
  readonly supportsNativeNetworks = true;
  readonly capabilities: BackendCapabilities;
  readonly calls: string[] = [];
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
  async commitToImage(_handle: SandboxHandle, imageRef: string): Promise<void> {
    this.calls.push(`commitToImage:${imageRef}`);
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
  async installNetworkLinks(_handle: SandboxHandle, _links: ReadonlyArray<NetworkLink>): Promise<void> {}
  async close(): Promise<void> {}
  cleanupSync(): void {}
}

describe("GenericContainer.checkpoint()", () => {
  it("rejects with CheckpointUnsupportedError before any backend call when capabilities.checkpoint is false", async () => {
    const backend = new FakeCheckpointBackend("microsandbox", { hardwareIsolated: true, checkpoint: false });
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
    assert.equal((thrown as CheckpointUnsupportedError).backend, "microsandbox");
    assert.deepEqual(backend.calls, [], "commitToImage must never be called once capabilities.checkpoint is false");

    await container.stop();
  });

  it("names the active backend and the docker/roadmap remedy in the error message", async () => {
    const backend = new FakeCheckpointBackend("microsandbox", { hardwareIsolated: true, checkpoint: false });
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
    assert.match(message, /'microsandbox'/);
    assert.match(message, /docker/);
    assert.match(message, /roadmap/);

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
    const backend = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true });
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

  it("returns a Checkpoint carrying a rightsize/checkpoint:<12-hex> imageRef and the container's full spec", async () => {
    const backend = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true });
    const container = new GenericContainer("alpine:3.19")
      .withBackend(backend)
      .withEnv("FOO", "bar")
      .withCommand("sleep", "60")
      .withExposedPorts(80)
      .withMemoryLimit(256)
      .waitingFor(instantReady());
    await container.start();

    const cp = await container.checkpoint();

    assert.match(cp.imageRef, /^rightsize\/checkpoint:[0-9a-f]{12}$/);
    assert.equal(cp.spec.image, "alpine:3.19");
    assert.deepEqual(cp.spec.env, [["FOO", "bar"]]);
    assert.deepEqual(cp.spec.command, ["sleep", "60"]);
    assert.equal(cp.spec.memoryLimitMb, 256);
    assert.equal(cp.spec.ports.length, 1);
    assert.equal(cp.spec.ports[0]?.guestPort, 80);
    assert.deepEqual(backend.calls, ["create", "start", `commitToImage:${cp.imageRef}`]);

    await container.stop();
  });

  it("two checkpoints of the same running container mint two different imageRefs", async () => {
    const backend = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true });
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withCommand("sleep", "60").waitingFor(instantReady());
    await container.start();

    const first = await container.checkpoint();
    const second = await container.checkpoint();

    assert.ok(first.imageRef !== second.imageRef, "expected two checkpoints to mint distinct imageRefs");

    await container.stop();
  });
});

describe("GenericContainer.fromCheckpoint()", () => {
  it("builds a container whose image is cp.imageRef and whose env/command/ports/memory default from cp.spec", async () => {
    const backend = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true });
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

    assert.equal(backend.lastCreatedSpec()?.image, cp.imageRef);
    assert.deepEqual(backend.lastCreatedSpec()?.env, [["A", "1"]]);
    assert.deepEqual(backend.lastCreatedSpec()?.command, ["sleep", "60"]);
    assert.equal(backend.lastCreatedSpec()?.memoryLimitMb, 128);
    assert.equal(backend.lastCreatedSpec()?.ports.length, 1);
    assert.equal(backend.lastCreatedSpec()?.ports[0]?.guestPort, 80);

    await restored.stop();
  });

  it("allows the caller to override builder state after fromCheckpoint()", async () => {
    const backend = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true });
    const cp = {
      imageRef: "rightsize/checkpoint:abcdef012345",
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
      },
    };

    const restored = GenericContainer.fromCheckpoint(cp)
      .withBackend(backend)
      .withEnv("A", "overridden")
      .withCommand("sleep", "120")
      .waitingFor(instantReady());
    await restored.start();

    assert.equal(backend.lastCreatedSpec()?.image, cp.imageRef);
    assert.deepEqual(backend.lastCreatedSpec()?.env, [["A", "overridden"]]);
    assert.deepEqual(backend.lastCreatedSpec()?.command, ["sleep", "120"]);

    await restored.stop();
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

    const backend = new FakeCheckpointBackend("docker", { hardwareIsolated: false, checkpoint: true });
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
