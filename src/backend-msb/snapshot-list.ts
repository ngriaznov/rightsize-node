import * as path from "node:path";

/**
 * One `msb snapshot list --format json` entry, the fields
 * `importCheckpoint`'s presence check actually reads. The current msb
 * release's shape carries more fields than this (created/size/...); only
 * `digest`, `name`, and `artifact_path` (snake_case on the wire) matter
 * here, so everything else is ignored rather than modeled. `digest` itself
 * is never returned as an effective ref (see `confirmDigestDirNamePresent`)
 * — it is read only to skip a malformed/empty entry.
 */
export interface SnapshotListEntry {
  readonly digest: string | undefined;
  readonly name: string | undefined;
  readonly artifactPath: string | undefined;
}

/**
 * Parses `msb snapshot list --format json`'s array-of-objects output.
 * Malformed/non-array JSON resolves to an empty list rather than throwing —
 * the caller (`importCheckpoint`) already turns "digest not found" into its
 * own actionable `BackendError`, so a parse failure here degrading to "found
 * nothing" produces the same class of error rather than a confusing crash
 * one level removed from the actual msb output.
 */
export function parseSnapshotList(json: string): SnapshotListEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.map((raw): SnapshotListEntry => {
    const rec = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    return {
      digest: typeof rec["digest"] === "string" ? rec["digest"] : undefined,
      name: typeof rec["name"] === "string" ? rec["name"] : undefined,
      artifactPath: typeof rec["artifact_path"] === "string" ? rec["artifact_path"] : undefined,
    };
  });
}

/**
 * Confirms an imported snapshot's digest-dir basename (e.g.
 * `sha256-b9c0448ee9d54e33`, parsed from `msb snapshot import`'s own
 * output — see `snapshot-import.ts`) actually appears in `msb snapshot
 * list`: an entry whose `name` equals `digestDirName` outright, or whose
 * `artifact_path`'s basename does (`msb snapshot list` was verified to
 * report both shapes depending on how the snapshot was created).
 *
 * Returns `digestDirName` itself once confirmed present — NOT the entry's
 * `digest` field. Live-verified against msb 0.6.6: the full
 * `sha256:<64hex>` digest does not resolve as a snapshot ref at all (`msb
 * snapshot inspect sha256:<full>` fails "snapshot not found" — msb treats
 * it as a literal path). Only the digest-dir name resolves for
 * `inspect`/`rm`/`run --snapshot`, so it — not the `digest` field — is the
 * effective ref `importCheckpoint` must hand back. `undefined` means no
 * entry matched — the caller throws rather than returning an unconfirmed
 * ref.
 */
export function confirmDigestDirNamePresent(entries: readonly SnapshotListEntry[], digestDirName: string): string | undefined {
  const present = entries.some(
    (entry) =>
      entry.digest !== undefined &&
      (entry.name === digestDirName || (entry.artifactPath !== undefined && path.basename(entry.artifactPath) === digestDirName)),
  );
  return present ? digestDirName : undefined;
}
