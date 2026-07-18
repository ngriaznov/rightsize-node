import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { ContainerSpec } from "../model.js";
import { requireValidCheckpointName } from "./name.js";

/**
 * The reduced, cross-language-pinned subset of `ContainerSpec` a named
 * checkpoint's registry entry carries — exactly the fields
 * `GenericContainer.fromCheckpoint()` actually reads (env, command, exposed
 * ports, memory limit), never the rest (name, image, host ports, mounts,
 * network topology, `runId`, `keepAlive`). Field names and shapes are part
 * of the wire format: `env` as a plain object (not an array of pairs, unlike
 * `ContainerSpec.env`), `command` as an array or `null` (never `undefined` —
 * JSON has no `undefined`), `exposedPorts` as guest ports only.
 */
export interface CheckpointRegistrySpec {
  readonly env: Record<string, string>;
  readonly command: ReadonlyArray<string> | null;
  readonly exposedPorts: ReadonlyArray<number>;
  readonly memoryLimitMb: number | null;
}

/**
 * One `checkpoints/<name>.json` record: written atomically only after the
 * backend checkpoint it describes has actually succeeded, and read by
 * `Checkpoints.find`/`list`/`remove` in this process or a later one. Every
 * field here is part of the cross-language contract pinned by the
 * named-checkpoints spec — a Kotlin or Rust process must be able to parse
 * exactly this shape.
 */
export interface CheckpointRegistryEntry {
  readonly name: string;
  readonly ref: string;
  /** The backend that created this checkpoint (e.g. `"microsandbox"`, `"docker"`) — `find`/`remove` only probe/touch the artifact when this matches the CURRENTLY active backend. */
  readonly backend: string;
  readonly createdIso: string;
  readonly spec: CheckpointRegistrySpec;
}

/** `<cacheDir>/checkpoints` — the directory every named checkpoint's registry file lives under. */
export function checkpointsDir(cacheDir: string): string {
  return path.join(cacheDir, "checkpoints");
}

/**
 * `checkpoints/<name>.json`. Validates `name` against
 * `CHECKPOINT_NAME_PATTERN` itself (throwing `InvalidCheckpointNameError` on
 * a miss) rather than trusting every caller to have done so already — this
 * is the one function every registry read/write ultimately funnels through
 * to build a path, so a defensive check here is what stands between a `../`
 * name and a path that escapes `checkpoints/` even if some future caller
 * forgets `requireValidCheckpointName` at its own boundary.
 */
export function checkpointRegistryPath(cacheDir: string, name: string): string {
  requireValidCheckpointName(name);
  return path.join(checkpointsDir(cacheDir), `${name}.json`);
}

/** Structural validator for `CheckpointRegistrySpec` — also the shape a checkpoint archive's `checkpoint.json` `spec` field must match, see `checkpoint/archive.ts`. */
export function isCheckpointRegistrySpec(value: unknown): value is CheckpointRegistrySpec {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const rec = value as Record<string, unknown>;

  const env = rec["env"];
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    return false;
  }
  if (!Object.values(env as Record<string, unknown>).every((v) => typeof v === "string")) {
    return false;
  }

  const command = rec["command"];
  if (command !== null && !(Array.isArray(command) && command.every((c) => typeof c === "string"))) {
    return false;
  }

  const exposedPorts = rec["exposedPorts"];
  if (!Array.isArray(exposedPorts) || !exposedPorts.every((p) => typeof p === "number")) {
    return false;
  }

  const memoryLimitMb = rec["memoryLimitMb"];
  if (memoryLimitMb !== null && typeof memoryLimitMb !== "number") {
    return false;
  }

  return true;
}

function isCheckpointRegistryEntry(value: unknown): value is CheckpointRegistryEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  if (
    typeof rec["name"] !== "string" ||
    typeof rec["ref"] !== "string" ||
    typeof rec["backend"] !== "string" ||
    typeof rec["createdIso"] !== "string"
  ) {
    return false;
  }
  return isCheckpointRegistrySpec(rec["spec"]);
}

/** The three outcomes reading a registry file can settle to — corrupt is deliberately distinct from missing, since `find`/`remove` react differently to each (see their own docs). */
export type CheckpointRegistryReadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "found"; readonly entry: CheckpointRegistryEntry };

/**
 * Reads and parses `checkpoints/<name>.json`. `"missing"` means the file
 * does not exist at all; `"corrupt"` means it exists but isn't a well-shaped
 * `CheckpointRegistryEntry` — malformed JSON or a missing/mistyped required
 * field. An invalid `name` (see `checkpointRegistryPath`) throws
 * `InvalidCheckpointNameError` rather than resolving `"missing"` — the path
 * is resolved BEFORE the file-read `try`, so that throw is never mistaken
 * for an ordinary "no file here" miss.
 */
