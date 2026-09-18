import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CLOSED_STDIN } from "./invoke.js";

/**
 * The Windows-only job-object-breakaway problem this whole module exists to
 * route around. EMPIRICALLY VERIFIED across a four-round live diagnostic
 * campaign on Windows CI (2026-09-18): msb's detached spawn on Windows
 * (`sdk/rust/lib/runtime/spawn.rs`, msb 0.7.1/0.7.2) always passes
 * `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB`
 * when it launches the new `msb.exe` that supervises a restored sandbox —
 * `msb restore` is detached-by-design (see `MsbCliBackend.bootRestoreOnce`'s
 * own doc), so it must spawn that new process every time. When the CALLING
 * `msb.exe` itself sits inside a Windows job object that was never granted
 * `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, `CreateProcess` fails outright with
 * `ERROR_ACCESS_DENIED`, and msb surfaces the bare `error: io error: Access
 * is denied. (os error 5)` — the exact signature `isRestoreAccessDeniedFailure`
 * matches, previously attributed entirely to a Windows file-handle release
 * lag. Direct probes at failure time ruled the lag theory out: no msb.exe
 * processes alive, the artifact readable/writable/hardlinkable from another
 * process, nothing locked — the denial is the spawn itself, not the file.
 *
 * Gradle test workers and cargo-test binaries run inside exactly such
 * breakaway-denying job objects (`inJob=True, limitFlags=0x0`, live-probed),
 * which is why the sibling rust/kotlin libraries hit this deterministically
 * on their own Windows CI while this repository's node test workers —
 * confirmed to add no such job object — never have.
 *
 * THE MITIGATION IS LIVE-VALIDATED: the identical `msb restore <artifact>
 * --name X` launched through WMI (`Invoke-CimMethod -ClassName Win32_Process
 * -MethodName Create`), whose children run under `WmiPrvSE` OUTSIDE the
 * caller's job hierarchy, returns `ReturnValue=0` and the restored sandbox
 * shows Running in `msb ls` — reproduced in two separate cycles in the exact
 * environment where a direct spawn is denied every time.
 *
 * This module is the resulting escape hatch: `realRestoreBroker` shells the
 * exact same `msb restore ...` invocation through a WMI-created process
 * instead of a direct child, for the callers in `backend.ts`
 * (`rebootUnderFreshName`/`retryRestoreAfterAccessDenied`) that escalate to
 * it once — and only once — a restore attempt on a Windows host hits that
 * classified access-denied failure (POLICY v2; see those methods' own doc).
 * It changes nothing for a healthy environment: the first attempt of any
 * reboot is always a direct spawn, and a host that never hits the access-
 * denied signature never touches this module at all.
 */

/** One brokered restore attempt whose own outcome was captured — classify `output` with the exact same predicates a direct attempt's output goes through. */
export interface RestoreBrokerCompleted {
  kind: "completed";
  exitCode: number;
  output: string;
}

/**
 * The broker's own `ecFile` (see `buildOuterBrokerScript`) never appeared
 * within its bounded wait, so no exit code/output could be read back — but
 * the WMI `Create` call itself was accepted (`ReturnValue=0`), so the
 * restore may well be running in the background regardless. The caller
 * (`MsbCliBackend.bootRestoreOnce`) treats this exactly like a confirmed
 * exit 0: skip classification and fall through to its own `msb ls`
 * readiness poll, which — being activation-gated — settles the question on
 * its own either way.
 */
export interface RestoreBrokerUnconfirmed {
  kind: "unconfirmed";
}

export type RestoreBrokerResult = RestoreBrokerCompleted | RestoreBrokerUnconfirmed;

/**
 * The injectable seam `MsbCliBackend` calls through for every brokered
 * restore attempt — `msbPath`/`argv` are exactly what a direct attempt would
 * spawn (`MsbCommands.restore(spec)`'s own argv, unmodified), `timeoutMs` the
 * same boot budget a direct attempt is held to. Rejects only for a broker-
 * INFRASTRUCTURE failure (missing `powershell.exe`, a script-file write
 * failure, WMI refusing to even create the process) — the caller falls back
 * to a direct attempt on a rejection (POLICY v2 point 5: the broker must
 * never become a new single point of failure). Resolves for every other
 * outcome, including the brokered restore itself failing (access-denied
 * again, an "already exists" collision, or any other msb refusal) — that is
 * ordinary classified output for the caller to interpret, not a broker
 * failure.
 */
