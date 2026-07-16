/**
 * True if `output` (an `msb snapshot inspect <ref>` non-zero exit's stderr)
 * names msb's own "this snapshot does not exist" signal, as opposed to some
 * other probe failure. Observed verbatim against the real msb 0.6.6 binary:
 *
 * ```
 * error: snapshot not found: <path>
 * ```
 *
 * Only this exact framing may resolve `hasCheckpoint` to `false` — every
 * other non-zero exit (a corrupted state db, a permission error, a
 * malformed argument, an msb crash) must propagate as a thrown error
 * instead. `Checkpoints.find` reacts to a `false` probe by best-effort
 * deleting the registry entry as stale, so collapsing an unrelated,
 * possibly transient msb failure into `false` here would silently evict a
 * perfectly valid named checkpoint from the registry — exactly the
 * "best-effort false on probe errors" the SPI's own contract forbids.
 *
 * Deliberately a substring match on the stable prefix rather than the full
 * sentence — the trailing path varies per host, and msb has no structured/
 * typed error for this, the same reasoning `isImageCacheCorruption` and
 * `isMsbStateDbError` apply to their own wordings.
 */
export function isSnapshotNotFoundError(output: string): boolean {
  return output.includes("snapshot not found");
}