export async function readCheckpointRegistry(cacheDir: string, name: string): Promise<CheckpointRegistryReadResult> {
  const registryPath = checkpointRegistryPath(cacheDir, name);
  let text: string;
  try {
    text = await fsp.readFile(registryPath, "utf8");
  } catch {
    return { kind: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "corrupt" };
  }
  if (!isCheckpointRegistryEntry(parsed)) {
    return { kind: "corrupt" };
  }
  return { kind: "found", entry: parsed };
}

/**
 * Atomically writes `checkpoints/<name>.json` (tmp file + rename, the same
 * protocol as the reuse registry's `writeRegistryAtomic` and the reaping
 * ledger's `writeRunRecord`) — called once, only after the backend
 * checkpoint this entry describes has already succeeded. A concurrent reader
 * only ever observes either the previous complete file (if this is a
 * replace) or this one, never a partial write.
 */
export async function writeCheckpointRegistryAtomic(cacheDir: string, name: string, entry: CheckpointRegistryEntry): Promise<void> {
  const dir = checkpointsDir(cacheDir);
  await fsp.mkdir(dir, { recursive: true });
  const target = checkpointRegistryPath(cacheDir, name);
  const tmp = path.join(dir, `.${name}.json.tmp-${process.pid}-${Date.now()}`);
  await fsp.writeFile(tmp, JSON.stringify(entry));
  await fsp.rename(tmp, target);
}

/** Best-effort delete of `checkpoints/<name>.json`. A file already gone is not an error. */
export async function removeCheckpointRegistryFile(cacheDir: string, name: string): Promise<void> {
  await fsp.unlink(checkpointRegistryPath(cacheDir, name)).catch(() => {});
}

/**
 * Every checkpoint name with a registry file on disk, derived from the
 * directory listing itself (not from parsing) — includes names whose file
 * turns out to be corrupt; `Checkpoints.list()` filters those out itself
 * after reading each one. Excludes the atomic-write tmp files (`.<name>.json.tmp-...`),
 * which sort before their target thanks to the leading dot but are never a
 * real entry. `checkpoints/` not existing yet (nothing ever checkpointed
 * with a name) is not an error — resolves to an empty list.
 */
export async function listCheckpointNames(cacheDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(checkpointsDir(cacheDir));
  } catch {
    return [];
  }
  return entries.filter((f) => f.endsWith(".json") && !f.startsWith(".")).map((f) => f.slice(0, -".json".length));
}

/** The inverse of the env part of `toCheckpointRegistrySpec`: `Record<string,string>` back to the array-of-pairs shape `ContainerSpec.env` uses. */
function envRecordToPairs(env: Record<string, string>): Array<readonly [string, string]> {
  return Object.entries(env);
}

/**
 * The write-side projection: `handle.spec` (a full `ContainerSpec`) down to
 * the reduced, pinned shape the registry persists. `undefined` fields
 * normalize to `null` (JSON has no `undefined`); `ports` keeps only the
 * guest side (the source container's own host ports are never meaningful to
 * a later restore, which allocates fresh ones).
 */
export function toCheckpointRegistrySpec(spec: ContainerSpec): CheckpointRegistrySpec {
  const env: Record<string, string> = {};
  for (const [key, value] of spec.env) {
    env[key] = value;
  }
  return {
    env,
    command: spec.command ?? null,
    exposedPorts: spec.ports.map((p) => p.guestPort),
    memoryLimitMb: spec.memoryLimitMb ?? null,
  };
}

/**
 * The read-side counterpart: reconstructs a `ContainerSpec`-shaped object
 * from a persisted `CheckpointRegistryEntry`, for handing back as a
 * `Checkpoint`'s `spec` from `Checkpoints.find`/`list` (which never held the
 * source container's actual `ContainerSpec`, only what the registry
 * persisted). Only the four fields `GenericContainer.fromCheckpoint()`
 * itself reads — `env`, `command`, `ports` (guest side only), and
 * `memoryLimitMb` — carry real information; every other field is a stable
 * placeholder, since the registry never persists it. `checkpointRef` mirrors
 * what a live backend hands back after its own reboot-from-snapshot cycle:
 * pointing at itself.
 */
export function fromCheckpointRegistryEntry(entry: CheckpointRegistryEntry): ContainerSpec {
  return {
    name: entry.name,
    image: entry.ref,
    env: envRecordToPairs(entry.spec.env),
    command: entry.spec.command ?? undefined,
    ports: entry.spec.exposedPorts.map((guestPort) => ({ hostPort: 0, guestPort })),
    mounts: [],
    networkId: undefined,
    aliases: [],
    runId: "",
    memoryLimitMb: entry.spec.memoryLimitMb ?? undefined,
    keepAlive: false,
    checkpointRef: entry.ref,
  };
}
