import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert, beforeEach, afterEach } from "../../test/harness.js";
import { GenericContainer } from "./generic-container.js";
import { Network } from "./network.js";
import { ReuseWithNetworkError, PortBindConflictError } from "./errors.js";
import type { WaitStrategy } from "./wait.js";
import type { SandboxBackend, SandboxHandle, NetworkLink, ReaperKillCommand } from "./backend.js";
import type { ContainerSpec, ExecResult } from "./model.js";
import { reuseHash, reuseName } from "./reuse/hash.js";
import { readRegistry, writeRegistryAtomic, type ReuseRegistryEntry } from "./reuse/registry.js";
import { registerBackend, Backends, _resetRegistryForTests, _providersSnapshotForTests } from "./backends.js";
import { readSandboxNames } from "./reaper/ledger.js";
import type { BackendProvider } from "./backend.js";

function instantReady(): WaitStrategy {
  return {
    waitUntilReady: async () => {},
    withStartupTimeout(): WaitStrategy {
      return this;
    },
  };
}

function failingWaitStrategy(): WaitStrategy {
  return {
    waitUntilReady: async () => {
      throw new Error("boom: wait strategy failed");
    },
    withStartupTimeout(): WaitStrategy {
      return this;
    },
  };
}

interface FakeReuseBackendOptions {
  createImpl?: (spec: ContainerSpec) => Promise<SandboxHandle>;
  findRunningImpl?: (spec: ContainerSpec) => Promise<SandboxHandle | undefined>;
  startFailuresBeforeSuccess?: number;
  startFailureIsPortConflict?: boolean;
}

class FakeReuseBackend implements SandboxBackend {
  readonly name = "fake-reuse";
  readonly supportsNativeNetworks = true;
  readonly capabilities = { hardwareIsolated: true, checkpoint: false, checkpointRestartsWorkload: false };
  readonly calls: string[] = [];
  readonly createdHandles: SandboxHandle[] = [];
  private idSeq = 0;
  private startAttempts = 0;

  constructor(private readonly opts: FakeReuseBackendOptions = {}) {}

  async create(spec: ContainerSpec): Promise<SandboxHandle> {
    this.calls.push("create");
    if (this.opts.createImpl !== undefined) {
      const handle = await this.opts.createImpl(spec);
      this.createdHandles.push(handle);
      return handle;
    }
    this.idSeq += 1;
    const handle: SandboxHandle = { id: `fake-${this.idSeq}`, spec };
    this.createdHandles.push(handle);
    return handle;
  }

  async start(_handle: SandboxHandle): Promise<void> {
    this.calls.push("start");
    const failuresBeforeSuccess = this.opts.startFailuresBeforeSuccess ?? 0;
    this.startAttempts += 1;
    if (this.startAttempts <= failuresBeforeSuccess) {
      if (this.opts.startFailureIsPortConflict ?? true) {
        throw new PortBindConflictError("address already in use");
      }
      throw new Error("boom: unrelated start failure");
    }
  }

  async stop(_handle: SandboxHandle): Promise<void> {
    this.calls.push("stop");
  }

  async remove(_handle: SandboxHandle): Promise<void> {
    this.calls.push("remove");
  }

  async createCheckpoint(_handle: SandboxHandle, _ref: string): Promise<void> {}
  async removeCheckpoint(): Promise<void> {}
  async hasCheckpoint(): Promise<boolean> {
    return false;
  }
  async exportCheckpoint(): Promise<void> {}
  async importCheckpoint(): Promise<string> {
    return "";
  }

  async removeByName(name: string): Promise<void> {
    this.calls.push(`removeByName:${name}`);
  }

  async findRunning(spec: ContainerSpec): Promise<SandboxHandle | undefined> {
    this.calls.push("findRunning");
    if (this.opts.findRunningImpl !== undefined) {
      return this.opts.findRunningImpl(spec);
    }
    return undefined;
  }

  async reaperKillCommand(): Promise<ReaperKillCommand> {
    return { stop: [], remove: [], removeNetwork: [] };
  }

  async exec(_handle: SandboxHandle, _cmd: ReadonlyArray<string>): Promise<ExecResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async logs(_handle: SandboxHandle): Promise<string> {
    return "";
  }

  async followLogs(): Promise<import("./backend.js").FollowHandle> {
    return { close: async () => {} };
  }

