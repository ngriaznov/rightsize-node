import { spawn } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";
import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

/**
 * The argv PREFIXES (a sandbox/network name is appended by the watchdog
 * script itself) a backend's own CLI uses to reap something by name.
 * `stop`/`removeNetwork` may be empty arrays where a backend has no separate
 * stop step (docker's `rm -f` does both) or no native network object to
 * remove (msb emulates networks in-guest; there is nothing to tear down).
 */
export interface ReaperKillCommand {
  readonly stop: ReadonlyArray<string>;
  readonly remove: ReadonlyArray<string>;
  readonly removeNetwork: ReadonlyArray<string>;
}

export function watchdogDir(cacheDir: string): string {
  return path.join(cacheDir, "reaper");
}

/**
 * `watchdog-<12 hex of SHA-256(content)>.<ext>` — the filename derives from the
 * script's own bytes. The `reaper/` directory is shared with the sibling rightsize
 * libraries (Kotlin, Rust) and with other versions of this package, each shipping
 * its own script with its own argv contract; content-derived names make it
 * impossible to execute a script whose contract this code doesn't match, and
 * impossible for a write to clobber a script another process's `sh` is executing.
 * Exported for tests.
 */
export function watchdogScriptFilename(content: string): string {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  return process.platform === "win32" ? `watchdog-${hash}.js` : `watchdog-${hash}.sh`;
}

/**
 * POSIX `sh` driver: blocks reading stdin until EOF (the invoking rightsize
 * process holds the other end of the pipe; EOF means that process is gone,
 * cleanly or via SIGKILL), then reaps every sandbox/network the run tracked
 * and deletes its three ledger files. Written once under its content-derived
 * name (see watchdogScriptFilename) — this file is never hand-edited, and
 * each command prefix arrives via argv (word-split on spaces) rather than
 * being baked into the script, so a unit test can substitute a stub recorder
 * command without touching this file's content at all.
 */
function posixScriptContent(): string {
  return `#!/bin/sh
# rightsize reaper watchdog — generated file, named by its own content hash.
# argv: <sandboxesPath> <networksPath> <recordPath> <stopCmd> <removeCmd> <removeNetworkCmd>
# Each *Cmd is a single space-joined argv prefix (may be empty); the name
# being reaped is appended as the final argument.
set -u

SANDBOXES="$1"
NETWORKS="$2"
RECORD="$3"
STOP_CMD="$4"
REMOVE_CMD="$5"
REMOVE_NET_CMD="$6"

# Block here until the holder of the pipe's write end exits — cleanly or via
# SIGKILL, either way the OS closes that fd for us and this read hits EOF.
cat >/dev/null

# msb's shared state-database migration race (see isMsbStateDbError in the
# TypeScript backend) can fail a stop/rm exactly the same way it can fail a
# boot; retried once, same as the library's own in-process retry policy.
# Harmless no-op against docker's "docker rm -f" output, which never matches.
run_cmd() {
  prefix="$1"
  name="$2"
  [ -z "$prefix" ] && return 0
  # shellcheck disable=SC2086 -- intentional word-splitting of the prefix
  out=$($prefix "$name" 2>&1)
  if printf '%s' "$out" | grep -q "error: database error:"; then
    # shellcheck disable=SC2086
    $prefix "$name" >/dev/null 2>&1
  fi
  return 0
}

if [ -f "$SANDBOXES" ]; then
  while IFS= read -r name || [ -n "$name" ]; do
    [ -z "$name" ] && continue
    run_cmd "$STOP_CMD" "$name"
    run_cmd "$REMOVE_CMD" "$name"
  done < "$SANDBOXES"
fi

if [ -f "$NETWORKS" ]; then
  while IFS= read -r net || [ -n "$net" ]; do
    [ -z "$net" ] && continue
    run_cmd "$REMOVE_NET_CMD" "$net"
  done < "$NETWORKS"
fi

rm -f "$SANDBOXES" "$NETWORKS" "$RECORD"
`;
}

