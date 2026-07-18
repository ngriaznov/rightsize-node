import { describe, it, assert, afterEach } from "../../test/harness.js";
import { GenericContainer } from "./generic-container.js";
import type { WaitStrategy } from "./wait.js";
import type { SandboxBackend, SandboxHandle, BackendCapabilities } from "./backend.js";
import type { ContainerSpec, ExecResult } from "./model.js";
import { liveContainers, registerSyncCleanup, unregisterSyncCleanup, _resetForTests } from "./cleanup.js";
import { diagnostics, registerDiagnostics } from "./diagnostics.js";

function instantReady(): WaitStrategy {
  return {
    waitUntilReady: async () => {},
    withStartupTimeout(): WaitStrategy {
      return this;
    },
  };
}

const FAKE_CAPABILITIES: BackendCapabilities = { hardwareIsolated: true, checkpoint: false, checkpointRestartsWorkload: false };

interface FakeDiagnosticsBackendOptions {
  logsImpl?: (handle: SandboxHandle) => Promise<string>;
}

/** A minimal fake backend whose `logs()` is scripted per test — the only method `diagnostics()` ever calls on a backend. */
class FakeDiagnosticsBackend implements SandboxBackend {
  readonly name: string;
  readonly supportsNativeNetworks = true;
  readonly capabilities = FAKE_CAPABILITIES;
  private idSeq = 0;

  constructor(name: string, private readonly opts: FakeDiagnosticsBackendOptions = {}) {
    this.name = name;
  }

  async create(spec: ContainerSpec): Promise<SandboxHandle> {
    this.idSeq += 1;
    return { id: `${this.name}-${this.idSeq}`, spec };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async remove(): Promise<void> {}
  async createCheckpoint(): Promise<void> {}
  async removeCheckpoint(): Promise<void> {}
  async hasCheckpoint(): Promise<boolean> {
    return false;
  }
  async exportCheckpoint(): Promise<void> {}
  async importCheckpoint(): Promise<string> {
    return "";
  }
  async removeByName(): Promise<void> {}
  async findRunning(): Promise<SandboxHandle | undefined> {
    return undefined;
  }
  async reaperKillCommand() {
    return { stop: [], remove: [], removeNetwork: [] };
  }
  async exec(): Promise<ExecResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  async logs(handle: SandboxHandle): Promise<string> {
    if (this.opts.logsImpl !== undefined) {
      return this.opts.logsImpl(handle);
    }
    return "";
  }
  async followLogs() {
    return { close: async (): Promise<void> => {} };
  }
  async ensureNetwork(): Promise<void> {}
  async removeNetwork(): Promise<void> {}
  async installNetworkLinks(): Promise<void> {}
  async copyToContainer(): Promise<void> {}
  async copyFromContainer(): Promise<void> {}
  async close(): Promise<void> {}
  cleanupSync(): void {}
}

function fakeSpec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: "rz-ab12cd34-1",
    image: "alpine:3.19",
    env: [],
    command: undefined,
    ports: [],
    mounts: [],
    networkId: undefined,
    aliases: [],
    runId: "ab12cd34",
    memoryLimitMb: undefined,
    keepAlive: false,
    checkpointRef: undefined,
    ...overrides,
  };
}

describe("diagnostics() — the live-container registry", () => {
  afterEach(() => {
    _resetForTests();
  });

  it("start() adds a container to liveContainers(), stop() removes it", async () => {
    const backend = new FakeDiagnosticsBackend("fake");
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady());

    assert.equal(liveContainers().length, 0);
    await container.start();
    assert.equal(liveContainers().length, 1);

    await container.stop();
    assert.equal(liveContainers().length, 0);
  });
});

