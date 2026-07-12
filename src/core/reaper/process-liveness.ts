import { spawn } from "node:child_process";

/**
 * The two operations a sweep needs about ANY pid on this machine — not
 * necessarily this process's own. Abstracted behind an interface so unit
 * tests can fabricate arbitrary (pid, start-time) combinations without
 * shelling out to the real OS, matching the feature spec's testing
 * requirement ("same-pid-different-start-time counts as dead" — a scenario
 * that's essentially impossible to provoke against a real process on
 * demand).
 */
export interface ProcessTimeSource {
  /** Whether a process with this pid currently exists. */
  isAlive(pid: number): boolean;
  /** That process's start time, ISO-8601, or `undefined` if it can't be determined (including "no longer exists"). */
  startedIso(pid: number): Promise<string | undefined>;
}

/** `process.kill(pid, 0)`: no signal sent, just existence-checked. EPERM means "exists but not ours" — still alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function collectStdout(cmd: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolveOut) => {
    let out = "";
    let settled = false;
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.once("error", () => {
      if (!settled) {
        settled = true;
        resolveOut(undefined);
      }
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      resolveOut(code === 0 ? out : undefined);
    });
  });
}

const ETIME_PATTERN = /^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/;

/**
 * `ps -p <pid> -o etime=` prints a DURATION — `[[dd-]hh:]mm:ss` — not a wall-
 * clock timestamp, so unlike `lstart` (a bare, timezone-less string that
 * different `Date` parsers and even different processes on the SAME host
 * can disagree about — confirmed empirically: a `bun test` worker's own
 * `Intl`/`Date` machinery reported its local timezone as UTC while a `ps`
 * child it spawned still printed the OS's real local time, a multi-hour
 * mismatch with no env var involved to explain it) there is no timezone to
 * get wrong here at all: `Date.now() - etimeMs` is unambiguous everywhere.
 */
function parseEtimeMs(text: string): number | undefined {
  const trimmed = text.trim();
  const m = ETIME_PATTERN.exec(trimmed);
  if (m === null) {
    return undefined;
  }
  const [, days, hours, minutes, seconds] = m as unknown as [string, string | undefined, string | undefined, string, string];
  const totalSeconds =
    (Number(days ?? 0) * 24 * 60 + Number(hours ?? 0) * 60 + Number(minutes)) * 60 + Number(seconds);
  return Number.isFinite(totalSeconds) ? totalSeconds * 1000 : undefined;
}

/** Test-only access to the pure `ps -o etime=` duration parser, exercised against fabricated strings without shelling out. */
export function _parseEtimeMsForTests(text: string): number | undefined {
  return parseEtimeMs(text);
}

async function posixStartedIso(pid: number): Promise<string | undefined> {
  const before = Date.now();
  const out = await collectStdout("ps", ["-p", String(pid), "-o", "etime="]);
  if (out === undefined) {
    return undefined;
  }
  const etimeMs = parseEtimeMs(out);
  return etimeMs === undefined ? undefined : new Date(before - etimeMs).toISOString();
}

/** PowerShell prints the process's start time already converted to UTC, in round-trippable ISO-8601 — no ad hoc parsing needed. */
async function windowsStartedIso(pid: number): Promise<string | undefined> {
  const script =
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
    `if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`;
  const out = await collectStdout("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (out === undefined) {
    return undefined;
  }
  const trimmed = out.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** The real, OS-backed `ProcessTimeSource` — production sweeps and the watchdog's liveness checks use this. */
export const realProcessTimeSource: ProcessTimeSource = {
  isAlive: isProcessAlive,
  startedIso: (pid: number): Promise<string | undefined> =>
    process.platform === "win32" ? windowsStartedIso(pid) : posixStartedIso(pid),
};

/** Cross-process liveness protocol: a run is ALIVE iff its pid exists AND its actual start time matches the recorded one within 2 seconds — this window is what defeats PID reuse. */
export const LIVENESS_TOLERANCE_MS = 2000;

/**
 * Judges a `(pid, startedIso)` pair against a time source. `undefined` from
 * `startedIso()` (pid vanished between the alive-check and the start-time
 * probe, or the platform command failed) is treated as dead — a run this
 * module can't positively confirm alive is reaped, matching the reaper's
 * bias toward cleaning up rather than leaking.
 */
export async function isRecordAlive(
  source: ProcessTimeSource,
  pid: number,
  recordedStartedIso: string,
): Promise<boolean> {
  if (!source.isAlive(pid)) {
    return false;
  }
  const actual = await source.startedIso(pid);
  if (actual === undefined) {
    return false;
  }
  const diff = Math.abs(Date.parse(actual) - Date.parse(recordedStartedIso));
  return Number.isFinite(diff) && diff <= LIVENESS_TOLERANCE_MS;
}

/**
 * This process's own start time, ISO-8601 — computed once at module load
 * from `process.uptime()` (Node has no direct "process start instant" API).
 * Close enough to true process start for the ±2s liveness tolerance even if
 * this module is first imported a little into the process's life.
 */
export const THIS_PROCESS_STARTED_ISO: string = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
