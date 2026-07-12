/**
 * Standalone helper process for the SIGKILL end-to-end reaper test
 * (test/it/reaper.test.ts). Run directly with `node` — never imported —
 * against the COMPILED output (`dist-test/test/it/fixtures/…js`), so this
 * file must not depend on anything that isn't part of the normal
 * `tsc -p tsconfig.test.json` build the rest of `test/**` already gets.
 *
 * Boots one real msb sandbox through the real library (not a shortcut) —
 * proving the reaper's real code path runs: the run record gets written,
 * the sandbox name gets appended to the ledger, and (RIGHTSIZE_REAPER
 * defaulting to "on") a real watchdog gets spawned before this process's
 * first `create()`. Once the sandbox is confirmed running, prints a single
 * `READY <RunId.value>\n` line and flushes, then blocks forever so the
 * parent test can SIGKILL this process at a moment of its choosing — the
 * watchdog detects that death (a closed stdin pipe on POSIX; a dead pid on
 * Windows — see watchdog.ts's spawnWatchdog doc) and reaps on its own,
 * which is the entire mechanism under test. The parent already controls
 * `RIGHTSIZE_CACHE_DIR` (passed via this process's env) and reads the
 * ledger's own `.sandboxes` file for the run id printed here to learn the
 * sandbox name(s) — no need to smuggle the name out through a second
 * channel.
 */
import * as fsSync from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import "../../../src/backend-msb/index.js";
import { GenericContainer } from "../../../src/core/generic-container.js";
import { Wait } from "../../../src/core/wait.js";
import { RunId } from "../../../src/core/run-id.js";
import { cacheDir } from "../../../src/core/cache-dir.js";
import { recordPath } from "../../../src/core/reaper/run-record.js";
import { watchdogTracePath } from "../../../src/core/reaper/watchdog.js";
import { _heldWatchdogForTests } from "../../../src/core/reaper/init.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Where a canary control experiment's heartbeat file lives — exported so the test can locate it without duplicating the naming scheme. `detached` picks between the two variants spawnCanary starts. */
export function canaryHeartbeatPath(cacheDirValue: string, runId: string, detached: boolean): string {
  const suffix = detached ? "detached" : "attached";
  return path.join(path.dirname(recordPath(cacheDirValue, runId)), `canary-${suffix}-${runId}.log`);
}

/**
 * RIGHTSIZE_REAPER_DEBUG=1 only: a minimal control experiment, orthogonal
 * to the whole watchdog/PowerShell/msb stack, to test ONE narrow question
 * directly — does an ordinary Windows child process of THIS process
 * survive being SIGKILLed, or does the OS take it down too (Windows Job
 * Object semantics)? Spawns two trivial `node -e` heartbeat writers, one
 * non-detached (the same shape libuv uses by default for any child) and
 * one `detached: true`, each appending a timestamp to its own file every
 * 500ms. If the non-detached one's heartbeats stop right around the same
 * moment this process is killed while the detached one keeps going, that
 * settles two things at once: the OS really does kill non-detached
 * descendants alongside the parent regardless of what they're doing, AND
 * detached:true is a viable escape for an ORDINARY process — meaning the
 * watchdog's own detached:true failures (see watchdog.ts's spawnWatchdog
 * doc) are specific to spawning PowerShell that way, not evidence that
 * detached:true is unusable in general.
 */
function spawnCanary(): void {
  if (process.env["RIGHTSIZE_REAPER_DEBUG"] !== "1") {
    return;
  }
  const makeScript = (heartbeatPath: string): string =>
    "const fs=require('fs');" +
    `const p=${JSON.stringify(heartbeatPath)};` +
    "setInterval(()=>{try{fs.appendFileSync(p, Date.now()+'\\n');}catch(e){}}, 500);";
  const attachedPath = canaryHeartbeatPath(cacheDir(), RunId.value, false);
  spawn(process.execPath, ["-e", makeScript(attachedPath)], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  const detachedPath = canaryHeartbeatPath(cacheDir(), RunId.value, true);
  const detachedChild = spawn(process.execPath, ["-e", makeScript(detachedPath)], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  detachedChild.unref();
}

/**
 * RIGHTSIZE_REAPER_DEBUG=1 only: checks, from INSIDE this still-alive
 * process (i.e. well before the parent test's SIGKILL ever lands), whether
 * the watchdog it just spawned is actually running its script at all —
 * printed to stderr (the parent test already captures this process's
 * stderr in full) so a failure that turns out to predate the SIGKILL
 * entirely (spawn/startup broken, as opposed to "killed mid-run by
 * something correlated with the SIGKILL") is visible without another CI
 * round. Best-effort: any failure here is swallowed and reported as such,
 * never allowed to affect the fixture's own READY signal.
 */
async function precheckWatchdog(): Promise<void> {
  if (process.env["RIGHTSIZE_REAPER_DEBUG"] !== "1") {
    return;
  }
  try {
    const handle = _heldWatchdogForTests();
    if (handle === undefined || handle.process.pid === undefined) {
      process.stderr.write("WATCHDOG_PRECHECK: no held watchdog handle or pid\n");
      return;
    }
    const pid = handle.process.pid;
    const tracePath = watchdogTracePath(recordPath(cacheDir(), RunId.value), pid);
    process.stderr.write(
      `WATCHDOG_PRECHECK: pid=${pid} exitCode=${handle.process.exitCode ?? "null"} ` +
        `killed=${handle.process.killed} tracePath=${tracePath}\n`,
    );
    // A few short retries: even a healthy watchdog's very first trace line
    // is written asynchronously relative to this check, not synchronously
    // with spawn() returning.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await sleep(500);
      try {
        const content = fsSync.readFileSync(tracePath, "utf8");
        process.stderr.write(`WATCHDOG_PRECHECK: trace file content after ${(attempt + 1) * 500}ms:\n${content}\n`);
        return;
      } catch {
        // not there yet — keep retrying up to the loop bound
      }
    }
    process.stderr.write(
      `WATCHDOG_PRECHECK: trace file still absent after 3s — exitCode=${handle.process.exitCode ?? "null"} ` +
        `killed=${handle.process.killed}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `WATCHDOG_PRECHECK failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
  }
}

async function main(): Promise<void> {
  spawnCanary();

  const container = new GenericContainer("alpine:3.19")
    .withCommand("sleep", "300")
    // alpine's sleep exposes no port and prints nothing — times=0 means
    // "ready the instant the sandbox itself is Running," which is all this
    // fixture needs: the readiness gate is msb's own boot, not the workload.
    .waitingFor(Wait.forLogMessage(".*", 0));

  await container.start();
  await precheckWatchdog();
  process.stdout.write(`READY ${RunId.value}\n`);
  // Deliberately never resolves: this process is killed externally by the
  // parent test, never exits on its own.
  await new Promise<void>(() => {});
}

main().catch((err) => {
  process.stderr.write(`reaper-sigkill-child failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
