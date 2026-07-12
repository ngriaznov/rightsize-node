import {
  deleteRunRecordFiles,
  listRunIds,
  readNetworkIds,
  readRunRecordRaw,
  readSandboxNames,
} from "./ledger.js";
import { parseRunRecord, type LedgerBackendKind } from "./run-record.js";
import { isRecordAlive, type ProcessTimeSource } from "./process-liveness.js";

/** An unparseable record younger than this is presumed mid-write by its own process, not genuinely corrupt — skipped rather than reaped. */
const UNPARSEABLE_FRESH_AGE_MS = 60 * 60 * 1000; // 1 hour

/** What one sweep pass needs: where the ledger lives, which run/backend to exempt, and how to actually remove a sandbox/network by name. */
export interface SweepDeps {
  readonly cacheDir: string;
  /** This process's own run id — always skipped, alive or not. */
  readonly thisRunId: string;
  /** This process's active backend — a dead run is only reaped if its recorded backend matches; cross-backend leftovers are left for a process on that backend. */
  readonly backendKind: LedgerBackendKind;
  readonly removeByName: (name: string) => Promise<void>;
  readonly removeNetwork: (networkId: string) => Promise<void>;
  readonly timeSource: ProcessTimeSource;
}

async function reapRun(deps: SweepDeps, runId: string): Promise<void> {
  const names = await readSandboxNames(deps.cacheDir, runId);
  for (const name of names) {
    await deps.removeByName(name).catch(() => {
      // Best-effort: "not found" is expected (another sweep may have won the
      // race), and any other failure must not stop the rest of the reap.
    });
  }
  const networkIds = await readNetworkIds(deps.cacheDir, runId);
  for (const networkId of networkIds) {
    await deps.removeNetwork(networkId).catch(() => {
      // Best-effort: an in-use network (another still-alive run sharing it,
      // in principle) is left alone rather than failing the whole sweep.
    });
  }
  await deleteRunRecordFiles(deps.cacheDir, runId);
}

/**
 * One full sweep pass: every `runs/*.json` other than this process's own is
 * inspected once. Dead runs whose recorded backend matches this process's
 * active backend are reaped (their sandboxes/networks removed, then their
 * ledger files deleted); alive runs, this run, and cross-backend runs are
 * left untouched. Never throws — a failure reaping one run must not stop
 * the sweep from considering the rest.
 */
export async function sweepOnce(deps: SweepDeps): Promise<void> {
  const runIds = await listRunIds(deps.cacheDir);
  for (const runId of runIds) {
    if (runId === deps.thisRunId) {
      continue;
    }
    try {
      await sweepOneRun(deps, runId);
    } catch {
      // A single run's sweep failing (a stat race, a malformed removeByName
      // implementation, ...) must not abort the sweep of every other run.
    }
  }
}

async function sweepOneRun(deps: SweepDeps, runId: string): Promise<void> {
  const raw = await readRunRecordRaw(deps.cacheDir, runId);
  if (raw === undefined) {
    // Vanished mid-scan: either this run cleanly shut down or another
    // sweep already reaped it. Nothing left to do.
    return;
  }

  const record = parseRunRecord(raw.text);
  if (record === undefined) {
    const ageMs = Date.now() - raw.mtimeMs;
    if (ageMs <= UNPARSEABLE_FRESH_AGE_MS) {
      // Could be a torn read of a record still being written by its owning
      // process (writeRunRecord's rename is atomic, but a stat+read pair
      // here is not synchronized with it) — too young to trust as corrupt.
      return;
    }
    await reapRun(deps, runId);
    return;
  }

  if (record.backend !== deps.backendKind) {
    // A docker process cannot remove msb sandboxes and vice versa — leave
    // this run for a process on its own backend to sweep.
    return;
  }

  const alive = await isRecordAlive(deps.timeSource, record.pid, record.startedIso);
  if (alive) {
    return;
  }
  await reapRun(deps, runId);
}
