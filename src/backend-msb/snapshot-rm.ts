/**
 * True if `stderr` (an `msb snapshot rm <artifact-path> -f` non-zero exit)
 * names msb's own "this snapshot is the current head of other snapshots
 * from the same source sandbox" refusal, as opposed to a genuine "not
 * found" (which `removeCheckpoint` treats as success, the same best-effort
 * contract `removeByName` has) or some other, unrelated failure.
 * EMPIRICALLY VERIFIED against a real msb 0.7.1 binary:
 *
 * ```
 * error: invalid config: cannot remove current head snap_<digest>; first
 * select another snapshot with 'msb snapshot head src:<snapshot>'
 * ```
 *
 * Removing a non-head member, or a group's ONLY member, succeeds — this
 * refusal is specifically "older siblings from the same source sandbox
 * still exist and this is still the newest of them." `removeCheckpoint`
 * propagates this one verbatim instead of swallowing it alongside an
 * ordinary "not found": the caller has an actionable remedy (`msb snapshot
 * head ...`, named in msb's own message), and this library deliberately
 * does not attempt automatic head rotation on the caller's behalf — see the
 * checkpoints guide's cleanup section for the documented limitation.
 * Deliberately a substring match on the stable "cannot remove current head"
 * phrase, the same reasoning `isSnapshotNotFoundError` applies to its own
 * wording — the snapshot id and the exact command hint vary per occurrence,
 * and msb has no structured/typed error for this.
 */
export function isSnapshotHeadRemovalRefused(stderr: string): boolean {
  return stderr.includes("cannot remove current head");
}
