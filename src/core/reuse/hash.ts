import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";

/**
 * The reuse-relevant subset of a container's builder state — everything
 * that busts identity if it changes, and nothing else (host ports, the
 * process's `RunId`, network topology, and `readOnly` are all deliberately
 * absent). This is the cross-language contract: a Kotlin or Rust rightsize
 * process hashing the "same" logical spec must reach the identical digest,
 * so every field here, and the canonical form `reuseHash` builds from it,
 * is part of the wire format, not an implementation detail.
 */
export interface ReuseIdentitySpec {
  readonly image: string;
  /** Array of pairs, not a Map — mirrors `ContainerSpec.env`. Order does not affect the hash (canonicalized by sorting on key). */
  readonly env: ReadonlyArray<readonly [string, string]>;
  /** `undefined` and `[]` hash identically — both mean "no command override". */
  readonly command: ReadonlyArray<string> | undefined;
  /** Order does not affect the hash (canonicalized by sorting ascending). */
  readonly exposedPorts: ReadonlyArray<number>;
  readonly memoryLimitMb: number | undefined;
  /** Order does not affect the hash (canonicalized by sorting on `guestPath`); content is hashed from `hostPath` at call time. */
  readonly copies: ReadonlyArray<{ readonly guestPath: string; readonly hostPath: string }>;
  /** Treated exactly like `memoryLimitMb`: unset never affects the hash, a value always does. */
  readonly diskLimitMb: number | undefined;
  /** Treated exactly like `memoryLimitMb`: unset never affects the hash, a value always does. */
  readonly tmpfsRootMb: number | undefined;
  /** Treated exactly like `memoryLimitMb`: `false` never affects the hash, `true` always does. */
  readonly networkDisabled: boolean;
}

interface CanonicalCopy {
  readonly guestPath: string;
  readonly sha256: string;
}

interface CanonicalForm {
  readonly image: string;
  readonly env: Record<string, string>;
  readonly command: ReadonlyArray<string>;
  readonly exposedPorts: ReadonlyArray<number>;
  readonly memoryLimitMb: number | null;
  readonly copies: ReadonlyArray<CanonicalCopy>;
  // Omitted entirely (not present as null/false) when unset, so a spec that
  // never touches these three keeps hashing exactly as it did before they
  // existed — see the pinned cross-language vector in hash.test.ts.
  readonly diskLimitMb?: number;
  readonly tmpfsRootMb?: number;
  readonly networkDisabled?: true;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function hashFileContent(hostPath: string): Promise<string> {
  const content = await fsp.readFile(hostPath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Builds the canonical JSON serialization the spec pins: a fixed key order
 * (`image, env, command, exposedPorts, memoryLimitMb, copies`), env as an
 * object with keys inserted in sorted order, `command` normalized to `[]`
 * when unset, ports sorted ascending, `memoryLimitMb` normalized to `null`
 * when unset, and copies sorted by `guestPath` with each entry's content
 * read from `hostPath` and hashed. `diskLimitMb`/`tmpfsRootMb`/
 * `networkDisabled` are appended only when set — a spec that never touches
 * them serializes identically to one from before these fields existed. No
 * whitespace — plain `JSON.stringify` already produces none.
 */
async function canonicalize(spec: ReuseIdentitySpec): Promise<CanonicalForm> {
  const env: Record<string, string> = {};
  for (const [key, value] of [...spec.env].sort(([a], [b]) => compareStrings(a, b))) {
    env[key] = value;
  }

  const copies = await Promise.all(
    spec.copies.map(async (copy) => ({
      guestPath: copy.guestPath,
      sha256: await hashFileContent(copy.hostPath),
    })),
  );
  copies.sort((a, b) => compareStrings(a.guestPath, b.guestPath));

  return {
    image: spec.image,
    env,
    command: spec.command ?? [],
    exposedPorts: [...spec.exposedPorts].sort((a, b) => a - b),
    memoryLimitMb: spec.memoryLimitMb ?? null,
    copies,
    ...(spec.diskLimitMb !== undefined ? { diskLimitMb: spec.diskLimitMb } : {}),
    ...(spec.tmpfsRootMb !== undefined ? { tmpfsRootMb: spec.tmpfsRootMb } : {}),
    ...(spec.networkDisabled ? { networkDisabled: true as const } : {}),
  };
}

/**
 * sha256 over the canonical JSON serialization of `spec`'s reuse-relevant
 * fields, as a lowercase hex digest — identical across every rightsize
 * language implementation for the same logical spec (see the feature spec's
 * pinned contract vector, asserted against this function in `hash.test.ts`).
 */
export async function reuseHash(spec: ReuseIdentitySpec): Promise<string> {
  const canonical = await canonicalize(spec);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** `rz-reuse-<first 12 hex chars of hash>` — the reuse sandbox naming convention (addendum). */
export function reuseName(hash: string): string {
  return `rz-reuse-${hash.slice(0, 12)}`;
}
