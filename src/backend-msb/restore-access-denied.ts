/**
 * True if `output` (an `msb restore` invocation's combined stdout+stderr)
 * carries a Windows `ERROR_ACCESS_DENIED` against the just-written snapshot
 * artifact it was asked to restore. Captured shape (mirrors
 * `isSnapshotSaveAccessDeniedFailure`'s own Windows fsync failure, a
 * sibling access-denied signature on the SAME artifact class, one step
 * earlier in the checkpoint cycle):
 *
 * ```text
 * error: io error: Access is denied. (os error 5)
 * ```
 *
 * Observed on Windows CI immediately after the source sandbox's own
 * teardown in the stop/snapshot/reboot checkpoint cycle — msb's docs
 * describe deferred file-handle release on Windows, and the just-written
 * snapshot artifact can still be mid-release by the OS for a brief window
 * right after the process that wrote it (or the one that just stopped the
 * source sandbox) exits. `MsbCliBackend.bootClassified` retries a restore
 * that hits this a bounded number of times with a short backoff (see
 * `RESTORE_ACCESS_DENIED_RETRY_LIMIT`/`RESTORE_ACCESS_DENIED_RETRY_DELAY_MS`)
 * rather than surfacing it as an ordinary restore failure on the first hit.
 *
 * Matches CONSERVATIVELY — both `"Access is denied"` (Windows' own
 * `FormatMessage` text for `ERROR_ACCESS_DENIED`, present regardless of the
 * machine's display language in every capture seen so far) AND one of
 * `"io error"` (the Rust error variant wrapping it) or `"os error 5"` (the
 * numeric errno Rust appends) must be present — reducing the chance of
 * matching some unrelated "access denied" phrasing (a genuine permission
 * error, say) that happens to share only one of the two phrases. Nothing
 * here is Windows-specific by construction — the signature simply never
 * occurs on unix, so the platform check some callers might expect isn't
 * needed at the match site — which also keeps this exercisable by unit
 * tests on any host, the same rationale `salvageStagedArchive` documents for
 * its own platform-agnostic helper.
 */
export function isRestoreAccessDeniedFailure(output: string): boolean {
  return output.includes("Access is denied") && (output.includes("io error") || output.includes("os error 5"));
}
