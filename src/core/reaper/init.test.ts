import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert, beforeEach, afterEach } from "../../../test/harness.js";
import {
  ensureReaperInitialized,
  trackSandbox,
  untrackSandbox,
  trackNetwork,
  untrackNetwork,
  notifyBackendClosed,
  _isActiveForTests,
  _heldWatchdogForTests,
  _resetReaperForTests,
} from "./init.js";
import { writeRunRecord, appendSandboxName, readSandboxNames } from "./ledger.js";
import { recordPath, sandboxesPath, networksPath } from "./run-record.js";
import type { SandboxBackend, SandboxHandle, NetworkLink, FollowHandle, ReaperKillCommand } from "../backend.js";
import type { ContainerSpec, ExecResult } from "../model.js";

class FakeReaperBackend implements SandboxBackend {
  readonly supportsNativeNetworks = true;
  readonly capabilities = { hardwareIsolated: true, checkpoint: false, checkpointRestartsWorkload: false };
  reaperKillCommandCalls = 0;
  readonly removedNames: string[] = [];
  readonly removedNetworks: string[] = [];

  constructor(readonly name: string = "docker") {}

  async create(spec: ContainerSpec): Promise<SandboxHandle> {
    return { id: spec.name, spec };
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
  async removeByName(name: string): Promise<void> {
    this.removedNames.push(name);
  }
  async findRunning(): Promise<SandboxHandle | undefined> {
    return undefined;
  }
  async reaperKillCommand(): Promise<ReaperKillCommand> {
    this.reaperKillCommandCalls += 1;
    return this.name === "microsandbox"
      ? { stop: ["/fake/msb", "stop"], remove: ["/fake/msb", "rm"], removeNetwork: [] }
      : { stop: [], remove: ["docker", "rm", "-f"], removeNetwork: ["docker", "network", "rm"] };
  }
  async exec(): Promise<ExecResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  async logs(): Promise<string> {
    return "";
  }
  async followLogs(): Promise<FollowHandle> {
    return { close: async () => {} };
  }
  async ensureNetwork(): Promise<void> {}
  async removeNetwork(networkId: string): Promise<void> {
    this.removedNetworks.push(networkId);
  }
  async installNetworkLinks(_handle: SandboxHandle, _links: ReadonlyArray<NetworkLink>): Promise<void> {}
  async copyToContainer(_handle: SandboxHandle, _hostPath: string, _containerPath: string): Promise<void> {}
  async copyFromContainer(_handle: SandboxHandle, _containerPath: string, _hostPath: string): Promise<void> {}
  async close(): Promise<void> {}
  cleanupSync(): void {}
}

describe("core/reaper/init (ensureReaperInitialized orchestration)", () => {
  let cacheDir: string;
  const savedCacheDirEnv = process.env["RIGHTSIZE_CACHE_DIR"];
  const savedReaperEnv = process.env["RIGHTSIZE_REAPER"];

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-init-test-"));
    process.env["RIGHTSIZE_CACHE_DIR"] = cacheDir;
    _resetReaperForTests();
  });

