/**
 * The label key every container this backend creates carries, so `close()`
 * and the reaper can find exactly this run's containers without touching
 * anyone else's. The literal wire-format string is part of the library's
 * external contract: any tool or process that filters on this label sees
 * consistent labels regardless of which rightsize release created them.
 */
export const RUN_ID_LABEL_KEY = "dev.rightsize.runId";

/** The `filters` query-string value for `GET /containers/json?filters=...`, scoped to one run id's label. */
export function labelFilterQuery(runId: string): string {
  return JSON.stringify({ label: [`${RUN_ID_LABEL_KEY}=${runId}`] });
}
