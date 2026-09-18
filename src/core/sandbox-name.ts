import { RunId } from "./run-id.js";

/**
 * The ONE sequence counter behind every `rz-<RunId.value>-<n>` sandbox name
 * this process ever mints. Two callers share it: `GenericContainer.start()`'s
 * own per-attempt boot loop (an ordinary create), and
 * `MsbCliBackend.createCheckpoint`'s post-snapshot reboot (see its own doc on
 * why that reboot now mints a fresh name rather than reusing the source
 * sandbox's own). A second, independently-seeded counter in either caller
 * would risk minting the same `rz-<RunId.value>-<n>` twice under this
 * process's one `RunId` — colliding with a still-live sibling sandbox from
 * the other caller — so both import this instead of keeping their own.
 */
let sequence = 0;

/** Mints the next `rz-<RunId.value>-<n>` sandbox name, `n` starting at 1. */
export function nextSandboxName(): string {
  sequence += 1;
  return `rz-${RunId.value}-${sequence}`;
}
