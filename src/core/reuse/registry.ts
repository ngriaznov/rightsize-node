import * as fsp from "node:fs/promises";
import * as path from "node:path";

/**
 * One `reuse/<hash>.json` record: written atomically after a reused
 * container's first fresh boot passes its wait strategy, and read by every
 * later `start()` (in this process or a later one) that computes the same
 * `hash` to decide whether to adopt instead of create. Every field here is
 * part of the cross-language contract — a Kotlin or Rust process must be
 * able to parse exactly this shape.
 */
export interface ReuseRegistryEntry {
  readonly name: string;
  readonly image: string;
  /** `{"<guestPort>": <hostPort>, ...}` — JSON object keys are always strings, so the guest port is stringified. */
  readonly ports: Record<string, number>;
  readonly createdIso: string;
  /** The backend name (e.g. `"microsandbox"`, `"docker"`) that created this sandbox — informational; adopt always re-verifies liveness through the CURRENTLY active backend regardless of this value. */
  readonly backend: string;
}

/** `<cacheDir>/reuse` — the directory every reuse registry file lives under. */
export function reuseDir(cacheDir: string): string {
  return path.join(cacheDir, "reuse");
}

/** `reuse/<hash>.json`. */
export function reusePath(cacheDir: string, hash: string): string {
  return path.join(reuseDir(cacheDir), `${hash}.json`);
}

function isRegistryEntry(value: unknown): value is ReuseRegistryEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  if (
    typeof rec["name"] !== "string" ||
    typeof rec["image"] !== "string" ||
    typeof rec["createdIso"] !== "string" ||
    typeof rec["backend"] !== "string"
  ) {
    return false;
  }
  const ports = rec["ports"];
  if (typeof ports !== "object" || ports === null || Array.isArray(ports)) {
    return false;
  }
  return Object.values(ports as Record<string, unknown>).every((v) => typeof v === "number");
}

/** The three outcomes reading a registry file can settle to — corrupt is deliberately distinct from missing, since the adopt path best-effort-cleans up a stale SANDBOX only for the former (see the reuse spec's stale/corrupt-registry fallback). */
export type RegistryReadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "found"; readonly entry: ReuseRegistryEntry };

/**
 * Reads and parses `reuse/<hash>.json`. `"missing"` means the file does not
 * exist at all (the common "never created yet" case); `"corrupt"` means it
 * exists but isn't a well-shaped `ReuseRegistryEntry` — malformed JSON or a
 * missing/mistyped required field — distinct from `"missing"` because the
 * adopt path's fallback behavior differs (see `hash.ts`'s sibling module doc
 * and the reuse spec).
 */
export async function readRegistry(cacheDir: string, hash: string): Promise<RegistryReadResult> {
  let text: string;
  try {
    text = await fsp.readFile(reusePath(cacheDir, hash), "utf8");
  } catch {
    return { kind: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "corrupt" };
  }
  if (!isRegistryEntry(parsed)) {
    return { kind: "corrupt" };
  }
  return { kind: "found", entry: parsed };
}

/**
 * Atomically writes `reuse/<hash>.json` (tmp file + rename, same protocol as
 * the reaping ledger's `writeRunRecord`) — called once, after a fresh reuse
 * container's wait strategy has confirmed readiness. A concurrent reader
 * only ever observes either the previous complete file or this one, never a
 * partial write.
 */
export async function writeRegistryAtomic(cacheDir: string, hash: string, entry: ReuseRegistryEntry): Promise<void> {
  const dir = reuseDir(cacheDir);
  await fsp.mkdir(dir, { recursive: true });
  const target = reusePath(cacheDir, hash);
  const tmp = path.join(dir, `.${hash}.json.tmp-${process.pid}-${Date.now()}`);
  await fsp.writeFile(tmp, JSON.stringify(entry));
  await fsp.rename(tmp, target);
}

/** Best-effort delete of `reuse/<hash>.json`. A file already gone is not an error. */
export async function removeRegistry(cacheDir: string, hash: string): Promise<void> {
  await fsp.unlink(reusePath(cacheDir, hash)).catch(() => {});
}
