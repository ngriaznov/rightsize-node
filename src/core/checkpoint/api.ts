import { cacheDir } from "../cache-dir.js";
import { Backends } from "../backends.js";
import type { Checkpoint } from "../model.js";
import { requireValidCheckpointName } from "./name.js";
import {
  readCheckpointRegistry,
  removeCheckpointRegistryFile,
  listCheckpointNames,
  fromCheckpointRegistryEntry,
  type CheckpointRegistryEntry,
} from "./registry.js";

/** Every field of a `Checkpoint` comes straight from the registry entry except `spec`, which is reconstructed via `fromCheckpointRegistryEntry` — see that function's own doc for what is and isn't meaningful in the result. */
function toCheckpoint(entry: CheckpointRegistryEntry): Checkpoint {
  return { ref: entry.ref, backend: entry.backend, spec: fromCheckpointRegistryEntry(entry) };
}

/**
 * Rediscovers a named checkpoint written by an earlier `checkpoint(name)`
 * call — in this process or an entirely different one, since the registry
 * lives on disk under the shared rightsize cache directory. No entry for
 * `name` resolves to `undefined`. A corrupt entry is treated the same as
 * absent, with a best-effort delete of the bad file.
 *
 * When the entry's own recorded backend matches the CURRENTLY active
 * backend, the underlying artifact is probed via the backend's
 * `hasCheckpoint` SPI before this resolves — an artifact that's gone (removed
 * by hand, or by something outside this library) makes the entry stale: it's
 * best-effort deleted and this resolves to `undefined`, the same as if it
 * had never existed. A probe FAILURE (the backend call itself throws) is
 * never swallowed into a `false` — only a confirmed "does not exist"
 * resolves that way, so a probe failure propagates out of this call.
 *
 * When the entry's recorded backend DIFFERS from the active one, this
 * returns the entry unprobed — an msb ref means nothing to a docker probe
 * and vice versa. `GenericContainer.fromCheckpoint(cp).start()`'s own
 * `CheckpointBackendMismatchError` gate stays the sole authority for that
 * mismatch; this function must not force-resolve a backend the host may not
 * even have.
 *
 * `name` is validated against `CHECKPOINT_NAME_PATTERN` before anything else
 * — including before the registry file is even looked up — so a `name`
 * carrying `../` segments can never reach path construction; an invalid name
 * throws `InvalidCheckpointNameError` and touches no file.
 */
export async function find(name: string): Promise<Checkpoint | undefined> {
  requireValidCheckpointName(name);
  const dir = cacheDir();
  const read = await readCheckpointRegistry(dir, name);
  if (read.kind === "missing") {
    return undefined;
  }
  if (read.kind === "corrupt") {
    await removeCheckpointRegistryFile(dir, name);
    return undefined;
  }

  const entry = read.entry;
  const active = Backends.active();
  if (entry.backend !== active.name) {
    return toCheckpoint(entry);
  }

  const exists = await active.hasCheckpoint(entry.ref);
  if (!exists) {
    await removeCheckpointRegistryFile(dir, name);
    return undefined;
  }
  return toCheckpoint(entry);
}

/**
 * Every named checkpoint currently in the registry — registry contents
 * only, never probed against a backend (unlike `find`), so a stale entry
 * whose artifact is gone still appears here until something calls `find` or
 * `remove` on it. A corrupt entry is silently skipped, never removed (only
 * `find`/`remove` clean those up, since `list` never resolves a single name
 * the caller could target for a retry).
 */
export async function list(): Promise<Checkpoint[]> {
  const dir = cacheDir();
  const names = await listCheckpointNames(dir);
  const checkpoints: Checkpoint[] = [];
  for (const name of names) {
    const read = await readCheckpointRegistry(dir, name);
    if (read.kind === "found") {
      checkpoints.push(toCheckpoint(read.entry));
    }
  }
  return checkpoints;
}

/**
 * Deletes a named checkpoint: best-effort removal of the backend artifact
 * (only when the entry's recorded backend matches the currently active
 * one — this call never touches a backend that isn't active) plus the
 * registry file, regardless of order of failure in either. Idempotent and
 * always best-effort: "not found" anywhere (no registry entry at all) is
 * success, reported as `false`; an existing entry — valid or corrupt —
 * reports `true` once its registry file is gone.
 *
 * When the entry's recorded backend DIFFERS from the currently active one,
 * only the registry record is deleted — the underlying artifact (the docker
 * image, or the microsandbox snapshot) is left on disk PERMANENTLY, since
 * this call never touches a backend that isn't active. Nothing in this
 * library reclaims it automatically — and once the record is gone, a later
 * `remove(name)` finds nothing to act on. Remove a checkpoint under its
 * creating backend in the first place, or clean the leftover artifact
 * directly with that backend's own CLI one-liner (see the
 * [checkpoints guide](/guide/checkpoints#cleanup-checkpoints-are-not-auto-reaped)).
 *
 * `name` is validated against `CHECKPOINT_NAME_PATTERN` before anything else
 * — including before the registry file is even looked up — so a `name`
 * carrying `../` segments can never reach path construction; an invalid name
 * throws `InvalidCheckpointNameError` and touches no file.
 */
export async function remove(name: string): Promise<boolean> {
  requireValidCheckpointName(name);
  const dir = cacheDir();
  const read = await readCheckpointRegistry(dir, name);
  if (read.kind === "missing") {
    return false;
  }
  if (read.kind === "corrupt") {
    await removeCheckpointRegistryFile(dir, name);
    return true;
  }

  const entry = read.entry;
  const active = Backends.active();
  if (entry.backend === active.name) {
    await active.removeCheckpoint(entry.ref).catch(() => {});
  }
  await removeCheckpointRegistryFile(dir, name);
  return true;
}

/**
 * The library's entry point for rediscovering NAMED checkpoints across
 * processes — see the [checkpoints guide](/guide/checkpoints#reusing-checkpoints-across-runs)
 * for the `find(...) ?? seed()` first-run/later-run pattern this exists to
 * support. Unnamed `checkpoint()` calls never appear here; only a
 * `checkpoint(name)` call writes a registry entry these functions can find.
 */
export const Checkpoints = {
  /** Rediscovers a named checkpoint — see `find` above. */
  find,
  /** Every named checkpoint currently in the registry — see `list` above. */
  list,
  /** Deletes a named checkpoint — see `remove` above. */
  remove,
};
