/**
 * True if `output` (an `msb snapshot inspect <ref>` non-zero exit's stderr)
 * names msb's own "this snapshot does not exist" signal, as opposed to some
 * other probe failure. Two framings, both seen from a real msb:
 *
 * ```
 * error: snapshot not found: <path>
 * error: io error: No such file or directory (os error 2)
 * ```
 *
 * The first is 0.6.8's wording; the second is what 0.8.1 prints for a
 * missing bare group name or a missing member. The middle text of the second
 * is localized on Windows, so it is matched as `io error` plus `(os error 2)`.
 *
 * Only these framings may resolve `hasCheckpoint` to `false` — every other
 * non-zero exit (a corrupted state db, a permission error, a malformed
 * argument, an msb crash) must propagate as a thrown error instead.
 * `Checkpoints.find` reacts to a `false` probe by best-effort deleting the
 * registry entry as stale, so collapsing an unrelated, possibly transient
 * msb failure into `false` here would silently evict a perfectly valid named
 * checkpoint from the registry — exactly the "best-effort false on probe
 * errors" the SPI's own contract forbids.
 *
 * Deliberately a substring match on the stable prefix rather than the full
 * sentence — the trailing path varies per host, and msb has no structured/
 * typed error for this, the same reasoning `isImageCacheCorruption` and
 * `isMsbStateDbError` apply to their own wordings.
 */
export function isSnapshotNotFoundError(output: string): boolean {
  const lower = output.toLowerCase();
  return lower.includes("snapshot not found") || (lower.includes("io error") && lower.includes("(os error 2)"));
}
