import * as path from "node:path";

/**
 * True if `stderr` (an `msb snapshot import` non-zero exit) names msb's own
 * "this digest is already imported" signal, as opposed to some other import
 * failure. Observed verbatim against the real msb 0.6.6 binary:
 *
 * ```
 * error: snapshot already exists: <path>
 * ```
 *
 * For a content-addressed archive this IS success — the artifact is already
 * present under that digest either way — so `importCheckpoint` treats it as
 * one rather than surfacing it. Deliberately a substring match on the stable
 * prefix, the same reasoning `isSnapshotNotFoundError` applies to its own
 * wording: the trailing path varies per host and msb has no structured/typed
 * error for this.
 */
export function isSnapshotAlreadyExistsError(stderr: string): boolean {
  return stderr.includes("snapshot already exists");
}

/**
 * Extracts the digest-dir basename from one `msb snapshot import`
 * invocation's output. Verified against the real msb 0.6.6 binary: on both a
 * success (the printed stdout line) and an already-exists failure (the
 * `error: snapshot already exists: <path>` stderr line), the relevant line
 * ENDS with the artifact path under `~/.microsandbox/snapshots/`, whose
 * basename is the digest-derived directory name (e.g.
 * `sha256-b9c0448ee9d54e33`) — never the original archive's own recorded
 * ref. Callers pass whichever stream actually carries the signal (stdout on
 * success, stderr on an already-exists failure). `undefined` means the
 * output carried no recognizable trailing path — a shape this backend
 * doesn't understand, which the caller turns into its own actionable error
 * rather than guessing.
 */
export function parseImportedDigestDirName(output: string): string | undefined {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastLine = lines.at(-1);
  if (lastLine === undefined) {
    return undefined;
  }
  const match = /(\S+)\s*$/.exec(lastLine);
  const artifactPath = match?.[1];
  return artifactPath === undefined ? undefined : path.basename(artifactPath);
}
