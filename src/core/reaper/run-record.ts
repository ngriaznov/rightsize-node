import * as path from "node:path";

/**
 * The two backend families the reaping ledger can name — deliberately not
 * `SandboxBackend["name"]` (`"microsandbox"` / `"docker"`) verbatim: this is
 * the cross-language wire format every rightsize implementation reads and
 * writes (a Kotlin or Rust process sweeping a dead Node run's ledger parses
 * this same field), so it uses the short, language-neutral spelling the
 * feature spec defines rather than any one language's own backend-name
 * string.
 */
export type LedgerBackendKind = "msb" | "docker";

/**
 * One `runs/<run-id>.json` record: written atomically before this process's
 * first sandbox is created, and read by every OTHER process's sweep to
 * decide whether this run is still alive. Every field here is part of the
 * cross-language contract — a Kotlin or Rust sweep must be able to parse
 * exactly this shape.
 */
export interface RunRecord {
  /** This process's OS pid. */
  readonly pid: number;
  /** ISO-8601 instant the *process* started (not when this record was written) — defeats PID reuse. */
  readonly startedIso: string;
  /** Which backend family this run's sandboxes belong to. */
  readonly backend: LedgerBackendKind;
  /** Absolute path to the provisioned `msb` binary this run used. Present only for `backend: "msb"`. */
  readonly msbPath?: string;
}

/** `<cacheDir>/runs` — the directory every run's ledger files live under. */
export function runsDir(cacheDir: string): string {
  return path.join(cacheDir, "runs");
}

/** `runs/<run-id>.json` — the run record. */
export function recordPath(cacheDir: string, runId: string): string {
  return path.join(runsDir(cacheDir), `${runId}.json`);
}

/** `runs/<run-id>.sandboxes` — one sandbox name per line, append-before-create/remove-after-stop. */
export function sandboxesPath(cacheDir: string, runId: string): string {
  return path.join(runsDir(cacheDir), `${runId}.sandboxes`);
}

/** `runs/<run-id>.networks` — same protocol as `.sandboxes`, for created networks. */
export function networksPath(cacheDir: string, runId: string): string {
  return path.join(runsDir(cacheDir), `${runId}.networks`);
}

function isLedgerBackendKind(value: unknown): value is LedgerBackendKind {
  return value === "msb" || value === "docker";
}

/**
 * Parses a `runs/<run-id>.json` body. Returns `undefined` for anything that
 * isn't a well-shaped record — malformed JSON, a missing/mistyped required
 * field, or a `backend` value this contract doesn't know — rather than
 * throwing, so a sweep can treat "unparseable" as its own liveness case (see
 * the sweep spec: fresh unparseable JSON is skipped, stale unparseable JSON
 * is cleaned) instead of crashing on a record from a future rightsize
 * version.
 */
export function parseRunRecord(text: string): RunRecord | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof obj !== "object" || obj === null) {
    return undefined;
  }
  const rec = obj as Record<string, unknown>;
  const pid = rec["pid"];
  const startedIso = rec["startedIso"];
  const backend = rec["backend"];
  if (typeof pid !== "number" || typeof startedIso !== "string" || !isLedgerBackendKind(backend)) {
    return undefined;
  }
  const msbPath = rec["msbPath"];
  if (msbPath !== undefined && typeof msbPath !== "string") {
    return undefined;
  }
  return msbPath === undefined ? { pid, startedIso, backend } : { pid, startedIso, backend, msbPath };
}

/** Serializes a `RunRecord` for `runs/<run-id>.json`. */
export function serializeRunRecord(record: RunRecord): string {
  return JSON.stringify(record);
}
