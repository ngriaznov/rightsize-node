import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { BackendError } from "../core/errors.js";
import type { ExecResult } from "../core/model.js";

/**
 * Every msb child this backend spawns gets a closed/null stdin. `msb exec`
 * (and, empirically, plain `msb run`/`logs`/`ls` too) forwards a held-open
 * stdin pipe straight through and blocks on it hitting EOF — a Node
 * `"pipe"` stdin option never closes on its own, so any child spawned that
 * way hangs forever the instant msb tries to read from it. `"ignore"`
 * signals EOF immediately, which is exactly what every non-interactive
 * invocation here wants.
 */
export const CLOSED_STDIN = "ignore" as const;

function drainLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolveDrain) => {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", onLine);
    rl.on("close", () => resolveDrain());
  });
}

/**
 * Runs one `msb <args>` invocation to completion: closed stdin (see
 * `CLOSED_STDIN`), stdout/stderr drained line-by-line as they arrive, and —
 * once the process has actually exited — the drain promises are awaited
 * WITHOUT a time cap. A fixed join deadline here would truncate the tail of
 * any command whose output hadn't finished flushing through the pipe by the
 * time the process itself exited, which silently corrupts large `exec`
 * output; the child is already dead by this point, so unbounded awaiting the
 * remaining drain is safe by construction and Windows-length pipes are not a
 * concern on the two platforms msb ships for.
 */
export function invoke(msbPath: string, args: readonly string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolveInvoke, rejectInvoke) => {
    const child = spawn(msbPath, args, { stdio: [CLOSED_STDIN, "pipe", "pipe"] });
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const stdoutDone = drainLines(child.stdout, (l) => stdoutLines.push(l));
    const stderrDone = drainLines(child.stderr, (l) => stderrLines.push(l));

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      rejectInvoke(
        new BackendError(
          `msb ${args.join(" ")} timed out after ${timeoutMs}ms and was force-killed — the msb ` +
            `daemon may be overloaded or unresponsive; retry, or check 'msb' directly`,
        ),
      );
    }, timeoutMs);

    child.once("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      rejectInvoke(new BackendError(`failed to spawn 'msb ${args.join(" ")}': ${err.message}`));
    });

    child.once("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      Promise.all([stdoutDone, stderrDone]).then(() => {
        resolveInvoke({
          exitCode: code ?? -1,
          stdout: stdoutLines.join("\n") + (stdoutLines.length > 0 ? "\n" : ""),
          stderr: stderrLines.join("\n") + (stderrLines.length > 0 ? "\n" : ""),
        });
      });
    });
  });
}