export type RestoreBrokerLauncher = (
  msbPath: string,
  argv: readonly string[],
  timeoutMs: number,
) => Promise<RestoreBrokerResult>;

/**
 * Doubles every embedded `'` so `value` can be dropped verbatim into a
 * PowerShell single-quoted string literal (`'...'`) — PowerShell's own
 * escaping rule for that quoting style, the same one a hand-written `''`
 * inside a single-quoted string represents a literal `'`. Applied to every
 * interpolated value this module builds a script around (the msb binary
 * path, every restore argv token, and the temp out/ec file paths) — never
 * only the ones expected to need it, since a caller-controlled mount path or
 * artifact ref is exactly the kind of value that might one day carry one.
 */
export function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

/** `value` wrapped as its own single-quoted PowerShell literal (see `escapePowerShellSingleQuoted`). */
function quoteSingle(value: string): string {
  return `'${escapePowerShellSingleQuoted(value)}'`;
}

/**
 * The script text the WMI-created powershell process itself runs: the real
 * `msb <argv>` invocation (the call operator `&`, since `msbPath` is a
 * runtime string, not a literal command name), its combined stdout+stderr
 * merged into `outFile` via PowerShell's `*>` all-streams redirection —
 * mirroring `fetchStdoutExact`'s own reason for treating stdout+stderr as
 * one channel — followed by writing the invocation's own `$LASTEXITCODE` to
 * `ecFile`. Both files are how this reaches back across the WMI boundary:
 * `Invoke-CimMethod`'s `Create` has no stdout/exit-code channel of its own
 * (it returns only a `ProcessId` and a `ReturnValue` for the CREATE call
 * itself, never anything about what that process goes on to do). Every path
 * and argv token is its own single-quoted literal (`quoteSingle`) — never
 * string-interpolated — so a value carrying spaces, `$`, or a literal `'`
 * (an exotic mount path, in principle) round-trips as data, not script
 * syntax.
 */
export function buildInnerRestoreScript(msbPath: string, argv: readonly string[], outFile: string, ecFile: string): string {
  const quotedArgv = argv.map(quoteSingle).join(" ");
  return [
    `& ${quoteSingle(msbPath)} ${quotedArgv} *> ${quoteSingle(outFile)}`,
    `Set-Content -LiteralPath ${quoteSingle(ecFile)} -Value $LASTEXITCODE -NoNewline`,
  ].join("\n");
}

/**
 * Encodes `script` the way `powershell -EncodedCommand` requires: UTF-16LE
 * bytes, base64. Chosen over `-Command "<script>"` specifically to sidestep
 * a second layer of quote-escaping entirely — `buildInnerRestoreScript`'s
 * own output already carries single-quoted literals of its own, and nesting
 * that inside ANOTHER quoted string (the `CommandLine` this module hands to
 * `Invoke-CimMethod`) would mean escaping quotes-within-quotes-within-quotes.
 * A base64 payload is alphanumeric-plus-`+/=` only, so embedding it inside
 * the OUTER script's own single-quoted `CommandLine` literal (see
 * `buildOuterBrokerScript`) needs no escaping of its own at all.
 */
export function encodeAsEncodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** How long `buildOuterBrokerScript`'s own polling loop waits for `ecFile` to appear before giving up and letting the caller fall through to its own `msb ls` readiness poll (see `RestoreBrokerUnconfirmed`'s own doc) — generous for `msb restore`'s own detach, which the rest of this codebase documents as "typically within seconds". */
export const RESTORE_BROKER_ECFILE_WAIT_SECONDS = 30;

const RETURN_VALUE_PREFIX = "RIGHTSIZE-BROKER-RETURNVALUE=";
const PROCESS_ID_PREFIX = "RIGHTSIZE-BROKER-PROCESSID=";
const OUT_BEGIN = "RIGHTSIZE-BROKER-OUT-BEGIN";
const OUT_END = "RIGHTSIZE-BROKER-OUT-END";
const EC_BEGIN = "RIGHTSIZE-BROKER-EC-BEGIN";
const EC_END = "RIGHTSIZE-BROKER-EC-END";

