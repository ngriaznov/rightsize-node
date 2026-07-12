import { describe, it, assert } from "../../../test/harness.js";
import {
  isProcessAlive,
  isRecordAlive,
  realProcessTimeSource,
  THIS_PROCESS_STARTED_ISO,
  LIVENESS_TOLERANCE_MS,
  _parseEtimeMsForTests,
  type ProcessTimeSource,
} from "./process-liveness.js";

function fakeSource(alive: Set<number>, starts: Map<number, string | undefined>): ProcessTimeSource {
  return {
    isAlive: (pid) => alive.has(pid),
    startedIso: async (pid) => starts.get(pid),
  };
}

describe("isProcessAlive", () => {
  it("this process's own pid is alive", () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it("a pid essentially guaranteed not to exist is not alive", () => {
    assert.equal(isProcessAlive(999_999), false);
  });
});

describe("isRecordAlive", () => {
  it("alive: pid exists and recorded start time matches exactly", async () => {
    const source = fakeSource(new Set([42]), new Map([[42, "2026-07-11T00:00:00.000Z"]]));
    assert.equal(await isRecordAlive(source, 42, "2026-07-11T00:00:00.000Z"), true);
  });

  it("alive: start times within the 2s tolerance still count as the same process", async () => {
    const source = fakeSource(new Set([42]), new Map([[42, "2026-07-11T00:00:01.500Z"]]));
    assert.equal(await isRecordAlive(source, 42, "2026-07-11T00:00:00.000Z"), true);
  });

  it("dead: pid does not exist at all", async () => {
    const source = fakeSource(new Set(), new Map([[42, "2026-07-11T00:00:00.000Z"]]));
    assert.equal(await isRecordAlive(source, 42, "2026-07-11T00:00:00.000Z"), false);
  });

  it("dead: same pid, different start time (PID reuse) — outside the tolerance window", async () => {
    const source = fakeSource(new Set([42]), new Map([[42, "2026-07-11T00:05:00.000Z"]]));
    assert.equal(await isRecordAlive(source, 42, "2026-07-11T00:00:00.000Z"), false);
  });

  it("dead: start time exactly at the tolerance boundary is still alive, one ms past is dead", async () => {
    const boundary = fakeSource(new Set([1]), new Map([[1, new Date(LIVENESS_TOLERANCE_MS).toISOString()]]));
    assert.equal(await isRecordAlive(boundary, 1, new Date(0).toISOString()), true);

    const pastBoundary = fakeSource(new Set([1]), new Map([[1, new Date(LIVENESS_TOLERANCE_MS + 1).toISOString()]]));
    assert.equal(await isRecordAlive(pastBoundary, 1, new Date(0).toISOString()), false);
  });

  it("dead: the time source can't determine a start time at all (pid vanished mid-check)", async () => {
    const source = fakeSource(new Set([42]), new Map([[42, undefined]]));
    assert.equal(await isRecordAlive(source, 42, "2026-07-11T00:00:00.000Z"), false);
  });
});

describe("THIS_PROCESS_STARTED_ISO", () => {
  it("is a parseable ISO-8601 instant no later than now", () => {
    const parsed = Date.parse(THIS_PROCESS_STARTED_ISO);
    assert.ok(!Number.isNaN(parsed));
    assert.ok(parsed <= Date.now());
  });
});

describe("_parseEtimeMsForTests (the ps -o etime= duration parser)", () => {
  it("parses bare mm:ss", () => {
    assert.equal(_parseEtimeMsForTests("05:09"), (5 * 60 + 9) * 1000);
  });

  it("parses hh:mm:ss", () => {
    assert.equal(_parseEtimeMsForTests("02:05:09"), ((2 * 60 + 5) * 60 + 9) * 1000);
  });

  it("parses dd-hh:mm:ss", () => {
    assert.equal(_parseEtimeMsForTests("3-02:05:09"), (((3 * 24 + 2) * 60 + 5) * 60 + 9) * 1000);
  });

  it("tolerates the leading/trailing whitespace ps pads its column output with", () => {
    assert.equal(_parseEtimeMsForTests("  00:07  "), 7000);
  });

  it("returns undefined for text that doesn't match any of the three shapes", () => {
    assert.equal(_parseEtimeMsForTests(""), undefined);
    assert.equal(_parseEtimeMsForTests("not a duration"), undefined);
    assert.equal(_parseEtimeMsForTests("Wed Jul 8 10:23:45 2026"), undefined);
  });
});

describe("realProcessTimeSource (POSIX only — Windows correctness is covered by the msb-windows integration lane)", () => {
  it("startedIso(this process's own pid) roughly agrees with THIS_PROCESS_STARTED_ISO", async () => {
    if (process.platform === "win32") {
      return;
    }
    const actual = await realProcessTimeSource.startedIso(process.pid);
    assert.ok(actual !== undefined, "expected ps to report a start time for this process's own pid");
    const diff = Math.abs(Date.parse(actual as string) - Date.parse(THIS_PROCESS_STARTED_ISO));
    // `ps -o etime=` truncates to whole seconds and this test itself runs
    // some time after process start, so a tight tolerance is the wrong
    // assertion — this just proves the shell-out + parse pipeline produces
    // *a* sane, roughly-correct instant, not exact agreement.
    assert.ok(diff < 120_000, `expected the two start-time estimates to agree within 2 minutes, got a ${diff}ms diff`);
  });

  it("startedIso of a pid that does not exist resolves to undefined", async () => {
    if (process.platform === "win32") {
      return;
    }
    assert.equal(await realProcessTimeSource.startedIso(999_999), undefined);
  });
});