  async ensureNetwork(_networkId: string): Promise<void> {}
  async removeNetwork(_networkId: string): Promise<void> {}
  async installNetworkLinks(_handle: SandboxHandle, _links: ReadonlyArray<NetworkLink>): Promise<void> {}
  async copyToContainer(_handle: SandboxHandle, _hostPath: string, _containerPath: string): Promise<void> {}
  async copyFromContainer(_handle: SandboxHandle, _containerPath: string, _hostPath: string): Promise<void> {}
  async close(): Promise<void> {}
  cleanupSync(_id: string): void {}
}

async function expectedReuseName(overrides: {
  image?: string;
  env?: ReadonlyArray<readonly [string, string]>;
  command?: ReadonlyArray<string>;
  exposedPorts?: ReadonlyArray<number>;
  memoryLimitMb?: number;
} = {}): Promise<string> {
  const hash = await reuseHash({
    image: overrides.image ?? "redis:8.6-alpine",
    env: overrides.env ?? [],
    command: overrides.command,
    exposedPorts: overrides.exposedPorts ?? [6379],
    memoryLimitMb: overrides.memoryLimitMb,
    copies: [],
  });
  return reuseName(hash);
}

describe("GenericContainer — reuse double opt-in gating", () => {
  let cacheDir: string;
  const savedReuseEnv = process.env["RIGHTSIZE_REUSE"];

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-reuse-gating-test-"));
    process.env["RIGHTSIZE_CACHE_DIR"] = cacheDir;
  });

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
    delete process.env["RIGHTSIZE_CACHE_DIR"];
    if (savedReuseEnv === undefined) {
      delete process.env["RIGHTSIZE_REUSE"];
    } else {
      process.env["RIGHTSIZE_REUSE"] = savedReuseEnv;
    }
  });

  it("neither withReuse() nor RIGHTSIZE_REUSE: an ordinary ephemeral container, untouched by reuse machinery", async () => {
    delete process.env["RIGHTSIZE_REUSE"];
    const backend = new FakeReuseBackend();
    const container = new GenericContainer("redis:8.6-alpine").withBackend(backend).withExposedPorts(6379).waitingFor(instantReady());
    await container.start();

    assert.deepEqual(backend.calls, ["create", "start"]);
    const spec = backend.createdHandles[0]?.spec;
    assert.equal(spec?.keepAlive, false);
    assert.ok(!(spec?.name.startsWith("rz-reuse-") ?? true));
    await container.stop();
  });

  it("RIGHTSIZE_REUSE=true alone (no withReuse()): still an ordinary ephemeral container", async () => {
    process.env["RIGHTSIZE_REUSE"] = "true";
    const backend = new FakeReuseBackend();
    const container = new GenericContainer("redis:8.6-alpine").withBackend(backend).withExposedPorts(6379).waitingFor(instantReady());
    await container.start();

    assert.deepEqual(backend.calls, ["create", "start"]);
    const spec = backend.createdHandles[0]?.spec;
    assert.equal(spec?.keepAlive, false);
    await container.stop();
  });

  it("withReuse() alone (RIGHTSIZE_REUSE unset): ordinary ephemeral container, plus a one-time stderr note", async () => {
    delete process.env["RIGHTSIZE_REUSE"];
    const backend = new FakeReuseBackend();
    const written: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      written.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      const container = new GenericContainer("redis:8.6-alpine")
        .withBackend(backend)
        .withReuse()
        .withExposedPorts(6379)
        .waitingFor(instantReady());
      await container.start();

      assert.deepEqual(backend.calls, ["create", "start"]);
      const spec = backend.createdHandles[0]?.spec;
      assert.equal(spec?.keepAlive, false);
      assert.ok(!(spec?.name.startsWith("rz-reuse-") ?? true));
      assert.ok(
        written.some((line) => line.includes("RIGHTSIZE_REUSE") || line.includes("reuse")),
        `expected a stderr note about reuse being requested but not enabled, got: ${JSON.stringify(written)}`,
      );
      await container.stop();
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it("withReuse() + RIGHTSIZE_REUSE=true: reuse is active — reuse name, keepAlive true, registry written", async () => {
    process.env["RIGHTSIZE_REUSE"] = "true";
    const backend = new FakeReuseBackend();
    const container = new GenericContainer("redis:8.6-alpine")
      .withBackend(backend)
      .withReuse()
      .withExposedPorts(6379)
      .waitingFor(instantReady());
    await container.start();

    const expectedName = await expectedReuseName();
    const spec = backend.createdHandles[0]?.spec;
    assert.equal(spec?.name, expectedName);
    assert.equal(spec?.keepAlive, true);

    const hash = await reuseHash({
      image: "redis:8.6-alpine",
      env: [],
      command: undefined,
      exposedPorts: [6379],
      memoryLimitMb: undefined,
      copies: [],
    });
    const found = await readRegistry(cacheDir, hash);
    assert.equal(found.kind, "found");
    if (found.kind === "found") {
      assert.equal(found.entry.name, expectedName);
      assert.equal(found.entry.image, "redis:8.6-alpine");
      assert.equal(found.entry.backend, "fake-reuse");
      assert.equal(found.entry.ports["6379"], container.getMappedPort(6379));
    }
    await container.stop();
  });
});