/**
 * The OUTER script — the one actually run as `powershell -NoProfile -File
 * <script>` (see `realRestoreBroker`) — that performs the WMI escape itself
 * and reports back what happened, all through plain stdout this module's own
 * node-side caller can read directly (no temp file needed for THIS layer,
 * unlike the inner restore's own output — this process's stdout pipe is
 * ordinary, since it is never the one msb's job object would deny).
 *
 * `encodedInner` (see `encodeAsEncodedCommand`) is embedded inside this
 * script's own single-quoted `$cmdLine` literal — safe with no escaping of
 * its own, being pure base64 — as the `-EncodedCommand` argument of the
 * powershell invocation `Invoke-CimMethod` launches. `outFile`/`ecFile` are
 * each their own single-quoted literal via `quoteSingle`, the same as every
 * path `buildInnerRestoreScript` embeds.
 *
 * `powershell.exe` (never the bare `powershell`, nor `pwsh`) both here and as
 * the WMI-launched process's own executable — the task this whole module
 * exists for names it explicitly "for maximum compatibility": every
 * supported Windows release ships Windows PowerShell under that exact name,
 * while PowerShell 7 (`pwsh`) is an opt-in install this backend has no
 * business depending on.
 */
export function buildOuterBrokerScript(params: {
  encodedInner: string;
  outFile: string;
  ecFile: string;
  waitSeconds?: number;
}): string {
  const { encodedInner, outFile, ecFile } = params;
  const waitSeconds = params.waitSeconds ?? RESTORE_BROKER_ECFILE_WAIT_SECONDS;
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$cmdLine = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encodedInner}'`,
    `$create = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine }`,
    `Write-Output "${RETURN_VALUE_PREFIX}$($create.ReturnValue)"`,
    `Write-Output "${PROCESS_ID_PREFIX}$($create.ProcessId)"`,
    `$deadline = (Get-Date).AddSeconds(${waitSeconds})`,
    `while (-not (Test-Path -LiteralPath ${quoteSingle(ecFile)}) -and (Get-Date) -lt $deadline) {`,
    `  Start-Sleep -Milliseconds 250`,
    `}`,
    `if (Test-Path -LiteralPath ${quoteSingle(outFile)}) {`,
    `  Write-Output '${OUT_BEGIN}'`,
    `  Get-Content -LiteralPath ${quoteSingle(outFile)} -Raw`,
    `  Write-Output '${OUT_END}'`,
    `}`,
    `if (Test-Path -LiteralPath ${quoteSingle(ecFile)}) {`,
    `  Write-Output '${EC_BEGIN}'`,
    `  Get-Content -LiteralPath ${quoteSingle(ecFile)} -Raw`,
    `  Write-Output '${EC_END}'`,
    `}`,
  ].join("\n");
}

export interface ParsedBrokerScriptOutput {
  /** The WMI `Create` call's own `ReturnValue` (0 == accepted), or `undefined` if the marker line itself never showed up (the outer script died before printing it). */
  returnValue: number | undefined;
  /** The WMI-created process's own pid, purely diagnostic — never load-bearing for classification. */
  processId: number | undefined;
  /** `outFile`'s contents (the brokered `msb restore`'s combined stdout+stderr), or `undefined` if `outFile` never existed when the outer script checked. */
  outText: string | undefined;
  /** `ecFile`'s contents (the brokered invocation's own `$LASTEXITCODE`, as text), or `undefined` if it never appeared within the wait bound. */
  ecText: string | undefined;
}

function extractPrefixedInt(text: string, prefix: string): number | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix)) {
      const parsed = Number.parseInt(trimmed.slice(prefix.length).trim(), 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
  }
  return undefined;
}

