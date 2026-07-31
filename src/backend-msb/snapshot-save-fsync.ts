import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * True if `stderr` (an `msb snapshot save` non-zero exit) carries a Windows
 * `ERROR_ACCESS_DENIED`, which on that platform is how EVERY `snapshot save`
 * in msb 0.6.7 and 0.6.8 ends. Captured verbatim from a windows-2025 hosted
 * runner:
 *
 * ```text
 * msb snapshot save rz-ckpt-fccd7568-archive C:\...\artifact failed (exit 1):
 * error: io error: Access is denied. (os error 5)
 * ```
 *
 * The cause is in msb's own archive writer: having finished the archive it
 * reopens the staging file READ-ONLY, then calls `sync_all()` on that handle
 * before moving it onto the destination. On Windows `sync_all` is
 * `FlushFileBuffers`, which requires write access, so it fails with error 5
 * every time and the move on the next line never runs. On Unix an `fsync` of a
 * read-only descriptor is legal, so the same code path is fine there — which
 * is why `exportCheckpoint` consults this only on Windows. 0.6.6 wrote
 * straight to the destination with no fsync step at all, hence the failure
 * being new in 0.6.7.
 *
 * Matches the `(os error 5)` suffix rather than the `Access is denied.` text:
 * that text comes from Windows' own `FormatMessage` and is localized to the
 * machine's display language, while the numeric suffix is appended by Rust
 * itself and reads the same on every host. The closing parenthesis is part of
 * the needle so that codes in the fifties — `os error 53` (network path not
 * found), `55`, `59` — cannot match on their leading digit.
 */
export function isSnapshotSaveAccessDeniedFailure(stderr: string): boolean {
  return stderr.includes("(os error 5)");
}

/**
 * Completes the move msb's archive writer failed to reach (see
 * `isSnapshotSaveAccessDeniedFailure`), resolving `true` if `destFile` now
 * holds the finished archive.
 *
 * msb stages the archive beside its destination under
 * `.<destination file name>.tmp.<msb pid>.<unix nanos>` and unlinks that
 * staging file only when the archive WRITE fails — not when the trailing fsync
 * does. So on the failure this handles, a complete, valid archive is sitting
 * next to the destination and the only step left is the rename msb's own
 * `replace_archive` would have performed on the very next line.
 *
 * Requires EXACTLY ONE candidate in the destination's parent directory. This
 * library exports into a staging directory it creates fresh and owns for the
 * one export, so a single candidate is the ordinary case; zero means the
 * archive never got written and this is a different failure, and several means
 * something else is writing there and picking one would be a guess. Both
 * resolve `false`, which leaves the caller surfacing msb's own error unchanged
 * — as does any filesystem error along the way, since msb's error describes
 * the actual problem better than a failure to clean up after it would.
 *
 * Nothing here is Windows-specific by construction; the platform check lives
 * at the call site so this stays exercisable by unit tests on any host.
 */
export async function salvageStagedArchive(destFile: string): Promise<boolean> {
  const parent = path.dirname(destFile);
  const stagingPrefix = `.${path.basename(destFile)}.tmp.`;
  try {
    const candidates = (await fs.readdir(parent, { withFileTypes: true }))
      // Regular files only: msb writes a file under the staging name, and a directory
      // carrying it would otherwise consume the single-candidate slot and then be
      // renamed onto the destination, where the archive step would bundle a directory.
      .filter((entry) => entry.name.startsWith(stagingPrefix) && entry.isFile())
      .map((entry) => entry.name);
    const only = candidates.length === 1 ? candidates[0] : undefined;
    if (only === undefined) {
      return false;
    }
    await fs.rename(path.join(parent, only), destFile);
    return true;
  } catch {
    return false;
  }
}
