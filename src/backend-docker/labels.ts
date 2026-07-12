import { createHash } from "node:crypto";

/**
 * The label key every non-`keepAlive` container this backend creates
 * carries, so `close()` and the reaper can find exactly this run's
 * containers without touching anyone else's. The literal wire-format string
 * is part of the library's external contract: any tool or process that
 * filters on this label sees consistent labels regardless of which
 * rightsize release created them.
 */
export const RUN_ID_LABEL_KEY = "dev.rightsize.runId";

/**
 * The label key a `keepAlive` (reuse) container carries INSTEAD of
 * `RUN_ID_LABEL_KEY` — see `containerLabels`. Never matched by
 * `labelFilterQuery`, so a reuse container is structurally invisible to
 * `close()`'s own-run cleanup and to any other run's label-scoped removal.
 */
export const REUSE_LABEL_KEY = "dev.rightsize.reuse";

/** The `filters` query-string value for `GET /containers/json?filters=...`, scoped to one run id's label. */
export function labelFilterQuery(runId: string): string {
  return JSON.stringify({ label: [`${RUN_ID_LABEL_KEY}=${runId}`] });
}

/** First 12 hex characters of `name`'s sha256 — the `<12hex>` reuse-label value format (mirrors the `rz-reuse-<12hex-of-hash>` naming the addendum defines for reuse containers). */
function reuseLabelValue(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 12);
}

/**
 * The `Labels` a container gets at `POST /containers/create` time: the
 * run-id label for a normal container, so `close()`'s own-run cleanup and a
 * later run's label-scoped sweep can find it — or, for a `keepAlive` (reuse)
 * container, `REUSE_LABEL_KEY=<12hex>` INSTEAD, so it never carries the
 * run-id label and is therefore invisible to both of those label-filtered
 * queries. `GenericContainer`'s reuse builder is the one caller that sets
 * `keepAlive: true` (see `buildReuseSpec`).
 */
export function containerLabels(spec: { readonly keepAlive: boolean; readonly runId: string; readonly name: string }): Record<string, string> {
  if (spec.keepAlive) {
    return { [REUSE_LABEL_KEY]: reuseLabelValue(spec.name) };
  }
  return { [RUN_ID_LABEL_KEY]: spec.runId };
}