function extractBetween(text: string, beginMarker: string, endMarker: string): string | undefined {
  const beginIdx = text.indexOf(beginMarker);
  if (beginIdx === -1) {
    return undefined;
  }
  const contentStart = text.indexOf("\n", beginIdx);
  if (contentStart === -1) {
    return undefined;
  }
  const endIdx = text.indexOf(endMarker, contentStart);
  if (endIdx === -1) {
    return undefined;
  }
  const raw = text.slice(contentStart + 1, endIdx);
  // The captured content always carries exactly one trailing "\n" of its
  // own — the line break between the last content line and the end
  // marker's own line — which is an artifact of this scan, never part of
  // what `Write-Output`/`Get-Content -Raw` actually produced; strip it.
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

/** Parses `buildOuterBrokerScript`'s own stdout back into its four parts — see `ParsedBrokerScriptOutput`'s own doc on each field. Tolerant of CRLF (PowerShell's own native line ending) and of any marker being absent, since the outer script can die (or its own wait bound expire) after printing only some of them. */
export function parseBrokerScriptOutput(stdout: string): ParsedBrokerScriptOutput {
  const normalized = stdout.replace(/\r\n/g, "\n");
  const ecText = extractBetween(normalized, EC_BEGIN, EC_END);
  return {
    returnValue: extractPrefixedInt(normalized, RETURN_VALUE_PREFIX),
    processId: extractPrefixedInt(normalized, PROCESS_ID_PREFIX),
    outText: extractBetween(normalized, OUT_BEGIN, OUT_END),
    ecText: ecText?.trim(),
  };
}

function runPowerShellFile(scriptFile: string, timeoutMs: number): Promise<{ stdout: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", scriptFile], {
      stdio: [CLOSED_STDIN, "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      rejectRun(new Error(`restore broker: its own powershell.exe driver did not exit within ${timeoutMs}ms`));
    }, timeoutMs);

    child.once("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      rejectRun(new Error(`restore broker: failed to spawn powershell.exe: ${err.message}`));
    });

    child.once("close", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // Combined for the same reason `fetchStdoutExact`'s sibling calls
      // treat stdout/stderr as one channel elsewhere in this backend: the
      // outer script's own diagnostics (a PowerShell terminating error,
      // say) could land on either.
      resolveRun({ stdout: stderr.length > 0 ? `${stdout}\n${stderr}` : stdout });
    });
  });
}

/**
 * The real, production `RestoreBrokerLauncher` — writes the outer script
 * (see `buildOuterBrokerScript`) to a unique temp file, runs it via
 * `powershell.exe -NoProfile -NonInteractive -File <script>`, and turns its
 * parsed output (`parseBrokerScriptOutput`) into a `RestoreBrokerResult`:
 *
 * - WMI's own `ReturnValue` missing or non-zero (the process was never even
 *   created) throws — broker-infrastructure failure, per this function's own
 *   `RestoreBrokerLauncher` contract, for the caller to catch and fall back
 *   to a direct attempt.
 * - `ecFile` never read back (`ecText === undefined`, or unparsable as an
 *   integer) resolves `{ kind: "unconfirmed" }` — see that type's own doc.
 * - Otherwise resolves `{ kind: "completed", exitCode, output: outText ?? ""
 *   }` — the brokered restore's own result, for the caller to classify
 *   exactly like a direct attempt's.
 *
 * Every temp file (script, `outFile`, `ecFile`) is unique per call
 * (`randomBytes`-suffixed, under `os.tmpdir()`) and best-effort removed in a
 * `finally` — cleanup failures are swallowed, never allowed to mask the real
 * outcome above.
 */
export const realRestoreBroker: RestoreBrokerLauncher = async (msbPath, argv, timeoutMs) => {
  const unique = `rightsize-restore-broker-${process.pid}-${randomBytes(6).toString("hex")}`;
  const base = path.join(os.tmpdir(), unique);
  const scriptFile = `${base}.ps1`;
  const outFile = `${base}.out.txt`;
  const ecFile = `${base}.ec.txt`;

  const inner = buildInnerRestoreScript(msbPath, argv, outFile, ecFile);
  const outer = buildOuterBrokerScript({ encodedInner: encodeAsEncodedCommand(inner), outFile, ecFile });

  try {
    try {
      await fs.writeFile(scriptFile, outer, "utf8");
    } catch (err) {
      throw new Error(`restore broker: failed to write its own script file '${scriptFile}': ${err instanceof Error ? err.message : String(err)}`);
    }

    const { stdout } = await runPowerShellFile(scriptFile, timeoutMs);
    const parsed = parseBrokerScriptOutput(stdout);

    if (parsed.returnValue === undefined) {
      throw new Error(`restore broker: could not find a WMI ReturnValue in its own driver script's output:\n${stdout}`);
    }
    if (parsed.returnValue !== 0) {
      throw new Error(
        `restore broker: WMI 'Win32_Process Create' refused to launch the restore (ReturnValue=${parsed.returnValue}):\n${stdout}`,
      );
    }
    if (parsed.ecText === undefined) {
      return { kind: "unconfirmed" };
    }
    const exitCode = Number.parseInt(parsed.ecText, 10);
    if (!Number.isFinite(exitCode)) {
      return { kind: "unconfirmed" };
    }
    return { kind: "completed", exitCode, output: parsed.outText ?? "" };
  } finally {
    await Promise.all([
      fs.rm(scriptFile, { force: true }).catch(() => {}),
      fs.rm(outFile, { force: true }).catch(() => {}),
      fs.rm(ecFile, { force: true }).catch(() => {}),
    ]);
  }
};
