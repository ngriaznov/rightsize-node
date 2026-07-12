import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert, beforeEach, afterEach } from "../../../test/harness.js";
import { sweepOnce, type SweepDeps } from "./sweep.js";
import { writeRunRecord, appendSandboxName, appendNetworkId } from "./ledger.js";
import { recordPath, sandboxesPath, runsDir } from "./run-record.js";
import type { ProcessTimeSource } from "./process-liveness.js";

/** Reports every pid alive with a start time that exactly matches whatever the caller recorded — `isRecordAlive` treats this as "definitely alive." */
function aliveSource(): ProcessTimeSource {
  return { isAlive: () => true, startedIso: async () => "2026-07-11T00:00:00.000Z" };
}

function deadSource(): ProcessTimeSource {
  return { isAlive: () => false, startedIso: async () => undefined };
}

describe("sweepOnce", () => {
  let cacheDir: string;
  let removed: string[];
  let removedNetworks: string[];
  let removeByNameImpl: (name: string) => Promise<void>;

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-sweep-test-"));
    removed = [];
    removedNetworks = [];
    removeByNameImpl = async (name) => {
      removed.push(name);
    };
  });

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  function deps(overrides: Partial<SweepDeps> = {}): SweepDeps {
    return {
      cacheDir,
      thisRunId: "this-run",
      backendKind: "docker",
      removeByName: (name) => removeByNameImpl(name),
      removeNetwork: async (id) => {
        removedNetworks.push(id);
      },
      timeSource: aliveSource(),
      ...overrides,
    };
  }

  it("reaps a dead run: every sandbox removed, every network removed, ledger files deleted", async () => {
    await writeRunRecord(cacheDir, "dead-run", { pid: 42, startedIso: "2020-01-01T00:00:00.000Z", backend: "docker" });
    await appendSandboxName(cacheDir, "dead-run", "rz-dead-1");
    await appendSandboxName(cacheDir, "dead-run", "rz-dead-2");
    await appendNetworkId(cacheDir, "dead-run", "rz-net-dead");

    await sweepOnce(deps({ timeSource: deadSource() }));

    assert.deepEqual(removed.sort(), ["rz-dead-1", "rz-dead-2"]);
    assert.deepEqual(removedNetworks, ["rz-net-dead"]);
    assert.equal(fsSync.existsSync(recordPath(cacheDir, "dead-run")), false);
  });

  it("leaves an alive run's ledger and sandboxes completely untouched", async () => {
    await writeRunRecord(cacheDir, "alive-run", { pid: 42, startedIso: "2026-07-11T00:00:00.000Z", backend: "docker" });
    await appendSandboxName(cacheDir, "alive-run", "rz-alive-1");

    await sweepOnce(deps({ timeSource: aliveSource() }));

    assert.deepEqual(removed, []);
    assert.equal(fsSync.existsSync(recordPath(cacheDir, "alive-run")), true);
  });

  it("never touches its own run, alive or not", async () => {
    await writeRunRecord(cacheDir, "this-run", { pid: process.pid, startedIso: "2000-01-01T00:00:00.000Z", backend: "docker" });
    await appendSandboxName(cacheDir, "this-run", "rz-this-1");

    await sweepOnce(deps({ thisRunId: "this-run", timeSource: deadSource() }));

    assert.deepEqual(removed, []);
    assert.equal(fsSync.existsSync(recordPath(cacheDir, "this-run")), true);
  });

  it("leaves a dead run alone when its recorded backend doesn't match this process's active backend", async () => {
    await writeRunRecord(cacheDir, "dead-msb-run", { pid: 42, startedIso: "2020-01-01T00:00:00.000Z", backend: "msb" });
    await appendSandboxName(cacheDir, "dead-msb-run", "rz-msb-1");

    await sweepOnce(deps({ backendKind: "docker", timeSource: deadSource() }));

    assert.deepEqual(removed, []);
    assert.equal(fsSync.existsSync(recordPath(cacheDir, "dead-msb-run")), true, "a cross-backend run must wait for a process on its own backend");
  });

  it("a removeByName rejection for one name (e.g. 'not found') is swallowed and the rest of the reap still runs", async () => {
    removeByNameImpl = async (name) => {
      if (name === "rz-dead-1") {
        throw new Error("not found");
      }
      removed.push(name);
    };
    await writeRunRecord(cacheDir, "dead-run", { pid: 1, startedIso: "x", backend: "docker" });
    await appendSandboxName(cacheDir, "dead-run", "rz-dead-1");
    await appendSandboxName(cacheDir, "dead-run", "rz-dead-2");

    await sweepOnce(deps({ timeSource: deadSource() }));

    assert.deepEqual(removed, ["rz-dead-2"]);
    assert.equal(fsSync.existsSync(recordPath(cacheDir, "dead-run")), false, "ledger files are still cleaned up even if one removal failed");
  });

  it("skips a fresh unparseable record file (presumed mid-write, not corrupt)", async () => {
    await fs.mkdir(runsDir(cacheDir), { recursive: true });
    await fs.writeFile(recordPath(cacheDir, "torn-run"), "{ not valid json");
    await fs.writeFile(sandboxesPath(cacheDir, "torn-run"), "rz-torn-1\n");

    await sweepOnce(deps({ timeSource: deadSource() }));

    assert.deepEqual(removed, []);
    assert.equal(fsSync.existsSync(recordPath(cacheDir, "torn-run")), true);
  });

  it("cleans up a stale unparseable record file (old enough to be genuinely corrupt, not mid-write)", async () => {
    await fs.mkdir(runsDir(cacheDir), { recursive: true });
    const target = recordPath(cacheDir, "corrupt-run");
    await fs.writeFile(target, "{ not valid json");
    await fs.writeFile(sandboxesPath(cacheDir, "corrupt-run"), "rz-corrupt-1\n");
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h ago > the 1h freshness window
    await fs.utimes(target, oldTime, oldTime);

    await sweepOnce(deps({ timeSource: deadSource() }));

    assert.deepEqual(removed, ["rz-corrupt-1"]);
    assert.equal(fsSync.existsSync(target), false);
  });

  it("a run with no .sandboxes/.networks files at all (already-drained) still gets its lone .json deleted", async () => {
    await writeRunRecord(cacheDir, "empty-dead-run", { pid: 1, startedIso: "x", backend: "docker" });

    await sweepOnce(deps({ timeSource: deadSource() }));

    assert.deepEqual(removed, []);
    assert.equal(fsSync.existsSync(recordPath(cacheDir, "empty-dead-run")), false);
  });

  it("an empty runs/ directory (no other process has ever run) is a no-op", async () => {
    await sweepOnce(deps());
    assert.deepEqual(removed, []);
  });

  it("a completely missing runs/ directory is a no-op", async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
    await fs.mkdir(cacheDir, { recursive: true });
    await sweepOnce(deps());
    assert.deepEqual(removed, []);
  });

  it("sweeps multiple dead runs in one pass, each independently", async () => {
    await writeRunRecord(cacheDir, "dead-a", { pid: 1, startedIso: "x", backend: "docker" });
    await appendSandboxName(cacheDir, "dead-a", "rz-a-1");
    await writeRunRecord(cacheDir, "dead-b", { pid: 2, startedIso: "y", backend: "docker" });
    await appendSandboxName(cacheDir, "dead-b", "rz-b-1");

    await sweepOnce(deps({ timeSource: deadSource() }));

    assert.deepEqual(removed.sort(), ["rz-a-1", "rz-b-1"]);
  });
});