describe("GenericContainer — reuse adopt path", () => {
  let cacheDir: string;
  const savedReuseEnv = process.env["RIGHTSIZE_REUSE"];

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-reuse-adopt-test-"));
    process.env["RIGHTSIZE_CACHE_DIR"] = cacheDir;
    process.env["RIGHTSIZE_REUSE"] = "true";
  });

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
    delete process.env["RIGHTSIZE_CACHE_DIR"];
    if (savedReuseEnv === undefined) {
      delete process.env["RIGHTSIZE_REUSE"];
    } else {
      process.env["RIGHTSIZE_REUSE"] = savedReuseEnv;
    }
  });

  async function seedRegistry(hostPort: number): Promise<{ hash: string; name: string }> {
    const hash = await reuseHash({
      image: "redis:8.6-alpine",
      env: [],
      command: undefined,
      exposedPorts: [6379],
      memoryLimitMb: undefined,
      copies: [],
    });
    const name = reuseName(hash);
    const entry: ReuseRegistryEntry = {
      name,
      image: "redis:8.6-alpine",
      ports: { "6379": hostPort },
      createdIso: new Date().toISOString(),
      backend: "fake-reuse",
    };
    await writeRegistryAtomic(cacheDir, hash, entry);
    return { hash, name };
  }

  it("registry hit + running + wait ok: adopts — no create() call, registry's ports used", async () => {
    const { name } = await seedRegistry(54321);
    const backend = new FakeReuseBackend({
      findRunningImpl: async (spec) => (spec.name === name ? { id: name, spec } : undefined),
    });
    const container = new GenericContainer("redis:8.6-alpine")
      .withBackend(backend)
      .withReuse()
      .withExposedPorts(6379)
      .waitingFor(instantReady());
    await container.start();

    assert.ok(!backend.calls.includes("create"), `expected no create() call on adopt, got calls: ${JSON.stringify(backend.calls)}`);
    assert.equal(container.getMappedPort(6379), 54321);
    assert.equal(container.isRunning, true);
    await container.stop();
  });

  it("stale registry (backend reports not running): best-effort cleanup, fresh create, registry rewritten", async () => {
    const { hash, name } = await seedRegistry(11111);
    const backend = new FakeReuseBackend({
      findRunningImpl: async () => undefined, // never running
    });
    const container = new GenericContainer("redis:8.6-alpine")
      .withBackend(backend)
      .withReuse()
      .withExposedPorts(6379)
      .waitingFor(instantReady());
    await container.start();

    assert.ok(backend.calls.includes(`removeByName:${name}`), `expected a best-effort removeByName(${name}) call, got: ${JSON.stringify(backend.calls)}`);
    assert.ok(backend.calls.includes("create"), "expected a fresh create() after the stale registry fallback");

    const rewritten = await readRegistry(cacheDir, hash);
    assert.equal(rewritten.kind, "found");
    if (rewritten.kind === "found") {
      assert.equal(rewritten.entry.ports["6379"], container.getMappedPort(6379));
      assert.ok(rewritten.entry.ports["6379"] !== 11111, "expected the stale port to have been replaced by a freshly-allocated one");
    }
    await container.stop();
  });

  it("registry hit + running, but the re-run wait strategy fails: treated as stale — cleanup, fresh create", async () => {
    const { name } = await seedRegistry(22222);
    let findRunningCalls = 0;
    const backend = new FakeReuseBackend({
      findRunningImpl: async (spec) => {
        findRunningCalls += 1;
        return spec.name === name ? { id: name, spec } : undefined;
      },
    });
    // The first wait (adopt verification) fails; a second container instance
    // is unnecessary here — GenericContainer only ever runs ONE wait
    // strategy per start(), so we make it fail on adopt and rely on the
    // fresh-create path succeeding via instantReady's own semantics: since
    // the same waitingFor() strategy is reused for the fresh-create attempt
    // too, use a strategy that fails only the first time it's invoked.
    let waitCalls = 0;
    const flakyWait: WaitStrategy = {
      waitUntilReady: async () => {
        waitCalls += 1;
        if (waitCalls === 1) {
          throw new Error("boom: adopt verification wait failed");
        }
      },
      withStartupTimeout(): WaitStrategy {
        return this;
      },
    };
    const container = new GenericContainer("redis:8.6-alpine")
      .withBackend(backend)
      .withReuse()
      .withExposedPorts(6379)
      .waitingFor(flakyWait);
    await container.start();

    assert.ok(findRunningCalls >= 1);
    assert.ok(backend.calls.includes(`removeByName:${name}`));
    assert.ok(backend.calls.includes("create"));
    assert.equal(waitCalls, 2, "expected the failed adopt-verification wait plus the fresh-create wait");
    await container.stop();
  });

  it("corrupted registry JSON: best-effort cleanup by the deterministic name, then fresh create", async () => {
    const hash = await reuseHash({
      image: "redis:8.6-alpine",
      env: [],
      command: undefined,
      exposedPorts: [6379],
      memoryLimitMb: undefined,
      copies: [],
    });
    const name = reuseName(hash);
    const dir = path.join(cacheDir, "reuse");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${hash}.json`), "{ not json at all");

    const backend = new FakeReuseBackend();
    const container = new GenericContainer("redis:8.6-alpine")
      .withBackend(backend)
      .withReuse()
      .withExposedPorts(6379)
      .waitingFor(instantReady());
    await container.start();

    assert.ok(backend.calls.includes(`removeByName:${name}`), `expected best-effort cleanup for the deterministic name, got: ${JSON.stringify(backend.calls)}`);
    assert.ok(backend.calls.includes("create"));
    assert.ok(!backend.calls.includes("findRunning"), "a corrupt registry never had a chance to be verified running");

    const rewritten = await readRegistry(cacheDir, hash);
    assert.equal(rewritten.kind, "found");
    await container.stop();
  });
});

describe("GenericContainer — reuse fresh-create orphan recovery", () => {
  let cacheDir: string;
  const savedReuseEnv = process.env["RIGHTSIZE_REUSE"];

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-reuse-orphan-test-"));
    process.env["RIGHTSIZE_CACHE_DIR"] = cacheDir;
    process.env["RIGHTSIZE_REUSE"] = "true";
  });

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
    delete process.env["RIGHTSIZE_CACHE_DIR"];
    if (savedReuseEnv === undefined) {
      delete process.env["RIGHTSIZE_REUSE"];
    } else {
      process.env["RIGHTSIZE_REUSE"] = savedReuseEnv;
    }
  });

  async function seedRegistry(hostPort: number): Promise<{ hash: string; name: string }> {
    const hash = await reuseHash({
      image: "redis:8.6-alpine",
      env: [],
      command: undefined,
      exposedPorts: [6379],
      memoryLimitMb: undefined,
      copies: [],
    });
    const name = reuseName(hash);
    const entry: ReuseRegistryEntry = {
      name,
      image: "redis:8.6-alpine",
      ports: { "6379": hostPort },
      createdIso: new Date().toISOString(),
      backend: "fake-reuse",
    };
    await writeRegistryAtomic(cacheDir, hash, entry);
    return { hash, name };
  }

  // The demonstrated defect this guards against: a reuse registry entry is
  // only written AFTER a fresh-created sandbox passes its OWN wait strategy
  // (see startReuse's own doc). A process that crashes — or fails that wait
  // — after create() but before that write leaves a RUNNING sandbox under
  // the deterministic name with NO registry entry to say so. `keepAlive`
  // makes it invisible to reaping. The next fresh-create of the same
  // identity must not walk straight into that name collision.
  it("no registry entry at all, but a sandbox is already RUNNING under the deterministic name: best-effort removed before create", async () => {
    const expectedName = await expectedReuseName();
    const backend = new FakeReuseBackend({
      findRunningImpl: async (spec) => (spec.name === expectedName ? { id: expectedName, spec } : undefined),
    });
    const container = new GenericContainer("redis:8.6-alpine")
      .withBackend(backend)
      .withReuse()
      .withExposedPorts(6379)
      .waitingFor(instantReady());
    await container.start();

    const findRunningIndex = backend.calls.indexOf("findRunning");
    const removeIndex = backend.calls.indexOf(`removeByName:${expectedName}`);
    const createIndex = backend.calls.indexOf("create");
    assert.ok(findRunningIndex >= 0, `expected a findRunning() probe, got: ${JSON.stringify(backend.calls)}`);
    assert.ok(
      removeIndex >= 0,
      `expected a best-effort removeByName(${expectedName}) call, got: ${JSON.stringify(backend.calls)}`,
    );
    assert.ok(createIndex >= 0, "expected the fresh create to still happen after the orphan is cleared");
    assert.ok(removeIndex < createIndex, "expected the orphan removal to happen BEFORE the fresh create");
    await container.stop();
  });

  it("no registry entry, and findRunning confirms nothing is running under that name: no remove call at all", async () => {
    const backend = new FakeReuseBackend({
      findRunningImpl: async () => undefined,
    });
    const container = new GenericContainer("redis:8.6-alpine")
      .withBackend(backend)
      .withReuse()
      .withExposedPorts(6379)
      .waitingFor(instantReady());
    await container.start();

    assert.ok(backend.calls.includes("findRunning"), "expected the orphan probe to still run");
    assert.ok(
      !backend.calls.some((c) => c.startsWith("removeByName:")),
      `expected no removeByName call when nothing is running, got: ${JSON.stringify(backend.calls)}`,
    );
    assert.ok(backend.calls.includes("create"));
    await container.stop();
  });

  it("registry present and verified: adopts — no orphan probe side effect ever calls remove", async () => {
    const { name } = await seedRegistry(44444);
    const backend = new FakeReuseBackend({
      findRunningImpl: async (spec) => (spec.name === name ? { id: name, spec } : undefined),
    });
    const container = new GenericContainer("redis:8.6-alpine")
      .withBackend(backend)
      .withReuse()
      .withExposedPorts(6379)
      .waitingFor(instantReady());
    await container.start();

    assert.ok(!backend.calls.includes("create"), "expected adopt, not create");
    assert.ok(
      !backend.calls.some((c) => c.startsWith("removeByName:")),
      `expected no remove call on a clean verified adopt, got: ${JSON.stringify(backend.calls)}`,
    );
    await container.stop();
  });
});

describe("GenericContainer — reuse stop semantics", () => {
  let cacheDir: string;
  const savedReuseEnv = process.env["RIGHTSIZE_REUSE"];

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-reuse-stop-test-"));
    process.env["RIGHTSIZE_CACHE_DIR"] = cacheDir;
    process.env["RIGHTSIZE_REUSE"] = "true";
  });

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
    delete process.env["RIGHTSIZE_CACHE_DIR"];
    if (savedReuseEnv === undefined) {
      delete process.env["RIGHTSIZE_REUSE"];
    } else {
      process.env["RIGHTSIZE_REUSE"] = savedReuseEnv;
    }
  });

  it("stop() leaves the sandbox running: no backend stop/remove call, only in-process bookkeeping clears", async () => {
    const backend = new FakeReuseBackend();
    const container = new GenericContainer("redis:8.6-alpine")
      .withBackend(backend)
      .withReuse()
      .withExposedPorts(6379)
      .waitingFor(instantReady());
    await container.start();
    assert.equal(container.isRunning, true);

    await container.stop();

    assert.equal(container.isRunning, false);
    assert.ok(!backend.calls.includes("stop"), "reuse stop() must never call backend.stop()");
    assert.ok(!backend.calls.includes("remove"), "reuse stop() must never call backend.remove()");
    assert.throws(() => container.getMappedPort(6379));
  });

  it("a reuse container is never appended to the run's ledger .sandboxes file, via the real Backends.active() ledger wiring", async () => {
    const savedProviders = _providersSnapshotForTests();
    const savedBackendEnv = process.env["RIGHTSIZE_BACKEND"];
    const savedReaperEnv = process.env["RIGHTSIZE_REAPER"];
    _resetRegistryForTests();
    Backends._resetActiveForTests();
    delete process.env["RIGHTSIZE_BACKEND"];
    process.env["RIGHTSIZE_REAPER"] = "sweep";

    const backend = new FakeReuseBackend();
    const provider: BackendProvider = {
      name: "docker",
      priority: 10,
      isSupported: () => true,
      unsupportedReason: () => "n/a",
      create: () => backend,
    };
    registerBackend(provider);

    try {
      const container = new GenericContainer("redis:8.6-alpine").withReuse().withExposedPorts(6379).waitingFor(instantReady());
      await container.start();

      const runsDir = path.join(cacheDir, "runs");
      const entries = await fs.readdir(runsDir).catch(() => []);
      const jsonFile = entries.find((f) => f.endsWith(".json"));
      if (jsonFile !== undefined) {
        const runId = jsonFile.slice(0, -".json".length);
        assert.deepEqual(await readSandboxNames(cacheDir, runId), []);
      }
      await container.stop();
    } finally {
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

describe("GenericContainer — reuse + network", () => {
  let cacheDir: string;
  const savedReuseEnv = process.env["RIGHTSIZE_REUSE"];

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-reuse-network-test-"));
    process.env["RIGHTSIZE_CACHE_DIR"] = cacheDir;
  });

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
    delete process.env["RIGHTSIZE_CACHE_DIR"];
    if (savedReuseEnv === undefined) {
      delete process.env["RIGHTSIZE_REUSE"];
    } else {
      process.env["RIGHTSIZE_REUSE"] = savedReuseEnv;
    }
  });

  it("active reuse (both opt-ins) + withNetwork(): rejects with ReuseWithNetworkError before any backend call", async () => {
    process.env["RIGHTSIZE_REUSE"] = "true";
    const backend = new FakeReuseBackend();
    const net = Network.newNetwork();
    const container = new GenericContainer("redis:8.6-alpine")
      .withBackend(backend)
      .withReuse()
      .withNetwork(net)
      .withExposedPorts(6379)
      .waitingFor(instantReady());

    let thrown: unknown;
    try {
      await container.start();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof ReuseWithNetworkError, `expected ReuseWithNetworkError, got: ${String(thrown)}`);
    assert.deepEqual(backend.calls, []);
  });

  it("requested reuse but env disabled + withNetwork(): no conflict — ordinary ephemeral container starts normally", async () => {
    delete process.env["RIGHTSIZE_REUSE"];
    const backend = new FakeReuseBackend();
    const net = Network.newNetwork();
    const container = new GenericContainer("redis:8.6-alpine")
      .withBackend(backend)
      .withReuse()
      .withNetwork(net)
      .withExposedPorts(6379)
      .waitingFor(instantReady());
    await container.start();
    assert.equal(container.isRunning, true);
    await container.stop();
  });
});

describe("GenericContainer — reuse name-collision retry", () => {
  let cacheDir: string;
  const savedReuseEnv = process.env["RIGHTSIZE_REUSE"];

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-reuse-collision-test-"));
    process.env["RIGHTSIZE_CACHE_DIR"] = cacheDir;
    process.env["RIGHTSIZE_REUSE"] = "true";
  });

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
    delete process.env["RIGHTSIZE_CACHE_DIR"];
    if (savedReuseEnv === undefined) {
      delete process.env["RIGHTSIZE_REUSE"];
    } else {
      process.env["RIGHTSIZE_REUSE"] = savedReuseEnv;
    }
  });

  it("a name collision on create (another process won the race): one adopt retry succeeds via the now-visible registry", async () => {
    let createCalls = 0;
    const backend = new FakeReuseBackend({
      createImpl: async (spec) => {
        createCalls += 1;
        // Simulate a concurrent winner: it created AND registered the
        // sandbox in the small window before our own create() lands.
        const hash = await reuseHash({
          image: spec.image,
          env: spec.env,
          command: spec.command,
          exposedPorts: spec.ports.map((p) => p.guestPort),
          memoryLimitMb: spec.memoryLimitMb,
          copies: [],
        });
        await writeRegistryAtomic(cacheDir, hash, {
          name: spec.name,
          image: spec.image,
          ports: { "6379": 33333 },
          createdIso: new Date().toISOString(),
          backend: "fake-reuse",
        });
        throw new Error("boom: name already exists (simulated collision)");
      },
      findRunningImpl: async (spec) => ({ id: spec.name, spec }), // the winner's sandbox is running
    });

    const container = new GenericContainer("redis:8.6-alpine")
      .withBackend(backend)
      .withReuse()
      .withExposedPorts(6379)
      .waitingFor(instantReady());
    await container.start();

    assert.equal(createCalls, 1, "expected exactly one create() attempt — the retry adopts instead of creating again");
    assert.equal(container.getMappedPort(6379), 33333);
    await container.stop();
  });

  it("a create failure that is NOT a collision (findRunning never confirms running): propagates, no retry", async () => {
    let createCalls = 0;
    const backend = new FakeReuseBackend({
      createImpl: async () => {
        createCalls += 1;
        throw new Error("boom: unrelated backend failure");
      },
      findRunningImpl: async () => undefined,
    });

    const container = new GenericContainer("redis:8.6-alpine")
      .withBackend(backend)
      .withReuse()
      .withExposedPorts(6379)
      .waitingFor(instantReady());

    let thrown: unknown;
    try {
      await container.start();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error && thrown.message.includes("unrelated backend failure"));
    assert.equal(createCalls, 1, "expected no retry for a failure findRunning never confirmed as a collision");
  });
});

describe("GenericContainer — reuse fresh-create port-bind-conflict retry", () => {
  let cacheDir: string;
  const savedReuseEnv = process.env["RIGHTSIZE_REUSE"];

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-reuse-portconflict-test-"));
    process.env["RIGHTSIZE_CACHE_DIR"] = cacheDir;
    process.env["RIGHTSIZE_REUSE"] = "true";
  });

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
    delete process.env["RIGHTSIZE_CACHE_DIR"];
    if (savedReuseEnv === undefined) {
      delete process.env["RIGHTSIZE_REUSE"];
    } else {
      process.env["RIGHTSIZE_REUSE"] = savedReuseEnv;
    }
  });

  it("retries with fresh ports on a typed PortBindConflictError, then succeeds and registers", async () => {
    const backend = new FakeReuseBackend({ startFailuresBeforeSuccess: 2, startFailureIsPortConflict: true });
    const container = new GenericContainer("redis:8.6-alpine")
      .withBackend(backend)
      .withReuse()
      .withExposedPorts(6379)
      .waitingFor(instantReady());
    await container.start();

    const createCalls = backend.calls.filter((c) => c === "create").length;
    const startCalls = backend.calls.filter((c) => c === "start").length;
    assert.equal(createCalls, 3, "expected a create() attempt per retry, same as the ephemeral flow");
    assert.equal(startCalls, 3);
    assert.equal(container.isRunning, true);

    const expectedName = await expectedReuseName();
    const hash = await reuseHash({
      image: "redis:8.6-alpine",
      env: [],
      command: undefined,
      exposedPorts: [6379],
      memoryLimitMb: undefined,
      copies: [],
    });
    const found = await readRegistry(cacheDir, hash);
    assert.equal(found.kind, "found");
    if (found.kind === "found") {
      assert.equal(found.entry.name, expectedName);
    }
    await container.stop();
  });

  it("does not retry a non-conflict create/start error on the fresh-create path", async () => {
    const backend = new FakeReuseBackend({ startFailuresBeforeSuccess: 1, startFailureIsPortConflict: false });
    const container = new GenericContainer("redis:8.6-alpine")
      .withBackend(backend)
      .withReuse()
      .withExposedPorts(6379)
      .waitingFor(instantReady());

    await assert.rejects(() => container.start());
    const createCalls = backend.calls.filter((c) => c === "create").length;
    assert.equal(createCalls, 1, "expected no retry for an unrelated failure");
  });

  it("gives up after MAX_START_ATTEMPTS consecutive port-bind conflicts", async () => {
    const backend = new FakeReuseBackend({ startFailuresBeforeSuccess: 5, startFailureIsPortConflict: true });
    const container = new GenericContainer("redis:8.6-alpine")
      .withBackend(backend)
      .withReuse()
      .withExposedPorts(6379)
      .waitingFor(instantReady());

    let thrown: unknown;
    try {
      await container.start();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, `expected an Error, got: ${String(thrown)}`);
    const createCalls = backend.calls.filter((c) => c === "create").length;
    assert.equal(createCalls, 5, "expected exactly MAX_START_ATTEMPTS create() attempts before giving up");
  });
});
