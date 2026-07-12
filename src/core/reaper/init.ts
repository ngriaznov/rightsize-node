import { cacheDir } from "../cache-dir.js";
import { RunId } from "../run-id.js";
import type { SandboxBackend } from "../backend.js";
import {
  writeRunRecord,
  appendSandboxName,
  removeSandboxName,
  appendNetworkId,
  removeNetworkId,
  deleteRunRecordFiles,
} from "./ledger.js";
import { recordPath, sandboxesPath, networksPath, type LedgerBackendKind, type RunRecord } from "./run-record.js";
import { realProcessTimeSource, THIS_PROCESS_STARTED_ISO } from "./process-liveness.js";
import { sweepOnce } from "./sweep.js";
import { reaperMode, sweepEnabled, watchdogEnabled } from "./env.js";
import { spawnWatchdog, type WatchdogHandle } from "./watchdog.js";

/**
 * Everything a tracked container/network needs about this process's own
 * ledger location — set exactly once, by a successful `doInit`, and never
 * again. `undefined` means either initialization hasn't run yet or the
 * reaper is fully disabled (`RIGHTSIZE_REAPER=off`); either way, every
 * `track*`/`untrack*` call below becomes a silent no-op, which is also
 * exactly the right behavior for a process that only ever uses explicit
 * `withBackend()` overrides and never resolves `Backends.active()` at all.
 */
interface ActiveLedger {
  readonly cacheDir: string;
  readonly runId: string;
}

let active: ActiveLedger | undefined;
let initPromise: Promise<void> | undefined;
let heldWatchdog: WatchdogHandle | undefined;

function backendKindOf(backend: SandboxBackend): LedgerBackendKind {
  // The only two backends this library ships. A third backend module would
  // need a third LedgerBackendKind value and an update here.
  return backend.name === "microsandbox" ? "msb" : "docker";
}

async function doInit(backend: SandboxBackend): Promise<void> {
  const mode = reaperMode(process.env);
  if (!sweepEnabled(mode)) {
    // "off": no run record, no ledger tracking, no sweep, no watchdog —
    // this process's containers are simply never listed anywhere for a
    // later sweep to find.
    return;
  }

  const dir = cacheDir();
  const runId = RunId.value;
  const backendKind = backendKindOf(backend);
  const killCommand = await backend.reaperKillCommand();
  // msb's `remove` prefix is always `[msbPath, "rm"]` (see
  // MsbCliBackend.reaperKillCommand) — reusing it here avoids a second SPI
  // method whose only job would be exposing the same path.
  const msbPath = backendKind === "msb" ? killCommand.remove[0] : undefined;

  const record: RunRecord =
    msbPath === undefined
      ? { pid: process.pid, startedIso: THIS_PROCESS_STARTED_ISO, backend: backendKind }
      : { pid: process.pid, startedIso: THIS_PROCESS_STARTED_ISO, backend: backendKind, msbPath };

  // Written BEFORE this process's first sandbox is created — the caller
  // (Backends.reaperReady(), awaited by GenericContainer.start() before its
  // first backend.create()) guarantees that ordering.
  await writeRunRecord(dir, runId, record);
  active = { cacheDir: dir, runId };

  await sweepOnce({
    cacheDir: dir,
    thisRunId: runId,
    backendKind,
    removeByName: (name) => backend.removeByName(name),
    removeNetwork: (networkId) => backend.removeNetwork(networkId),
    timeSource: realProcessTimeSource,
  });

  if (watchdogEnabled(mode)) {
    heldWatchdog = await spawnWatchdog({
      cacheDir: dir,
      sandboxesPath: sandboxesPath(dir, runId),
      networksPath: networksPath(dir, runId),
      recordPath: recordPath(dir, runId),
      killCommand,
      // The Windows script polls for this pid instead of blocking on
      // stdin EOF; see watchdog.ts's windowsScriptContent doc.
      ownerPid: process.pid,
    });
  }
}

/**
 * Runs the full reaper bring-up exactly once per process: writes this run's
 * record, sweeps every OTHER dead run whose backend matches, and (unless
 * disabled) spawns the watchdog. Best-effort end to end — any failure here
 * is swallowed so a broken cache dir or a sweep hiccup never prevents the
 * backend from being usable; `active` simply never gets set, and every
 * ledger call for the rest of this process's life is a no-op.
 */
export function ensureReaperInitialized(backend: SandboxBackend): Promise<void> {
  if (initPromise === undefined) {
    initPromise = doInit(backend).catch(() => {
      // Swallowed — see the doc above.
    });
  }
  return initPromise;
}

/** Appends a sandbox name to this process's ledger — a no-op unless the reaper has actually initialized (or is disabled). */
export async function trackSandbox(name: string): Promise<void> {
  if (active === undefined) {
    return;
  }
  await appendSandboxName(active.cacheDir, active.runId, name);
}

/** Removes a sandbox name from this process's ledger, pruning the run's ledger files if nothing is left tracked. */
export async function untrackSandbox(name: string): Promise<void> {
  if (active === undefined) {
    return;
  }
  await removeSandboxName(active.cacheDir, active.runId, name);
}

/** Appends a network id to this process's ledger. */
export async function trackNetwork(networkId: string): Promise<void> {
  if (active === undefined) {
    return;
  }
  await appendNetworkId(active.cacheDir, active.runId, networkId);
}

/** Removes a network id from this process's ledger, pruning the run's ledger files if nothing is left tracked. */
export async function untrackNetwork(networkId: string): Promise<void> {
  if (active === undefined) {
    return;
  }
  await removeNetworkId(active.cacheDir, active.runId, networkId);
}

/**
 * The run-record cleanup rule's other trigger (see `ledger.ts`'s
 * `pruneIfEmpty` for the first one): called once, after the active
 * backend's own `close()` has finished its own-run cleanup (`Backends`'
 * `beforeExit` hook awaits `close()`, then calls this). `close()` already
 * removed every sandbox this run still had running (via its own run-id-
 * label/`startedNames` scan), so whatever `.sandboxes`/`.networks` still
 * list at this point is stale — deleted unconditionally rather than only
 * when empty, since a later container start recreates the files from
 * scratch anyway. No-op if the reaper never initialized (or already ran
 * this) for this process.
 */
export async function notifyBackendClosed(): Promise<void> {
  if (active === undefined) {
    return;
  }
  const { cacheDir, runId } = active;
  active = undefined;
  await deleteRunRecordFiles(cacheDir, runId);
}

/** Test seam: whether the reaper has actually initialized in this process. Never call from library code. */
export function _isActiveForTests(): boolean {
  return active !== undefined;
}

/** Test seam: the held watchdog handle, if one was spawned — so a test can close its pipe rather than leaking a blocked child process. Never call from library code. */
export function _heldWatchdogForTests(): WatchdogHandle | undefined {
  return heldWatchdog;
}

/** Test seam: forces the next `ensureReaperInitialized` call to redo the full bring-up. Never call from library code. */
export function _resetReaperForTests(): void {
  active = undefined;
  initPromise = undefined;
  heldWatchdog = undefined;
}
