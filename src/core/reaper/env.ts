/** `RIGHTSIZE_REAPER`'s three modes: both layers, sweep only, or fully disabled. */
export type ReaperMode = "on" | "sweep" | "off";

/**
 * Parses `RIGHTSIZE_REAPER`. Unset or unrecognized values both mean `"on"` —
 * the same "unknown values are treated as the safe default" convention the
 * rest of this library's env vars follow, rather than failing a whole
 * process over a typo'd opt-out.
 */
export function reaperMode(env: Record<string, string | undefined>): ReaperMode {
  const raw = env["RIGHTSIZE_REAPER"];
  if (raw === "sweep" || raw === "off") {
    return raw;
  }
  return "on";
}

/** `sweep` and `on` both run the init-time sweep; only `off` turns it off. */
export function sweepEnabled(mode: ReaperMode): boolean {
  return mode !== "off";
}

/** Only `on` (the default) spawns the per-run watchdog process. */
export function watchdogEnabled(mode: ReaperMode): boolean {
  return mode === "on";
}