/**
 * Windows driver — a plain Node.js script, NOT PowerShell. Two things were
 * proven directly (RIGHTSIZE_REAPER_DEBUG=1 evidence, see the investigation
 * this replaces in git history) rather than assumed:
 *
 * 1. On Windows, a NON-detached child of this process is killed by the OS
 *    itself the instant this process is torn down (SIGKILL or otherwise),
 *    regardless of what the child is doing — confirmed with a minimal,
 *    PowerShell/msb-independent control experiment (a plain `node -e`
 *    heartbeat writer stopped heartbeating within a few hundred ms of the
 *    owner's kill). This is Windows Job Object semantics: Node/libuv ties a
 *    non-detached child to a job object that the OS closes (and, with it,
 *    terminates every member process) when the owner's own job handle
 *    closes. `detached: true` opts out of that job.
 * 2. `detached: true` reliably lets an ORDINARY process survive — the same
 *    control experiment's detached variant kept heartbeating for the full
 *    60s+ test window, well past the owner's death. But BOTH PowerShell
 *    hosts available on Windows (legacy `powershell` and `pwsh`) die within
 *    ~200ms of being spawned with `detached: true`, before running a
 *    single script line, independent of whether the owner has even been
 *    killed yet — `DETACHED_PROCESS` (what `detached: true` maps to on
 *    win32) appears fatal to launching either PowerShell host via `-File`,
 *    not a version-specific ConsoleHost quirk.
 *
 * Put together: the fix isn't a different PowerShell invocation shape, it's
 * not using PowerShell at all. `node` itself is proven to survive
 * `detached: true` on this exact platform, so the Windows watchdog is
 * `node <this script>.js <args>`, `detached: true` — the SAME reap/cleanup
 * sequence as the POSIX `sh` script, just polling for the owner's pid
 * (`process.kill(pid, 0)` — the exact liveness primitive
 * process-liveness.ts's cross-platform sweep already uses successfully on
 * Windows) every 500ms instead of blocking on stdin EOF (which POSIX can
 * do safely — see posixScriptContent's doc — but which this investigation
 * separately found unreliable on Windows before settling on the job-object
 * explanation above; moot once nothing here reads stdin at all).
 *
 * Emits timestamped checkpoint lines to `<RecordPath's directory>\
 * watchdog-trace-<PID>.log` when `RIGHTSIZE_REAPER_DEBUG=1` is set in this
 * process's OWN environment (inherited from whatever spawned it) — see
 * watchdogTracePath.
 */
function windowsScriptContent(): string {
  return `// rightsize reaper watchdog — generated file, named by its own content hash.
// argv: <sandboxesPath> <networksPath> <recordPath> <stopCmd> <removeCmd> <removeNetworkCmd> <ownerPid>
// Each *Cmd is a single space-joined argv prefix (may be empty); the name
// being reaped is appended as the final argument.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const [sandboxesPath, networksPath, recordPath, stopCmd, removeCmd, removeNetCmd, ownerPidRaw] = process.argv.slice(2);
const ownerPid = Number(ownerPidRaw);

const debugOn = process.env.RIGHTSIZE_REAPER_DEBUG === "1";
const tracePath = path.join(path.dirname(recordPath), \`watchdog-trace-\${process.pid}.log\`);
function trace(msg) {
  if (!debugOn) return;
  try {
    fs.appendFileSync(tracePath, \`[\${new Date().toISOString()}] \${msg}\\n\`);
  } catch {
    // best-effort diagnostics only
  }
}

trace("started");
trace(\`params: ownerPid=[\${ownerPid}] stopCmd=[\${stopCmd}] removeCmd=[\${removeCmd}] removeNetCmd=[\${removeNetCmd}]\`);

// process.kill(pid, 0) sends no signal, just checks existence — the same
// primitive process-liveness.ts's isProcessAlive uses, cross-platform.
function ownerAlive() {
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function splitPrefix(cmd) {
  return cmd.length === 0 ? [] : cmd.split(" ");
}

// msb's shared state-database migration race (see isMsbStateDbError in the
// TypeScript backend) can fail a stop/rm exactly the same way it can fail a
// boot; retried once, same as the library's own in-process retry policy.
// Harmless no-op against docker's "docker rm -f" output, which never matches.
function runCmd(prefix, name) {
  const words = splitPrefix(prefix);
  if (words.length === 0) return;
  const [exe, ...rest] = words;
  const args = [...rest, name];
  const run = () => {
    const res = spawnSync(exe, args, { encoding: "utf8" });
    return (res.stdout || "") + (res.stderr || "");
  };
  const out = run();
  if (out.includes("error: database error:")) {
    run();
  }
}

function reapLines(filePath, cmds) {
  if (!fs.existsSync(filePath)) return;
  const names = fs.readFileSync(filePath, "utf8").split("\\n").filter((l) => l.length > 0);
  for (const name of names) {
    for (const cmd of cmds) {
      if (cmd === undefined) continue;
      trace(\`\${cmd === stopCmd ? "stop" : cmd === removeCmd ? "remove" : "remove-net"} \${name}\`);
      runCmd(cmd, name);
    }
  }
}

function poll() {
  const pollCountKey = "__rzPollCount";
  poll[pollCountKey] = (poll[pollCountKey] || 0) + 1;
  const n = poll[pollCountKey];
  if (n === 1 || n % 20 === 0) {
    trace(\`poll #\${n}: ownerAlive(\${ownerPid}) -> \${ownerAlive()}\`);
  }
  if (ownerAlive()) {
    setTimeout(poll, 500);
    return;
  }
  trace("owner gone");
  reapLines(sandboxesPath, [stopCmd, removeCmd]);
  reapLines(networksPath, [removeNetCmd]);
  trace("removing ledger files");
  for (const p of [sandboxesPath, networksPath, recordPath]) {
    try {
      fs.unlinkSync(p);
    } catch {
      // already gone — fine
    }
  }
  trace("done");
}

poll();
`;
}

