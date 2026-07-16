import { InvalidCheckpointNameError } from "../errors.js";

/**
 * Pinned identically across every rightsize language implementation (see the
 * named-checkpoints spec's own "Names and refs" section): lowercase letters,
 * digits, and hyphens only, starting with a letter or digit, at most 41
 * characters. This is also exactly the alphabet both backends' ref formats
 * embed verbatim (`rz-ckpt-<name>`, `rightsize/checkpoint:<name>`), so a
 * valid name is guaranteed to produce a valid ref on either backend.
 */
export const CHECKPOINT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** Fails fast — before any backend or filesystem call — on a `name` that doesn't match `CHECKPOINT_NAME_PATTERN`. */
export function requireValidCheckpointName(name: string): void {
  if (!CHECKPOINT_NAME_PATTERN.test(name)) {
    throw new InvalidCheckpointNameError(name);
  }
}
