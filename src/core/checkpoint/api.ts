import { cacheDir } from "../cache-dir.js";
import { Backends } from "../backends.js";
import type { Checkpoint } from "../model.js";
import { CheckpointArtifactMissingError, CheckpointBackendMismatchError } from "../errors.js";
import { requireValidCheckpointName } from "./name.js";
import {
  readCheckpointRegistry,
  removeCheckpointRegistryFile,
  writeCheckpointRegistryAtomic,
  listCheckpointNames,
  fromCheckpointRegistryEntry,
  toCheckpointRegistrySpec,
  type CheckpointRegistryEntry,
} from "./registry.js";
import { writeCheckpointArchive, readCheckpointArchive, CHECKPOINT_ARCHIVE_VERSION } from "./archive.js";
import type { CheckpointArchiveMetadata } from "./archive.js";

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
 * Reverse lookup: the registry entry (if any) whose `ref`/`backend` match a
 * `Checkpoint`'s own — `exportTo`'s only way to learn whether the checkpoint
 * it's given was ever named, and under what name, since a `Checkpoint`
 * object itself never carries one (see `toCheckpoint` above). Scans every
 * registered name the same way `list()` does; a corrupt entry is silently
 * skipped, matching `list()`'s own tolerance.
 */
async function findRegistryEntryByRef(dir: string, ref: string, backend: string): Promise<CheckpointRegistryEntry | undefined> {
  const names = await listCheckpointNames(dir);
  for (const name of names) {
    const read = await readCheckpointRegistry(dir, name);
    if (read.kind === "found" && read.entry.ref === ref && read.entry.backend === backend) {
      return read.entry;
    }
  }
  return undefined;
}

/**
 * Bundles `cp` into a self-describing archive at `destPath`: `checkpoint.json`
 * (the pinned metadata — format version, this checkpoint's name if it was
 * ever registered under one, ref, backend, creation time, and spec) plus an
 * `artifact` member holding the backend's own payload, byte-for-byte what
 * `SandboxBackend.exportCheckpoint` produces. See the
 * [checkpoints guide](/guide/checkpoints#moving-checkpoints-between-machines)
 * for the full CI-cache pattern this exists for.
 *
 * Requires the ACTIVE backend to equal `cp.backend` — the same
 * `CheckpointBackendMismatchError` `fromCheckpoint(cp).start()` throws —
 * before any backend or filesystem work. Then probes the artifact still
 * exists via `hasCheckpoint`: exporting a stale checkpoint throws
 * `CheckpointArtifactMissingError` rather than producing a broken archive.
 * Only once both checks pass does this stage the export in a fresh unique
 * temp directory (removed in a `finally` regardless of outcome) and tar it
 * into `destPath` (parent directories created; a pre-existing file there is
 * overwritten). Works on an ephemeral (unnamed) checkpoint too — the
 * resulting archive just carries `name: null`.
 */
export async function exportTo(cp: Checkpoint, destPath: string): Promise<void> {
  const active = Backends.active();
  if (cp.backend !== active.name) {
    throw new CheckpointBackendMismatchError(cp.backend, active.name);
  }
  const exists = await active.hasCheckpoint(cp.ref);
  if (!exists) {
    throw new CheckpointArtifactMissingError(cp.ref, cp.backend);
  }

  const dir = cacheDir();
  const registryEntry = await findRegistryEntryByRef(dir, cp.ref, cp.backend);
  const metadata: CheckpointArchiveMetadata = {
    rightsizeArchive: CHECKPOINT_ARCHIVE_VERSION,
    name: registryEntry?.name ?? null,
    ref: cp.ref,
    backend: cp.backend,
    createdIso: registryEntry?.createdIso ?? new Date().toISOString(),
    spec: toCheckpointRegistrySpec(cp.spec),
  };

  await writeCheckpointArchive(destPath, metadata, (artifactPath) => active.exportCheckpoint(cp.ref, artifactPath));
}

/**
 * The inverse of `exportTo`: extracts `srcPath`, validates its
 * `checkpoint.json` (format version, `name` against
 * `CHECKPOINT_NAME_PATTERN` when non-null, backend against the ACTIVE
 * backend — a `MalformedCheckpointArchiveError` or `CheckpointBackendMismatchError`
 * either way, before any backend call or registry write), then hands the
 * extracted `artifact` to `SandboxBackend.importCheckpoint`, which
 * materializes it and returns the EFFECTIVE ref (docker: the same `ref` the
 * archive recorded; microsandbox: the digest `snapshot import` actually
 * assigned it — never necessarily the archive's own `ref`).
 *
 * A NAMED archive (`name` non-null) gets replace semantics matching
 * `checkpoint(name)`: if a registry entry already exists for that name under
 * a DIFFERENT ref and its recorded backend matches the active one, its old
 * artifact is best-effort removed first (never a foreign-backend
 * `removeCheckpoint` call — the same gate `remove()` applies); the registry
 * entry is then written (or overwritten) with the effective ref. A NAMELESS
 * archive writes no registry entry at all — the returned `Checkpoint` is
 * purely ephemeral, the same as an unnamed `checkpoint()` call's result.
 * Either way, the returned `Checkpoint` restores via the existing
 * `fromCheckpoint()` path with zero changes — refs are opaque throughout
 * this library.
 */
export async function importFrom(srcPath: string): Promise<Checkpoint> {
  const active = Backends.active();
  return readCheckpointArchive(srcPath, async (metadata, artifactPath) => {
    if (metadata.name !== null) {
      requireValidCheckpointName(metadata.name);
    }
    if (metadata.backend !== active.name) {
      throw new CheckpointBackendMismatchError(metadata.backend, active.name);
    }

    const effectiveRef = await active.importCheckpoint(artifactPath, metadata.ref);
    const spec = fromCheckpointRegistryEntry({
      name: metadata.name ?? "",
      ref: effectiveRef,
      backend: active.name,
      createdIso: metadata.createdIso,
      spec: metadata.spec,
    });

    if (metadata.name !== null) {
      const dir = cacheDir();
      const existing = await readCheckpointRegistry(dir, metadata.name);
      if (existing.kind === "found" && existing.entry.ref !== effectiveRef && existing.entry.backend === active.name) {
        await active.removeCheckpoint(existing.entry.ref).catch(() => {});
      }
      const entry: CheckpointRegistryEntry = {
        name: metadata.name,
        ref: effectiveRef,
        backend: active.name,
        createdIso: metadata.createdIso,
        spec: metadata.spec,
      };
      await writeCheckpointRegistryAtomic(dir, metadata.name, entry);
    }

    return { ref: effectiveRef, backend: active.name, spec };
  });
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
  /** Bundles a checkpoint into a portable archive — see `exportTo` above. */
  exportTo,
  /** Materializes a portable archive on this machine — see `importFrom` above. */
  importFrom,
};
