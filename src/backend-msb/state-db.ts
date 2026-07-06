/**
 * True if `output` (an early-exited `msb run` child's combined stdout/stderr)
 * names a failure of msb's own shared SQLite state database. Every msb
 * invocation runs schema migrations against it on startup, and two concurrent
 * invocations can race them — the loser dies before doing any work, with
 * whatever wording matches the migration statement it lost on. Observed
 * verbatim against the real msb 0.6.3 Windows binary, one race, three shapes:
 *
 * ```
 * error: database error: Execution Error: error returned from database: (code: 1) index idx_manifest_layers_unique already exists
 * error: database error: Execution Error: error returned from database: (code: 1) duplicate column name: kind
 * ```
 *
 * plus the shape that first surfaced it: `UNIQUE constraint failed:
 * seaql_migrations.version`. Chasing individual wordings is a losing game —
 * the stable part is msb's own `error: database error:` prefix, which is
 * always msb's state database and never the workload (a workload's stderr
 * never carries msb's `error:` framing).
 *
 * A boot is never inherently alone even under fully serialized tests: the
 * attached `msb run` child races the backend's own `msb ls` readiness polling
 * (and, on Windows, an active log poller). The migration race is transient by
 * construction — the winner's migration commits and every later invocation
 * finds the schema in place — so the caller retries the boot exactly once.
 * For a state-database failure that is NOT the race (say, real corruption),
 * the one-shot retry costs a moment and then propagates the failure with both
 * attempts' output.
 */
export function isMsbStateDbError(output: string): boolean {
  return output.includes("error: database error:");
}
