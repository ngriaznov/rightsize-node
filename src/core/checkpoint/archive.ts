import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BackendError, MalformedCheckpointArchiveError } from "../errors.js";
import { isCheckpointRegistrySpec } from "./registry.js";
import type { CheckpointRegistrySpec } from "./registry.js";
import { TarCli, runTar } from "./tar-cli.js";

/** The one archive format version this library understands — pinned identically across every rightsize language implementation. */
export const CHECKPOINT_ARCHIVE_VERSION = 1;

/**
 * An archive bundles a full backend artifact (a zstd-compressed msb snapshot
 * or a saved docker image) — generous relative to a plain `msb copy`/`docker
 * cp`, matching the backend's own export/import budget for the payload
 * itself.
 */
const ARCHIVE_TAR_TIMEOUT_MS = 300_000;

/**
 * `checkpoint.json`'s exact shape — pinned identically in every rightsize
 * language implementation. `name` is `null` for an archive built from an
 * unnamed (ephemeral) checkpoint; every other field mirrors
 * `CheckpointRegistryEntry` plus the format version.
 */
export interface CheckpointArchiveMetadata {
  readonly rightsizeArchive: 1;
  readonly name: string | null;
  readonly ref: string;
  readonly backend: string;
  readonly createdIso: string;
  readonly spec: CheckpointRegistrySpec;
}

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Parses and validates `text` (the extracted archive's `checkpoint.json`
 * content) into a `CheckpointArchiveMetadata`. Every failure — invalid JSON,
 * a `rightsizeArchive` value other than `CHECKPOINT_ARCHIVE_VERSION` (named
 * in the thrown error, per the pinned format's own contract), a malformed
 * `name`/`ref`/`backend`/`createdIso`/`spec` — throws
 * `MalformedCheckpointArchiveError` naming `archivePath` (the ORIGINAL
 * archive the caller passed to `importFrom`, not the temp-extracted json
 * path, so the error is actionable). Never touches a backend or the
 * registry — pure parsing.
 */
export function parseCheckpointArchiveMetadata(text: string, archivePath: string): CheckpointArchiveMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MalformedCheckpointArchiveError(archivePath, "checkpoint.json is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new MalformedCheckpointArchiveError(archivePath, "checkpoint.json is not a JSON object");
  }
  const rec = parsed as Record<string, unknown>;

  if (rec["rightsizeArchive"] !== CHECKPOINT_ARCHIVE_VERSION) {
    throw new MalformedCheckpointArchiveError(
      archivePath,
      `unsupported rightsizeArchive version ${JSON.stringify(rec["rightsizeArchive"])} (this library reads version ${CHECKPOINT_ARCHIVE_VERSION})`,
    );
  }
  const name = rec["name"];
  if (name !== null && typeof name !== "string") {
    throw new MalformedCheckpointArchiveError(archivePath, "checkpoint.json's 'name' field must be a string or null");
  }
  if (typeof rec["ref"] !== "string" || typeof rec["backend"] !== "string" || typeof rec["createdIso"] !== "string") {
    throw new MalformedCheckpointArchiveError(
      archivePath,
      "checkpoint.json is missing one of the required string fields 'ref', 'backend', 'createdIso'",
    );
  }
  if (!isCheckpointRegistrySpec(rec["spec"])) {
    throw new MalformedCheckpointArchiveError(archivePath, "checkpoint.json's 'spec' field is missing or malformed");
  }

  return {
    rightsizeArchive: 1,
    name,
    ref: rec["ref"],
    backend: rec["backend"],
    createdIso: rec["createdIso"],
    spec: rec["spec"],
  };
}

/**
 * Builds a checkpoint archive at `destPath`: stages `checkpoint.json` and an
 * `artifact` file (written by `exportArtifact`, the backend's own
 * `exportCheckpoint` call) in a fresh temp directory, then tars exactly
 * those two members at the archive's root — never nested under the temp
 * dir's own path. `destPath`'s parent directories are created first; a
 * pre-existing file at `destPath` is overwritten (tar's own default
 * behavior). The temp directory is removed in a `finally`, on success and on
 * failure alike.
 */
export async function writeCheckpointArchive(
  destPath: string,
  metadata: CheckpointArchiveMetadata,
  exportArtifact: (artifactPath: string) => Promise<void>,
): Promise<void> {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await withTempDir("rightsize-checkpoint-export-", async (workDir) => {
    const artifactPath = path.join(workDir, "artifact");
    await exportArtifact(artifactPath);
    await fsp.writeFile(path.join(workDir, "checkpoint.json"), JSON.stringify(metadata));

    const result = await runTar(
      TarCli.create(path.basename(destPath), workDir, ["checkpoint.json", "artifact"]),
      ARCHIVE_TAR_TIMEOUT_MS,
      path.dirname(destPath),
    );
    if (result.exitCode !== 0) {
      throw new BackendError(
        `tar could not create checkpoint archive '${destPath}' (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  });
}

/**
 * Extracts `srcPath` into a fresh temp directory, parses and validates
 * `checkpoint.json` (see `parseCheckpointArchiveMetadata`), confirms the
 * `artifact` member is present, then hands both to `importArtifact` — the
 * caller's own backend/registry validation and `importCheckpoint` call —
 * before the temp directory is removed in a `finally`. `srcPath` not
 * existing, or not being a valid tar, or missing its `checkpoint.json`
 * member each throw `MalformedCheckpointArchiveError` naming `srcPath`
 * itself, before any backend call.
 */
export async function readCheckpointArchive<T>(
  srcPath: string,
  importArtifact: (metadata: CheckpointArchiveMetadata, artifactPath: string) => Promise<T>,
): Promise<T> {
  const exists = await fsp
    .stat(srcPath)
    .then((s) => s.isFile())
    .catch(() => false);
  if (!exists) {
    throw new MalformedCheckpointArchiveError(srcPath, "the file does not exist");
  }

  return withTempDir("rightsize-checkpoint-import-", async (workDir) => {
    const extracted = await runTar(
      TarCli.extract(path.basename(srcPath), workDir),
      ARCHIVE_TAR_TIMEOUT_MS,
      path.dirname(srcPath),
    );
    if (extracted.exitCode !== 0) {
      throw new MalformedCheckpointArchiveError(srcPath, `not a valid tar archive: ${extracted.stderr.trim()}`);
    }

    let text: string;
    try {
      text = await fsp.readFile(path.join(workDir, "checkpoint.json"), "utf8");
    } catch {
      throw new MalformedCheckpointArchiveError(srcPath, "missing checkpoint.json");
    }
    const metadata = parseCheckpointArchiveMetadata(text, srcPath);

    const artifactPath = path.join(workDir, "artifact");
    const hasArtifact = await fsp
      .stat(artifactPath)
      .then(() => true)
      .catch(() => false);
    if (!hasArtifact) {
      throw new MalformedCheckpointArchiveError(srcPath, "missing artifact");
    }

    return importArtifact(metadata, artifactPath);
  });
}
