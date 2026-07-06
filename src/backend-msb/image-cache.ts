/**
 * True if `output` (an early-exited `msb run` child's combined stdout/stderr)
 * names msb's image cache error: a manifest/layer index entry pointing at a
 * cache file that isn't on disk. Observed verbatim against a real msb 0.6.3
 * binary:
 *
 * ```
 * error: image error: cache error at /path/to/.microsandbox/cache/layers/sha256_<64hex>.tar.gz: No such file or directory (os error 2)
 * ```
 *
 * Root cause, reproduced by racing concurrent `msb run`/`msb pull` of images
 * that share a base layer against one fresh cache: two pulls converting the
 * same shared blob race, and the loser's read of the shared `.tar.gz` finds
 * it already deleted by the winner's post-conversion cleanup. Confirmed
 * order-independent: across ten trials of three concurrent pulls, seven
 * reproduced the error, naming each image as the victim at least once. Never
 * reproduces sequentially.
 *
 * Deliberately a substring match on the stable parts of msb's wording
 * ("cache error at", "No such file") rather than the full sentence — the path
 * and digest vary per host/image, and msb has no structured/typed error for
 * this.
 */
export function isImageCacheCorruption(output: string): boolean {
  return output.includes("cache error at") && output.includes("No such file");
}
