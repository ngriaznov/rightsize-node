import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { cacheDir } from "../cache-dir.js";

/**
 * Mints the backend-specific checkpoint ref: an absolute
 * `<cacheDir>/checkpoints/rz-ckpt-<suffix>` path on microsandbox,
 * `rightsize/checkpoint:<suffix>` elsewhere. The microsandbox ref is a path
 * because `createCheckpoint` there stores the snapshot artifact under the
 * cache dir via `--dest-dir` rather than msb's own default snapshot store —
 * see `MsbCliBackend`. A ref is only ever opaque to callers either way; the
 * path shape is not part of the public checkpoint contract. `name` present
 * (a NAMED checkpoint) makes the suffix — and therefore the whole ref —
 * deterministic: re-checkpointing the same name reproduces the exact same
 * ref, which is what makes the registry's replace semantics (remove the old
 * artifact under this ref, then create the new one) correct. `name`
 * `undefined` mints a fresh random 12-hex suffix instead, byte-for-byte the
 * pre-named-checkpoints behavior.
 */
export function checkpointRef(backendName: string, name: string | undefined): string {
  const suffix = name ?? randomBytes(6).toString("hex");
  if (backendName === "microsandbox") {
    return path.join(cacheDir(), "checkpoints", `rz-ckpt-${suffix}`);
  }
  return `rightsize/checkpoint:${suffix}`;
}
