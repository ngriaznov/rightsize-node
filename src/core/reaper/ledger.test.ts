import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert, beforeEach, afterEach } from "../../../test/harness.js";
import {
  writeRunRecord,
  appendSandboxName,
  removeSandboxName,
  appendNetworkId,
  removeNetworkId,
  readSandboxNames,
  readNetworkIds,
  listRunIds,
  readRunRecordRaw,
  deleteRunRecordFiles,
} from "./ledger.js";
import { recordPath, sandboxesPath, networksPath, parseRunRecord } from "./run-record.js";

describe("ledger", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-ledger-test-"));
  });

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it("writeRunRecord creates the file atomically (tmp file never left behind), readable back as the same record", async () => {
    await writeRunRecord(cacheDir, "run1", { pid: 123, startedIso: "2026-07-11T00:00:00.000Z", backend: "docker" });
    const raw = await readRunRecordRaw(cacheDir, "run1");
    assert.ok(raw !== undefined);
    assert.deepEqual(parseRunRecord(raw?.text ?? ""), {
      pid: 123,
      startedIso: "2026-07-11T00:00:00.000Z",
      backend: "docker",
    });
    const leftovers = (await fs.readdir(path.join(cacheDir, "runs"))).filter((n) => n.includes(".tmp-"));
    assert.deepEqual(leftovers, []);
  });

  it("sandbox names: append is superset-preserving before a name exists, remove takes it back out", async () => {
    await writeRunRecord(cacheDir, "run1", { pid: 1, startedIso: "x", backend: "docker" });
    await appendSandboxName(cacheDir, "run1", "rz-run1-1");
    assert.deepEqual(await readSandboxNames(cacheDir, "run1"), ["rz-run1-1"]);

    await appendSandboxName(cacheDir, "run1", "rz-run1-2");
    assert.deepEqual(await readSandboxNames(cacheDir, "run1"), ["rz-run1-1", "rz-run1-2"]);

    await removeSandboxName(cacheDir, "run1", "rz-run1-1");
    assert.deepEqual(await readSandboxNames(cacheDir, "run1"), ["rz-run1-2"]);
  });

  it("removing the LAST sandbox name, with no networks tracked, prunes all three ledger files", async () => {
    await writeRunRecord(cacheDir, "run1", { pid: 1, startedIso: "x", backend: "docker" });
    await appendSandboxName(cacheDir, "run1", "rz-run1-1");

    await removeSandboxName(cacheDir, "run1", "rz-run1-1");

    assert.equal(fsSync.existsSync(recordPath(cacheDir, "run1")), false);
    assert.equal(fsSync.existsSync(sandboxesPath(cacheDir, "run1")), false);
    assert.equal(fsSync.existsSync(networksPath(cacheDir, "run1")), false);
  });

  it("removing the last sandbox name does NOT prune while a network is still tracked", async () => {
    await writeRunRecord(cacheDir, "run1", { pid: 1, startedIso: "x", backend: "docker" });
    await appendSandboxName(cacheDir, "run1", "rz-run1-1");
    await appendNetworkId(cacheDir, "run1", "rz-net-aaaa");

    await removeSandboxName(cacheDir, "run1", "rz-run1-1");

    assert.equal(fsSync.existsSync(recordPath(cacheDir, "run1")), true);
    assert.deepEqual(await readNetworkIds(cacheDir, "run1"), ["rz-net-aaaa"]);

    await removeNetworkId(cacheDir, "run1", "rz-net-aaaa");
    assert.equal(fsSync.existsSync(recordPath(cacheDir, "run1")), false);
  });

  it("removing a name that was never appended is a harmless no-op", async () => {
    await writeRunRecord(cacheDir, "run1", { pid: 1, startedIso: "x", backend: "docker" });
    await appendSandboxName(cacheDir, "run1", "rz-run1-1");
    await removeSandboxName(cacheDir, "run1", "rz-run1-nonexistent");
    assert.deepEqual(await readSandboxNames(cacheDir, "run1"), ["rz-run1-1"]);
  });

  it("removeSandboxName/removeNetworkId on a run with no ledger files at all is a harmless no-op", async () => {
    await removeSandboxName(cacheDir, "ghost-run", "rz-ghost-1");
    await removeNetworkId(cacheDir, "ghost-run", "rz-net-ghost");
    assert.deepEqual(await readSandboxNames(cacheDir, "ghost-run"), []);
  });

  it("listRunIds lists every run's json basename under runs/, ignoring non-.json ledger files", async () => {
    await writeRunRecord(cacheDir, "runA", { pid: 1, startedIso: "x", backend: "docker" });
    await writeRunRecord(cacheDir, "runB", { pid: 2, startedIso: "y", backend: "msb" });
    await appendSandboxName(cacheDir, "runA", "rz-runA-1");

    const ids = (await listRunIds(cacheDir)).sort();
    assert.deepEqual(ids, ["runA", "runB"]);
  });

  it("listRunIds on a missing runs/ directory returns an empty list", async () => {
    assert.deepEqual(await listRunIds(cacheDir), []);
  });

  it("readRunRecordRaw returns undefined for a run whose record file doesn't exist", async () => {
    assert.equal(await readRunRecordRaw(cacheDir, "nope"), undefined);
  });

  it("deleteRunRecordFiles is best-effort and safe to call on a run with nothing on disk", async () => {
    await deleteRunRecordFiles(cacheDir, "nope");
  });

  it("concurrent appends within one process never lose a line (in-process lock serializes read-modify-write)", async () => {
    await writeRunRecord(cacheDir, "run1", { pid: 1, startedIso: "x", backend: "docker" });
    const names = Array.from({ length: 25 }, (_, i) => `rz-run1-${i}`);
    await Promise.all(names.map((n) => appendSandboxName(cacheDir, "run1", n)));
    const stored = await readSandboxNames(cacheDir, "run1");
    assert.deepEqual([...stored].sort(), [...names].sort());
    assert.equal(stored.length, names.length);
  });

  it("unlocked readers racing rewrites never observe a torn (empty) sandboxes file", async () => {
    // The reads here are deliberately lock-free (mirroring readSandboxNames'
    // production contract, and the out-of-process watchdog's reads on the
    // crash path), so the file swap itself must be atomic: a truncate-then-
    // write rewrite would expose an empty file between those two steps.
    await writeRunRecord(cacheDir, "run2", { pid: 1, startedIso: "x", backend: "docker" });
    await appendSandboxName(cacheDir, "run2", "rz-run2-keeper");
    const churn = (async () => {
      for (let i = 0; i < 50; i++) {
        await appendSandboxName(cacheDir, "run2", `rz-run2-extra-${i}`);
        await removeSandboxName(cacheDir, "run2", `rz-run2-extra-${i}`);
      }
    })();
    let torn = 0;
    const reads = (async () => {
      for (let i = 0; i < 200; i++) {
        const seen = await readSandboxNames(cacheDir, "run2");
        if (!seen.includes("rz-run2-keeper")) {
          torn += 1;
        }
      }
    })();
    await Promise.all([churn, reads]);
    assert.equal(torn, 0, `readers observed a torn ledger ${torn} time(s)`);
  });
});
