import { randomBytes } from "node:crypto";

/**
 * Mints the backend-specific checkpoint ref: `rz-ckpt-<suffix>` on
 * microsandbox, `rightsize/checkpoint:<suffix>` elsewhere. `name` present
 * (a NAMED checkpoint) makes the suffix — and therefore the whole ref —
 * deterministic: re-checkpointing the same name reproduces the exact same
 * ref, which is what makes the registry's replace semantics (remove the old
 * artifact under this ref, then create the new one) correct. `name`
 * `undefined` mints a fresh random 12-hex suffix instead, byte-for-byte the
 * pre-named-checkpoints behavior.
 */
export function checkpointRef(backendName: string, name: string | undefined): string {
  const suffix = name ?? randomBytes(6).toString("hex");
  return backendName === "microsandbox" ? `rz-ckpt-${suffix}` : `rightsize/checkpoint:${suffix}`;
}
