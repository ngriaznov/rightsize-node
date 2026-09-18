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
 * snapshot artifact (or the block device backing the restored sandbox
 * itself — unix's twin of this same class of failure is a block-device open
 * `PermissionDenied`, os error 13) can still be mid-release by the OS for a
 * brief window right after the process that wrote it (or the one that just
 * stopped the source sandbox) exits. Retrying the SAME `--name` does not
 * simply wait that lag out, though: EMPIRICALLY VERIFIED against a real msb
 * 0.7.1 binary, this failure happens AFTER msb's own artifact validation —
 * which leaves `--name` behind as a STOPPED SANDBOX RECORD — so a same-name
 * retry collides with msb's own restore-time collision check immediately,
 * rather than ever getting a second shot at the transient (see
 * `MsbCliBackend`'s own doc on `CHECKPOINT_REBOOT_ALREADY_EXISTS_RETRY_BUDGET_MS`
 * for the full live-verified account). `MsbCliBackend.retryRestoreAfterAccessDenied`
 * (the ordinary `start()`/`fromCheckpoint().start()` path) and
 * `MsbCliBackend.rebootUnderFreshName` (`createCheckpoint`'s own reboot)
 * both retry a restore that hits this a bounded number of times, each under
 * a FRESH name rather than the one that just failed (see
 * `RESTORE_ACCESS_DENIED_RETRY_LIMIT`/`RESTORE_ACCESS_DENIED_RETRY_DELAY_MS`
 * for the former's own budget/delay) rather than surfacing it as an
 * ordinary restore failure on the first hit.
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
