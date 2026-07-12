import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  recordPath,
  runsDir,
  sandboxesPath,
  networksPath,
  parseRunRecord,
  serializeRunRecord,
  type RunRecord,
} from "./run-record.js";

/**
 * Every write this module makes is guarded by a single process-wide chain —
 * this process only ever owns its own ledger files, so one chain (not one
 * per file) is enough to make append/remove/prune read-modify-write safe
 * against concurrent callers within THIS process. Cross-process safety is a
 * non-goal by design: the feature spec only requires "atomic enough for
 * single-process use," since two different processes never share a run id.
 */
let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = chain.then(fn, fn);
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function readLines(filePath: string): Promise<string[]> {
  let text: string;
  try {
    text = await fsp.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter((line) => line.length > 0);
}

// A plain truncating write is safe here ONLY because every reader of a live
// run's file goes through the same lock as its writers (see readSandboxNames/
// readNetworkIds below); the sole lock-free readers — the watchdog process and
// another process's sweep — read a run's files strictly after its owning
// process is dead, when no writer can exist. A tmp+rename swap is deliberately
// NOT used: on Windows, renaming over a file a reader has open fails EPERM,
// which would turn a benign read race into a lost ledger update.
async function writeLines(filePath: string, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) {
    await fsp.unlink(filePath).catch(() => {});
    return;
  }
  await fsp.writeFile(filePath, lines.join("\n") + "\n");
}

function removeFirstOccurrence(lines: readonly string[], value: string): string[] {
  const idx = lines.indexOf(value);
  if (idx === -1) {
    return [...lines];
  }
  return [...lines.slice(0, idx), ...lines.slice(idx + 1)];
}

/** Best-effort delete of all three of a run's ledger files. Never throws — a file already gone is not an error. */
export async function deleteRunRecordFiles(cacheDir: string, runId: string): Promise<void> {
  await Promise.all(
    [recordPath(cacheDir, runId), sandboxesPath(cacheDir, runId), networksPath(cacheDir, runId)].map((p) =>
      fsp.unlink(p).catch(() => {}),
    ),
  );
}

async function isEmptyOrMissing(filePath: string): Promise<boolean> {
  try {
    const text = await fsp.readFile(filePath, "utf8");
    return text.trim().length === 0;
  } catch {
    return true;
  }
}

/**
 * The run-record cleanup rule: once BOTH `.sandboxes` and `.networks` are
 * empty (or missing), this run has nothing left in flight, so its ledger
 * files are deleted — a later container start recreates them from scratch.
 * Called after every removal, never after an append (an append can only
 * grow a file, never trigger this).
 */
async function pruneIfEmpty(cacheDir: string, runId: string): Promise<void> {
  const [sandboxesEmpty, networksEmpty] = await Promise.all([
    isEmptyOrMissing(sandboxesPath(cacheDir, runId)),
    isEmptyOrMissing(networksPath(cacheDir, runId)),
  ]);
  if (sandboxesEmpty && networksEmpty) {
    await deleteRunRecordFiles(cacheDir, runId);
  }
}

/** Atomically writes `runs/<run-id>.json` (tmp file + rename) — called once, before this run's first sandbox is created. */
export async function writeRunRecord(cacheDir: string, runId: string, record: RunRecord): Promise<void> {
  return withLock(async () => {
    const dir = runsDir(cacheDir);
    await fsp.mkdir(dir, { recursive: true });
    const target = recordPath(cacheDir, runId);
    const tmp = path.join(dir, `.${runId}.json.tmp-${process.pid}-${Date.now()}`);
    await fsp.writeFile(tmp, serializeRunRecord(record));
    await fsp.rename(tmp, target);
  });
}

/** Appends a sandbox name to `runs/<run-id>.sandboxes` — called BEFORE the backend's `create()` call. */
export async function appendSandboxName(cacheDir: string, runId: string, name: string): Promise<void> {
  return withLock(async () => {
    const filePath = sandboxesPath(cacheDir, runId);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.appendFile(filePath, name + "\n");
  });
}

/** Removes a sandbox name from `runs/<run-id>.sandboxes` — called AFTER a successful stop/remove; prunes the run's ledger files if this was the last thing tracked. */
export async function removeSandboxName(cacheDir: string, runId: string, name: string): Promise<void> {
  return withLock(async () => {
    const filePath = sandboxesPath(cacheDir, runId);
    const lines = removeFirstOccurrence(await readLines(filePath), name);
    await writeLines(filePath, lines);
    await pruneIfEmpty(cacheDir, runId);
  });
}

/** Appends a network id to `runs/<run-id>.networks` — same protocol as `appendSandboxName`. */
export async function appendNetworkId(cacheDir: string, runId: string, networkId: string): Promise<void> {
  return withLock(async () => {
    const filePath = networksPath(cacheDir, runId);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.appendFile(filePath, networkId + "\n");
  });
}

/** Removes a network id from `runs/<run-id>.networks` — same protocol as `removeSandboxName`. */
export async function removeNetworkId(cacheDir: string, runId: string, networkId: string): Promise<void> {
  return withLock(async () => {
    const filePath = networksPath(cacheDir, runId);
    const lines = removeFirstOccurrence(await readLines(filePath), networkId);
    await writeLines(filePath, lines);
    await pruneIfEmpty(cacheDir, runId);
  });
}

/**
 * Reads every sandbox name currently tracked for a run. Serialized behind the
 * same lock as the writers: writeLines truncates before it writes, so an
 * unserialized read racing a rewrite could observe a torn (empty) file. The
 * cross-process readers (a sweep judging a DEAD run, the watchdog after its
 * owner died) need no lock — their run's writer no longer exists.
 */
export async function readSandboxNames(cacheDir: string, runId: string): Promise<string[]> {
  return withLock(() => readLines(sandboxesPath(cacheDir, runId)));
}

/** Reads every network id currently tracked for a run — used by the sweep to know what to reap. */
export async function readNetworkIds(cacheDir: string, runId: string): Promise<string[]> {
  return withLock(() => readLines(networksPath(cacheDir, runId)));
}

/** Every other run's `<run-id>.json` filename (without extension) currently under `runs/` — the sweep's iteration set. Missing `runs/` directory yields an empty list. */
export async function listRunIds(cacheDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(runsDir(cacheDir));
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
}

/** Reads and parses one run's record, plus the file's mtime (used to age an unparseable record). `undefined` body means the file vanished (a concurrent sweep or the run's own clean shutdown already removed it). */
export async function readRunRecordRaw(
  cacheDir: string,
  runId: string,
): Promise<{ text: string; mtimeMs: number } | undefined> {
  const filePath = recordPath(cacheDir, runId);
  try {
    const [text, stat] = await Promise.all([fsp.readFile(filePath, "utf8"), fsp.stat(filePath)]);
    return { text, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

export { parseRunRecord };
