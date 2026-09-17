/**
 * True if `output` (an `msb restore` invocation's combined stdout/stderr)
 * names msb's own sandbox-name collision refusal — msb refuses to create a
 * second sandbox under a name it already has one for. Captured shape:
 *
 * ```text
 * error: sandbox 'rz-abc-1' already exists
 * ```
 *
 * EMPIRICALLY VERIFIED against msb 0.7.1's own source
 * (`prepare_create_target` in `sdk/rust/lib/backend/local/sandbox/create.rs`):
 * the check is `existing.is_some() || dir_exists` — the refusal fires when
 * EITHER the sandbox's database record still exists OR its on-disk directory
 * does, two independent things that can each still be mid-release on
 * Windows. `MsbCliBackend.createCheckpoint`'s own stop/snapshot/`rm`/restore
 * cycle removes the source sandbox and immediately restores a fresh one
 * under the SAME name, so a lingering release on either side races the very
 * next `restore` straight into this refusal.
 *
 * Deliberately a broad, case-insensitive substring match (mirrors this
 * backend's own `isPortBindConflictOutput`, and the sibling classifiers this
 * whole family of msb backends — rust, kotlin — use for the identical
 * signature) rather than a strict parse: msb has no structured/typed error
 * for this, only combined process output, and a collision can be worded
 * around either the sandbox's name or (rarely, alternate msb builds) its
 * dedicated "already in use" phrasing. Only ever checked against a
 * `msb restore` invocation's own output — a `msb snapshot load` "already
 * exists" (see `isSnapshotAlreadyExistsError`) is a completely different
 * command and never appears here.
 */
export function isSandboxAlreadyExistsFailure(output: string): boolean {
  const m = output.toLowerCase();
  return m.includes("already exists") || (m.includes("already in use") && m.includes("name"));
}
