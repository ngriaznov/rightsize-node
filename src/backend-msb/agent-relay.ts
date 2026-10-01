/**
 * True if `output` (an `msb run` or `msb restore` invocation's combined
 * stdout+stderr) is msb giving up on a boot because the sandbox process had
 * already exited cleanly, without leaving a boot-error record, by the time the
 * host went to connect to the guest agent. Captured on a Windows CI runner
 * (a brokered restore, where PowerShell decorated the output and mangled the
 * arrow):
 *
 * ```text
 * msb.exe : error: failed to start "rz-731fdcdc-8"
 * At line:1 char:1
 * ...
 *   ΓåÆ other: sandbox process exited (exit code: 0) before agent relay became available
 *   ΓåÆ run `msb logs --source system rz-731fdcdc-8` for full diagnostics
 * ```
 *
 * and, undecorated, from an attached `msb run`:
 *
 * ```text
 * error: failed to start "rz-731fdcdc-8"
 *   → other: sandbox process exited (exit code: 0) before agent relay became available
 *   → run `msb logs --source system rz-731fdcdc-8` for full diagnostics
 * ```
 *
 * The status in parentheses is Rust's `ExitStatus` Display: `exit code: N` on
 * Windows (hex for high-bit codes, `exit code: 0xc0000409`), `exit status: N`
 * or `signal: N (SIGABRT)` on Unix. Only a clean exit is the transient: it has
 * been seen only under load, on attached run boots and on restores, and the
 * same boot succeeds a moment later. A crash exit with the same message is
 * deterministic (a TAB in a baked env var made msb 0.6.x abort with `signal: 6
 * (SIGABRT)` every time, see the Cassandra module) and fails identically on a
 * retry, so it is left as an ordinary boot failure.
 *
 * Matches two independent substrings, not the whole sentence: the arrow, the
 * `other:` and `error:` prefixes and the line structure all change with the
 * host's console and with PowerShell's capture, and no platform gate is
 * needed. The closing parenthesis in the exit marker keeps `(exit code:
 * 0xc0000409)` and `(exit code: 10)` from matching.
 *
 * What msb leaves behind is the stopped sandbox record under the name, which
 * makes a plain same-name retry unsafe (`msb run` would restart the persisted
 * config and ignore its new flags, `msb restore` refuses with "already
 * exists"), so the caller removes it with `msb rm -f` first and boots again
 * under the same name, exactly once.
 */
export function isAgentRelayUnavailable(output: string): boolean {
  return (
    output.includes("before agent relay became available") &&
    (output.includes("(exit code: 0)") || output.includes("(exit status: 0)"))
  );
}
