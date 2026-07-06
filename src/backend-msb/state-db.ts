/**
 * True if `output` (an early-exited `msb run` child's combined stdout/stderr)
 * names msb's startup-migration race: every msb invocation runs schema
 * migrations against the shared SQLite state database on startup, and two
 * concurrent invocations can race them — the loser dies before doing any
 * work. Observed verbatim against the real msb 0.6.3 Windows binary:
 *
 * ```
 * error: database error: Execution Error: error returned from database: (code: 1) index idx_manifest_layers_unique already exists
 * ```
 *
 * and, from the same underlying race, the shape that first surfaced it:
 * `UNIQUE constraint failed: seaql_migrations.version`.
 *
 * A boot is never inherently alone even under fully serialized tests: the
 * attached `msb run` child races the backend's own `msb ls` readiness
 * polling (and, on Windows, an active log poller). Transient by
 * construction — the winner's migration completes and every later invocation
 * finds the schema already in place — so the caller retries the boot exactly
 * once rather than surfacing it.
 *
 * Deliberately a substring match on the stable parts of msb's wording — the
 * index/constraint being raced varies with which migration statement loses,
 * and msb has no structured/typed error for this.
 */
export function isMsbMigrationRace(output: string): boolean {
  return (
    output.includes("database error") &&
    (output.includes("already exists") || output.includes("UNIQUE constraint failed"))
  );
}
