/**
 * The line msb's guest agent writes to a sandbox's SYSTEM log (`msb logs
 * <name> --source system`) once it has actually come up — as distinct from
 * the attached `msb run` process's own exit, which can happen for reasons
 * that never got the guest agent running at all. Captured verbatim against
 * the real msb 0.6.15 binary.
 *
 * This is the second of two signals `MsbCliBackend.bootOnce`'s post-mortem
 * classification requires (alongside the sandbox's own state settling on
 * exactly `"Stopped"`, see `statusOf` in `./ls-json.js`) before trusting a
 * clean (`exit 0`) attached-process exit that happened before Running was
 * ever observed as "the workload ran to completion" rather than a genuinely
 * dead boot. msb 0.6.16's convergent-lifecycle rework means a
 * fast-completing workload's sandbox is only ever observed `"Starting"`,
 * never `"Running"` — the earlier releases' `"Running"` sighting for a fast
 * workload was itself a race a fast host happened to win, and 0.6.16 closed
 * it — so `exit 0` alone stopped being sufficient signal the moment that
 * shipped. The historical agentless-death failures (msb 0.6.10-0.6.13 on
 * Windows) also exited 0 without ever reaching Running, but never produced
 * this marker, because the guest agent that writes it never came up in
 * those failures — exactly the distinction this exists to draw.
 */
export const SANDBOX_STARTED_MARKER = "--- sandbox started ---";

/**
 * True if `systemLog` (an `msb logs <name> --source system` invocation's
 * stdout) carries the boot-completion marker — see `SANDBOX_STARTED_MARKER`.
 */
export function hasSandboxStartedMarker(systemLog: string): boolean {
  return systemLog.includes(SANDBOX_STARTED_MARKER);
}