describe("diagnostics() — report format", () => {
  afterEach(() => {
    _resetForTests();
  });

  it("no running containers", async () => {
    assert.equal(await diagnostics(), "== rightsize diagnostics: no running containers ==");
  });

  it("golden two-container fixture", async () => {
    const redisBackend = new FakeDiagnosticsBackend("fake", {
      logsImpl: async () => "Ready to accept connections\nStarted redis server\n",
    });
    const redisHandle: SandboxHandle = {
      id: "redis-handle",
      spec: fakeSpec({
        name: "rz-ab12cd34-redis",
        image: "redis:7-alpine",
        ports: [{ hostPort: 49213, guestPort: 6379 }],
      }),
    };
    registerSyncCleanup(redisHandle, redisBackend, () => {});

    const postgresBackend = new FakeDiagnosticsBackend("fake", {
      logsImpl: async () => "database system is ready to accept connections\n",
    });
    const postgresHandle: SandboxHandle = {
      id: "postgres-handle",
      spec: fakeSpec({
        name: "rz-ab12cd34-postgres",
        image: "postgres:16-alpine",
        ports: [{ hostPort: 49214, guestPort: 5432 }],
      }),
    };
    registerSyncCleanup(postgresHandle, postgresBackend, () => {});

    const expected = [
      "== rightsize diagnostics: 2 running container(s) ==",
      "-- rz-ab12cd34-redis (redis:7-alpine) --",
      "state: running   host: 127.0.0.1   ports: 6379->49213",
      "last 50 log lines:",
      "  Ready to accept connections",
      "  Started redis server",
      "-- rz-ab12cd34-postgres (postgres:16-alpine) --",
      "state: running   host: 127.0.0.1   ports: 5432->49214",
      "last 50 log lines:",
      "  database system is ready to accept connections",
    ].join("\n");

    assert.equal(await diagnostics(), expected);

    unregisterSyncCleanup(redisHandle.id);
    unregisterSyncCleanup(postgresHandle.id);
  });

  it("caps the log tail at 50 lines, keeping only the most recent", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line-${i}`);
    const backend = new FakeDiagnosticsBackend("fake", { logsImpl: async () => `${lines.join("\n")}\n` });
    const handle: SandboxHandle = { id: "h1", spec: fakeSpec() };
    registerSyncCleanup(handle, backend, () => {});

    const report = await diagnostics();
    assert.ok(report.includes("  line-10"), "expected the tail to start at line-10 (60 - 50)");
    assert.ok(!report.includes("  line-9\n"), "expected line-9 to be dropped from a 50-line tail");

    unregisterSyncCleanup(handle.id);
  });

  it("degrades a failing logs() call instead of throwing", async () => {
    const backend = new FakeDiagnosticsBackend("fake", {
      logsImpl: async () => {
        throw new Error("daemon unreachable");
      },
    });
    const handle: SandboxHandle = { id: "h1", spec: fakeSpec({ name: "rz-ab12cd34-broken", image: "redis:7-alpine" }) };
    registerSyncCleanup(handle, backend, () => {});

    const report = await diagnostics();
    assert.equal(
      report,
      [
        "== rightsize diagnostics: 1 running container(s) ==",
        "-- rz-ab12cd34-broken (redis:7-alpine) --",
        "state: running   host: 127.0.0.1   ports: (none)",
        "logs: unavailable (daemon unreachable)",
      ].join("\n"),
    );

    unregisterSyncCleanup(handle.id);
  });
});

describe("registerDiagnostics()", () => {
  afterEach(() => {
    _resetForTests();
  });

  it("invokes the provided onTestFailed-shaped callback correctly, writing the report", async () => {
    let capturedCallback: (() => unknown) | undefined;
    const fakeOnTestFailed = (cb: () => unknown): void => {
      capturedCallback = cb;
    };
    const written: string[] = [];

    registerDiagnostics(fakeOnTestFailed, (text) => {
      written.push(text);
    });

    assert.ok(capturedCallback !== undefined, "expected registerDiagnostics to register a callback");
    assert.equal(written.length, 0, "must not write anything before the registered callback actually fires");

    await capturedCallback?.();

    assert.equal(written.length, 1);
    assert.equal(written[0], "== rightsize diagnostics: no running containers ==\n");
  });
});