  afterEach(async () => {
    // Never leak a real (if harmless, unref'd) blocked watchdog process
    // across test runs — close its pipe so it exits on its own.
    _heldWatchdogForTests()?.closeForTests();
    _resetReaperForTests();
    if (savedCacheDirEnv === undefined) {
      delete process.env["RIGHTSIZE_CACHE_DIR"];
    } else {
      process.env["RIGHTSIZE_CACHE_DIR"] = savedCacheDirEnv;
    }
    if (savedReaperEnv === undefined) {
      delete process.env["RIGHTSIZE_REAPER"];
    } else {
      process.env["RIGHTSIZE_REAPER"] = savedReaperEnv;
    }
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it("before initialization, track*/untrack* are silent no-ops (never write to disk)", async () => {
    await trackSandbox("rz-should-not-appear-1");
    await trackNetwork("rz-net-should-not-appear");
    assert.equal(fsSync.existsSync(path.join(cacheDir, "runs")), false);
  });

  it("writes this run's record, then makes track*/untrack* live", async () => {
    delete process.env["RIGHTSIZE_REAPER"];
    const backend = new FakeReaperBackend("docker");

    await ensureReaperInitialized(backend);

    assert.equal(_isActiveForTests(), true);
    const runsDirEntries = await fs.readdir(path.join(cacheDir, "runs"));
    const jsonFiles = runsDirEntries.filter((f) => f.endsWith(".json"));
    assert.equal(jsonFiles.length, 1);
    const record = JSON.parse(await fs.readFile(path.join(cacheDir, "runs", jsonFiles[0] as string), "utf8")) as {
      pid: number;
      backend: string;
    };
    assert.equal(record.pid, process.pid);
    assert.equal(record.backend, "docker");

    await trackSandbox("rz-tracked-1");
    const runId = (jsonFiles[0] as string).slice(0, -".json".length);
    assert.deepEqual(await readSandboxNames(cacheDir, runId), ["rz-tracked-1"]);

    await untrackSandbox("rz-tracked-1");
    assert.deepEqual(await readSandboxNames(cacheDir, runId), []);
  });

  it("records an msb run's backend and msbPath, derived from reaperKillCommand's remove prefix", async () => {
    delete process.env["RIGHTSIZE_REAPER"];
    const backend = new FakeReaperBackend("microsandbox");

    await ensureReaperInitialized(backend);

    const [file] = await fs.readdir(path.join(cacheDir, "runs"));
    const record = JSON.parse(await fs.readFile(path.join(cacheDir, "runs", file as string), "utf8")) as {
      backend: string;
      msbPath?: string;
    };
    assert.equal(record.backend, "msb");
    assert.equal(record.msbPath, "/fake/msb");
  });

  it("runs the bring-up exactly once per process even if called concurrently and repeatedly", async () => {
    delete process.env["RIGHTSIZE_REAPER"];
    const backend = new FakeReaperBackend("docker");

    await Promise.all([
      ensureReaperInitialized(backend),
      ensureReaperInitialized(backend),
      ensureReaperInitialized(backend),
    ]);
    await ensureReaperInitialized(backend);

    assert.equal(backend.reaperKillCommandCalls, 1);
  });

  it("RIGHTSIZE_REAPER=off: no run record, no ledger tracking, reaper stays inactive", async () => {
    process.env["RIGHTSIZE_REAPER"] = "off";
    const backend = new FakeReaperBackend("docker");

    await ensureReaperInitialized(backend);

    assert.equal(_isActiveForTests(), false);
    assert.equal(fsSync.existsSync(path.join(cacheDir, "runs")), false);
    await trackSandbox("rz-should-still-not-appear");
    assert.equal(fsSync.existsSync(path.join(cacheDir, "runs")), false);
  });

  it("RIGHTSIZE_REAPER=sweep: the run record is written and tracking works, but no watchdog is spawned", async () => {
    process.env["RIGHTSIZE_REAPER"] = "sweep";
    const backend = new FakeReaperBackend("docker");

    await ensureReaperInitialized(backend);

    assert.equal(_isActiveForTests(), true);
    assert.equal(_heldWatchdogForTests(), undefined);
  });

  it("RIGHTSIZE_REAPER=on (default): a watchdog is spawned", async () => {
    if (process.platform === "win32") {
      return;
    }
    delete process.env["RIGHTSIZE_REAPER"];
    const backend = new FakeReaperBackend("docker");

    await ensureReaperInitialized(backend);

    assert.ok(_heldWatchdogForTests() !== undefined, "expected a watchdog to have been spawned");
  });

  it("sweeps a dead same-backend run on init, reaping its sandboxes and deleting its ledger files", async () => {
    delete process.env["RIGHTSIZE_REAPER"];
    await writeRunRecord(cacheDir, "dead-run", { pid: 999_999, startedIso: "2000-01-01T00:00:00.000Z", backend: "docker" });
    await appendSandboxName(cacheDir, "dead-run", "rz-dead-1");

    const backend = new FakeReaperBackend("docker");
    await ensureReaperInitialized(backend);

    assert.deepEqual(backend.removedNames, ["rz-dead-1"]);
    assert.equal(fsSync.existsSync(recordPath(cacheDir, "dead-run")), false);
  });

  it("leaves a dead OTHER-backend run alone (backend mismatch)", async () => {
    delete process.env["RIGHTSIZE_REAPER"];
    await writeRunRecord(cacheDir, "dead-msb-run", { pid: 999_999, startedIso: "2000-01-01T00:00:00.000Z", backend: "msb" });
    await appendSandboxName(cacheDir, "dead-msb-run", "rz-msb-dead-1");

    const backend = new FakeReaperBackend("docker");
    await ensureReaperInitialized(backend);

    assert.deepEqual(backend.removedNames, []);
    assert.equal(fsSync.existsSync(recordPath(cacheDir, "dead-msb-run")), true);
  });

  it("a failure inside bring-up (e.g. reaperKillCommand rejects) is swallowed — reaperReady never rejects, but stays inactive", async () => {
    delete process.env["RIGHTSIZE_REAPER"];
    const backend = new FakeReaperBackend("docker");
    backend.reaperKillCommand = async (): Promise<ReaperKillCommand> => {
      throw new Error("boom: cannot determine kill command");
    };

    await ensureReaperInitialized(backend); // must not throw
    assert.equal(_isActiveForTests(), false);
  });

  it("notifyBackendClosed deletes this run's ledger files unconditionally and deactivates tracking (addendum item 5)", async () => {
    delete process.env["RIGHTSIZE_REAPER"];
    const backend = new FakeReaperBackend("docker");
    await ensureReaperInitialized(backend);

    // Simulate a container backend.close() already tore down (own-run
    // cleanup) but whose stop() never ran to remove its own ledger line —
    // e.g. a process that goes straight from a live container to exit.
    await trackSandbox("rz-still-listed-1");
    await trackNetwork("rz-net-still-listed-1");

    const runsDirEntries = await fs.readdir(path.join(cacheDir, "runs"));
    const jsonFile = runsDirEntries.find((f) => f.endsWith(".json"));
    assert.ok(jsonFile !== undefined);
    const runId = (jsonFile as string).slice(0, -".json".length);
    assert.equal(fsSync.existsSync(sandboxesPath(cacheDir, runId)), true);

    await notifyBackendClosed();

    assert.equal(fsSync.existsSync(recordPath(cacheDir, runId)), false);
    assert.equal(fsSync.existsSync(sandboxesPath(cacheDir, runId)), false);
    assert.equal(fsSync.existsSync(networksPath(cacheDir, runId)), false);
    assert.equal(_isActiveForTests(), false);

    // Inert afterward: track* calls after the backend has closed must not
    // resurrect the just-deleted ledger files.
    await trackSandbox("rz-post-close-should-not-appear");
    assert.equal(fsSync.existsSync(path.join(cacheDir, "runs", `${runId}.sandboxes`)), false);
  });

  it("notifyBackendClosed is a no-op when the reaper never initialized", async () => {
    await notifyBackendClosed(); // must not throw
    assert.equal(_isActiveForTests(), false);
  });

  it("(sanity) sandboxesPath/recordPath agree with what the ledger module itself uses", async () => {
    delete process.env["RIGHTSIZE_REAPER"];
    const backend = new FakeReaperBackend("docker");
    await ensureReaperInitialized(backend);
    const [file] = await fs.readdir(path.join(cacheDir, "runs"));
    const runId = (file as string).slice(0, -".json".length);
    assert.equal(fsSync.existsSync(recordPath(cacheDir, runId)), true);
    assert.equal(fsSync.existsSync(sandboxesPath(cacheDir, runId)), false); // nothing tracked yet
  });
});