/** Writes the platform-appropriate watchdog script under `<cacheDir>/reaper/` (skipped when its content-named file already exists) and returns its path. */
export async function ensureWatchdogScript(cacheDir: string): Promise<string> {
  const dir = watchdogDir(cacheDir);
  await fsp.mkdir(dir, { recursive: true });
  const content = process.platform === "win32" ? windowsScriptContent() : posixScriptContent();
  const scriptPath = path.join(dir, watchdogScriptFilename(content));
  try {
    await fsp.access(scriptPath);
    return scriptPath; // the filename encodes the content, so presence means identity
  } catch {
    // absent — write below
  }
  const tmpPath = `${scriptPath}.${process.pid}.tmp`;
  await fsp.writeFile(tmpPath, content);
  if (process.platform !== "win32") {
    await fsp.chmod(tmpPath, 0o755);
  }
  try {
    await fsp.rename(tmpPath, scriptPath);
  } catch (err) {
    // A concurrent writer beat us to it with identical bytes; otherwise re-throw.
    await fsp.rm(tmpPath, { force: true });
    try {
      await fsp.access(scriptPath);
    } catch {
      throw err;
    }
  }
  return scriptPath;
}

function joinPrefix(prefix: ReadonlyArray<string>): string {
  return prefix.join(" ");
}

/**
 * `RIGHTSIZE_REAPER_DEBUG=1` turns on the watchdog spawn diagnostics below —
 * off by default (production spawns never pay for the extra file opens or
 * the diagnostics IO). Meant to be set for a single CI debug run, not left
 * on permanently, though the affordance itself is cheap enough to ship.
 */
function reaperDebugEnabled(): boolean {
  return process.env["RIGHTSIZE_REAPER_DEBUG"] === "1";
}

/** The run id a ledger path was generated for — `runs/<run-id>.sandboxes` etc. */
function runIdFromSandboxesPath(sandboxesPathValue: string): string {
  return path.basename(sandboxesPathValue).replace(/\.sandboxes$/, "");
}

/**
 * Paths the debug affordance below writes to when `RIGHTSIZE_REAPER_DEBUG=1`
 * — the watchdog's own stdout/stderr (normally `"ignore"`d) plus a meta log
 * of spawn/error/exit events, all under the same `reaper/` directory the
 * watchdog script itself lives in. Exported so a test can locate them
 * without duplicating the naming scheme.
 */
export function watchdogDebugPaths(cacheDir: string, runId: string): { out: string; err: string; meta: string } {
  const dir = watchdogDir(cacheDir);
  return {
    out: path.join(dir, `watchdog-${runId}.debug.out.log`),
    err: path.join(dir, `watchdog-${runId}.debug.err.log`),
    meta: path.join(dir, `watchdog-${runId}.debug.meta.log`),
  };
}

/**
 * Where the Windows script's own in-script trace (see windowsScriptContent's
 * doc) lands: same directory as the run record, named by the watchdog
 * process's own pid — the one piece of the script's identity a caller can
 * know ahead of the script writing anything itself. POSIX has no equivalent
 * (its script has no such tracing; its debug story is the stdout/stderr
 * capture above, which is enough there since `sh -x` isn't needed to tell
 * the difference between "never started" and "died partway").
 */
export function watchdogTracePath(recordPathValue: string, pid: number): string {
  return path.join(path.dirname(recordPathValue), `watchdog-trace-${pid}.log`);
}

