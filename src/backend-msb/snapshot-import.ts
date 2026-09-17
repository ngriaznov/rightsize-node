import * as path from "node:path";

/**
 * True if `stderr` (an `msb snapshot load` non-zero exit) names msb's own
 * "this digest is already imported" signal, as opposed to some other import
 * failure. Observed verbatim against the real msb 0.6.8 binary:
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
 * error for this. Not re-verified against 0.7.1 specifically (the rename to
 * `save`/`load` did not touch this message in any captured output), so this
 * stays a defensive fallback rather than the primary success path.
 */
export function isSnapshotAlreadyExistsError(stderr: string): boolean {
  return stderr.includes("snapshot already exists");
}

/**
 * Extracts the loaded artifact's absolute path from one `msb snapshot load`
 * invocation's output — the EFFECTIVE ref `importCheckpoint` hands back.
 * EMPIRICALLY VERIFIED against a real msb 0.7.1 binary: a successful load
 * prints a `group msb-<hex>: head snap_<digest> (Initialized)` line, then a
 * digest line, then the loaded artifact's absolute path as the LAST line —
 * `<destDir>/<generated-group>/snap_<digest>`, where `<destDir>` is whatever
 * `--dest` was given (see `MsbCommands.snapshotImport`). The same defensive
 * pattern `parseSnapshotCreateArtifactPath` uses for `snapshot create`'s own
 * trailing-path output: trims the whole output, keeps only non-empty lines,
 * takes the LAST one, and requires it to be an absolute path — anything else
 * (empty output, a relative-looking last line, msb's own preceding "group"/
 * digest lines mistaken for the answer) resolves `undefined` rather than
 * guessing, so the caller fails loudly with the raw output quoted verbatim
 * instead of minting a checkpoint ref from a misread line. This replaces the
 * pre-0.7.1 approach of parsing out just the digest-dir BASENAME and then
 * confirming it via a separate `msb snapshot list` call — 0.7.1's `load`
 * already prints the full, directly-usable ref, so that second call is gone.
 *
 * The already-exists failure path (see `isSnapshotAlreadyExistsError`) has a
 * different last-line shape than a success's: msb's own message prefixes
 * the path with prose on the SAME line (`error: snapshot already exists:
 * <path>`), captured verbatim from the real 0.6.8 binary and not
 * re-verified against 0.7.1 — so a whole-line match never fires for it.
 * When the whole line isn't itself an absolute path, this falls back to the
 * line's trailing whitespace-delimited token and requires THAT to be
 * absolute instead, rather than guessing a ref out of prose.
 */
export function parseImportedArtifactPath(output: string): string | undefined {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastLine = lines.at(-1);
  if (lastLine === undefined) {
    return undefined;
  }
  if (path.isAbsolute(lastLine)) {
    return lastLine;
  }
  const trailingToken = /(\S+)\s*$/.exec(lastLine)?.[1];
  return trailingToken !== undefined && path.isAbsolute(trailingToken) ? trailingToken : undefined;
}
