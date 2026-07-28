/**
 * True if `stderr` (an `msb exec` invocation's stderr) says msb could not reach the
 * in-guest agent's endpoint at all, as distinct from the guest command itself failing.
 *
 * A sandbox shows `"Running"` — the same status word `runningSandboxNames` polls for
 * — before the in-guest agent has necessarily created the endpoint `msb exec` connects
 * to. That gap is ordinarily invisible: every module's wait strategy blocks on a log
 * line, an HTTP probe, or a port before anything execs, and by then the endpoint has
 * long since appeared. A caller that starts a sandbox and execs immediately has no
 * such buffer, and on Windows — where the endpoint is a named pipe rather than a unix
 * socket — loses the race outright:
 *
 * ```text
 * error: agent client error: connect \\.\pipe\msb-agent-<id>: The system cannot find
 * the file specified. (os error 2)
 * ```
 *
 * Captured verbatim from a windows-2025 hosted CI runner: an exec issued against a
 * sandbox immediately after start() returned. Matches on msb's own `agent client
 * error` framing plus `connect`, so a failure raised *after* the connection is
 * established — a real agent error worth surfacing on the first attempt — is never
 * mistaken for this.
 */
export function isAgentEndpointNotReady(stderr: string): boolean {
  return stderr.includes("agent client error") && stderr.includes("connect");
}