function appendDebugLine(filePath: string, line: string): void {
  try {
    fsSync.appendFileSync(filePath, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // Best-effort diagnostics only — never let a debug-log write failure
    // affect the watchdog spawn itself.
  }
}

export interface SpawnWatchdogOptions {
  readonly cacheDir: string;
  readonly sandboxesPath: string;
  readonly networksPath: string;
  readonly recordPath: string;
  readonly killCommand: ReaperKillCommand;
  /**
   * This process's own pid. Used only by the Windows script (see
   * windowsScriptContent's doc for why it polls instead of blocking on
   * stdin EOF); harmless to pass on POSIX, which ignores it.
   */
  readonly ownerPid: number;
}

export interface WatchdogHandle {
  readonly process: ChildProcess;
  /** Closes the held pipe early — test-only, POSIX-only (the Windows script no longer reads stdin at all; production code lets the POSIX process exit close its pipe naturally). */
  closeForTests(): void;
}

/**
 * Spawns the watchdog detached, unref()'d so it never keeps this process's
 * event loop alive.
 *
 * On POSIX, its stdin is a pipe whose write end ONLY this process holds —
 * that write end is `handle.process.stdin`, returned so the caller can
 * keep a live reference for the rest of the process's life (letting it get
 * garbage-collected or explicitly closing it would arm the watchdog
 * early). `detached: true` there just means the standard POSIX
 * survive-your-parent behavior (setsid); this has always worked and this
 * investigation never found a POSIX failure.
 *
 * On Windows, `detached: true` is load-bearing for a completely different
 * reason, proven with a minimal control experiment (a plain `node -e`
 * heartbeat writer — see git history): a NON-detached Windows child is
 * killed by the OS itself the instant this process is torn down, via
 * Windows Job Object semantics (Node/libuv ties a non-detached child to a
 * job object that closes, killing every member, when the owner's own job
 * handle closes) — regardless of what the child is doing. `detached: true`
 * escapes that job and reliably survives (confirmed: 60s+ of continued
 * heartbeats past the owner's death). PowerShell was the original design
 * for the Windows script, but BOTH available hosts (legacy `powershell`
 * and `pwsh`) die within ~200ms of being spawned with `detached: true`,
 * before running a single line — so the Windows watchdog is `node` running
 * a small generated `.js` file instead (see windowsScriptContent), since
 * plain `node` IS proven to survive `detached: true` here. Its stdin is
 * `"ignore"` — it polls for this process's death rather than reading
 * anything, so there is no pipe to leak into any later child this process
 * spawns either. All other stdio is `"ignore"` (or, under
 * `RIGHTSIZE_REAPER_DEBUG`, captured to files) so CI runners never hang on
 * an inherited handle.
 */
export async function spawnWatchdog(opts: SpawnWatchdogOptions): Promise<WatchdogHandle> {
  const scriptPath = await ensureWatchdogScript(opts.cacheDir);
  const interpreter = process.platform === "win32" ? process.execPath : "sh";
  const baseArgs = [scriptPath];
  const argv = [
    ...baseArgs,
    opts.sandboxesPath,
    opts.networksPath,
    opts.recordPath,
    joinPrefix(opts.killCommand.stop),
    joinPrefix(opts.killCommand.remove),
    joinPrefix(opts.killCommand.removeNetwork),
    ...(process.platform === "win32" ? [String(opts.ownerPid)] : []),
  ];

  const debug = reaperDebugEnabled();
  const runId = runIdFromSandboxesPath(opts.sandboxesPath);
  const debugPaths = debug ? watchdogDebugPaths(opts.cacheDir, runId) : undefined;
  if (debugPaths !== undefined) {
    fsSync.mkdirSync(watchdogDir(opts.cacheDir), { recursive: true });
  }
  // Normally "ignore" (CI runners must never hang on an inherited handle);
  // under RIGHTSIZE_REAPER_DEBUG=1 the watchdog's own stdout/stderr are
  // instead captured to files so a failing run can show what the script
  // itself printed rather than nothing at all. Stdin is "pipe" only on
  // POSIX — see this function's doc.
  const stdin = process.platform === "win32" ? "ignore" : "pipe";
  const stdio: StdioOptions =
    debugPaths === undefined
      ? [stdin, "ignore", "ignore"]
      : [stdin, fsSync.openSync(debugPaths.out, "a"), fsSync.openSync(debugPaths.err, "a")];

  const child = spawn(interpreter, argv, {
    detached: true,
    windowsHide: true,
    stdio,
  });

  if (debugPaths !== undefined) {
    appendDebugLine(
      debugPaths.meta,
      `spawn interpreter=${interpreter} pid=${child.pid ?? "unknown"} argv=${JSON.stringify(argv)}`,
    );
    child.once("error", (err) => {
      appendDebugLine(debugPaths.meta, `spawn error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    });
    child.once("exit", (code, signal) => {
      appendDebugLine(debugPaths.meta, `exit code=${code ?? "null"} signal=${signal ?? "null"}`);
    });
  } else {
    // Always listen for 'error', debug or not: an unlistened 'error' event
    // on a ChildProcess is an uncaught exception in this process, and a
    // failed watchdog spawn (e.g. the interpreter missing from PATH) must
    // stay best-effort like every other reaper failure mode, never crash
    // the host application.
    child.once("error", () => {});
  }

  child.unref();
  // child.stdin is typed as the generic Writable interface, but for a
  // "pipe" stdio entry Node always backs it with a net.Socket, which DOES
  // expose unref() — without this, the held write end would keep this
  // process's event loop alive even though child.unref() already detached
  // the child itself. A no-op on Windows, where stdin is "ignore" and
  // child.stdin is null.
  const stdinSocket = child.stdin as unknown as { unref?: () => void } | null;
  stdinSocket?.unref?.();

  return {
    process: child,
    closeForTests: () => {
      child.stdin?.end();
    },
  };
}
