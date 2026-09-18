import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  BackendError,
  PortBindConflictError,
  UnsupportedByBackendError,
  TmpfsRootCheckpointError,
  CheckpointWorkloadCommandMissingError,
} from "../core/errors.js";
import { cacheDir } from "../core/cache-dir.js";
import { nextSandboxName } from "../core/sandbox-name.js";
import { trackSandbox, untrackSandbox } from "../core/reaper/init.js";
import type { SandboxBackend, SandboxHandle, FollowHandle, NetworkLink, ReaperKillCommand, BackendCapabilities } from "../core/backend.js";
import type { ContainerSpec, ExecResult } from "../core/model.js";
import { MsbCommands } from "./commands.js";
import { runningNames, statusOf } from "./ls-json.js";
import { hasSandboxStartedMarker } from "./fast-exit.js";
import { invoke, CLOSED_STDIN } from "./invoke.js";
import { isPortBindConflictOutput } from "./port-conflict.js";
import { isImageCacheCorruption } from "./image-cache.js";
import { isMsbStateDbError } from "./state-db.js";
import { isAgentEndpointNotReady } from "./agent-endpoint.js";
import { isSnapshotNotFoundError } from "./snapshot-not-found.js";
import { isSnapshotAlreadyExistsError, parseImportedArtifactPath } from "./snapshot-import.js";
import { isSnapshotSaveAccessDeniedFailure, salvageStagedArchive } from "./snapshot-save-fsync.js";
import { parseSnapshotCreateArtifactPath } from "./snapshot-create.js";
import { isSnapshotHeadRemovalRefused } from "./snapshot-rm.js";
import { undeliveredLines } from "./follow-replay.js";
import { requireNoDuplicateGuestPorts, requireAliasesAreValid, hostsAliasScript } from "./network-links.js";
import { ExecTunnel } from "./exec-tunnel.js";
import { isRestoreAccessDeniedFailure } from "./restore-access-denied.js";
import { isSandboxAlreadyExistsFailure } from "./sandbox-already-exists.js";

const FIRST_RUN_PULL_TIMEOUT_MS = 600_000; // a cold pull can be slow
const READINESS_POLL_MS = 300;
const STOP_TIMEOUT_MS = 60_000;
const EXEC_TIMEOUT_MS = 120_000;
// How long an exec keeps retrying while the guest agent's endpoint has not
// appeared yet, and how long it pauses between attempts — see
// `isAgentEndpointNotReady`. Costs nothing on the ordinary path, where the
// first attempt connects.
const AGENT_ENDPOINT_RETRY_BUDGET_MS = 30_000;
const AGENT_ENDPOINT_RETRY_DELAY_MS = 250;
const LOGS_TIMEOUT_MS = 30_000;
const ATTACHED_PROC_STOP_TIMEOUT_MS = 10_000;
const TAIL_LINES = 50;
// Snapshot create/rm and the reboot-from-snapshot step of the checkpoint
// stop/snapshot/reboot cycle — generous, since a snapshot's size tracks the
// sandbox's actual disk usage (a tiny alpine's was a few MB, but nothing
// here bounds a caller's own workload).
const CHECKPOINT_TIMEOUT_MS = 120_000;
// `msb copy` of a directory scales with its contents, not a fixed small
// payload like exec/logs — generous relative to those.
const COPY_TIMEOUT_MS = 120_000;
// How long the Windows polling follower's terminal fetch keeps retrying an
// `msb logs` invocation that itself keeps failing, once the sandbox is
// already confirmed no longer Running. Never a wait-for-content budget: a
// stopped sandbox's log cannot grow, so the first successful fetch is final.
const TERMINAL_FETCH_FAILURE_BUDGET_MS = 10_000;
// How long `reviveWorkload` gives a freshly-spawned workload-revival exec
// child to prove it isn't an immediate boot failure before treating it as
// the ordinary long-lived case. Unlike `bootRunOnce`'s own attached child,
// there is no separate "reached Running" signal to poll for here — the
// SANDBOX already reports Running regardless of whether this exec succeeds
// — so a short settle window is what that same exit-vs-success race
// collapses to when the only observable signal left is the child's own
// exit. A few multiples of the ordinary poll cadence is plenty: a failing
// workload (bad command, missing binary, an immediate usage error) exits
// within milliseconds of spawn, while a genuine long-lived server never
// exits on its own at all.
const EXEC_REVIVE_SETTLE_MS = READINESS_POLL_MS * 3;
// Bounded retry policy for `msb restore` hitting a Windows access-denied
// failure on its own just-written snapshot artifact (see
// `isRestoreAccessDeniedFailure`) — a brief file-handle release lag that
// normally clears within one retry, so several short-backoff attempts cover
// the real cases without masking a genuinely stuck lock.
const RESTORE_ACCESS_DENIED_RETRY_LIMIT = 3;
const RESTORE_ACCESS_DENIED_RETRY_DELAY_MS = 500;

/**
 * How long `createCheckpoint`'s own reboot step keeps retrying msb's
 * "sandbox already exists" refusal (see `isSandboxAlreadyExistsFailure`),
 * and the pause between attempts — the same install-lock-poll shape
 * `INSTALL_LOCK_RETRY_BUDGET_MS`/`INSTALL_LOCK_RETRY_DELAY_MS` already use.
 * EMPIRICALLY VERIFIED against msb 0.7.1's own source
 * (`prepare_create_target` in `sdk/rust/lib/backend/local/sandbox/create.rs`:
 * `existing.is_some() || dir_exists`): the checkpoint cycle's `rm` can
 * return once the sandbox's database record clears, well before its
 * on-disk directory actually releases on Windows — observed on CI exceeding
 * 3.5s under load — so the very next `restore` under the same name can race
 * that lingering directory into this refusal. A few hundred milliseconds
 * (this backend's earlier retry shape, before this budget existed) is
 * nowhere near enough to outlast that; ~30s at 2s intervals comfortably
 * does, while a refusal that outlives even that still fails clearly instead
 * of hanging. `createCheckpoint`'s reboot now restores under a FRESH name
 * rather than the same one (see its own doc), which avoids this exact race
 * structurally — this budget stays live as dormant defense rather than
 * being removed. See `rebootRetryingAlreadyExists`.
 */
const CHECKPOINT_REBOOT_ALREADY_EXISTS_RETRY_BUDGET_MS = 30_000;
const CHECKPOINT_REBOOT_ALREADY_EXISTS_RETRY_DELAY_MS = 2_000;

/**
 * The boot failure `start()` heals and retries — carries the `msb run`
 * child's combined output for the second-failure diagnostic. Internal to the
 * boot path: never escapes `start()`, which converts a repeat failure into a
 * `BackendError` naming the heal.
 */
class ImageCacheCorruptionError extends Error {
  constructor(readonly output: string) {
    super(`msb image cache corruption:\n${output}`);
  }
}

/**
 * The other boot failure `start()` retries — the spawned `msb run` child hit
 * a failure of msb's own state database, usually the startup-migration race
 * (see `isMsbStateDbError`). No heal step: the race is transient by
 * construction, so a plainly retried boot finds the schema already migrated.
 * Internal to the boot path, like its sibling above.
 */
class StateDbError extends Error {
  constructor(readonly output: string) {
    super(`msb state-database error:\n${output}`);
  }
}

/**
 * True if `output` (an `msb run` invocation's combined output) is msb
 * refusing to run anything while its internal install lock is held. Captured
 * verbatim from windows-2025 hosted runners (once in each sibling CI lane),
 * mid-suite with ordinary boots succeeding on both sides of the failure:
 *
 * ```
 * error: runtime error: microsandbox install operation in progress until
 * 2026-07-31 20:55:04.779845600; retry after it completes
 * error: runtime error: another microsandbox install operation is in progress
 * until 2026-08-01 19:26:19.025098100
 * ```
 *
 * Two phrasings, one condition — msb words the refusal differently depending
 * on which side holds the lock, so the match tolerates the optional "is".
 *
 * The deadline in the message reads ~30 minutes out, but every captured
 * occurrence cleared within the same run — boots seconds later succeeded — so
 * the boot path polls briefly (see `start`) instead of failing on the first
 * refusal or trusting the deadline. Matches on the stable phrase only; the
 * timestamp varies per occurrence.
 */
export function isMsbInstallLockActive(output: string): boolean {
  return /install operation (is )?in progress/.test(output);
}

/** Boot-path classified failure for `isMsbInstallLockActive` — internal to
 * the boot path, like its two siblings above; `start()` owns the retry
 * policy. */
class InstallLockActiveError extends Error {
  constructor(readonly output: string) {
    super(`msb install lock active:\n${output}`);
  }
}

/**
 * Restore-path classified failure for `isRestoreAccessDeniedFailure` — a
 * Windows-only `msb restore` transient against its own just-written
 * snapshot artifact (see that function's own doc). Internal to the boot
 * path, like its siblings above; `bootClassified` owns the bounded-retry
 * policy. Only ever thrown from `bootRestoreOnce`, since it is a restore
 * invocation's own failure signature — an ordinary `run` boot never touches
 * a snapshot artifact at all.
 */
class RestoreAccessDeniedError extends Error {
  constructor(readonly output: string) {
    super(`msb restore access-denied on its own snapshot artifact:\n${output}`);
  }
}

/**
 * Restore-path classified failure for `isSandboxAlreadyExistsFailure` — msb
 * refusing `restore` because a sandbox under this name already exists (its
 * database record, its on-disk directory, or both — see that function's own
 * doc). Internal to the boot path, like its siblings above; only ever
 * thrown from `bootRestoreOnce`. `bootClassified` itself never retries this
 * one (unlike its siblings) — it simply propagates, so the ordinary
 * `start()` path (a `GenericContainer.fromCheckpoint(cp).start()` restore
 * of a name that turns out to still be live) surfaces it immediately, a
 * real error. Only `createCheckpoint`'s own reboot step, via
 * `rebootRetryingAlreadyExists`, retries it — a caller reusing a live name
 * is never this backend's own race to hide, but the checkpoint cycle's own
 * `rm`-then-restore of the SAME name is exactly that race.
 */
class SandboxAlreadyExistsError extends Error {
  constructor(readonly output: string) {
    super(`msb restore refused — a sandbox with this name already exists:\n${output}`);
  }
}

/**
 * How long to wait before retrying a boot that hit msb's state-database
 * error — enough for a winning concurrent invocation's migration transaction
 * to commit; the retry's own `msb run` startup dwarfs this either way.
 */
const STATE_DB_RETRY_DELAY_MS = 500;

/**
 * How long the boot path keeps polling while msb's install-operation lock is
 * held, and the pause between attempts (see `isMsbInstallLockActive`) —
 * observed clearing within seconds despite the message's ~30-minute deadline,
 * so a short budget covers the real cases and a lock outliving it is
 * surfaced as stuck.
 */
const INSTALL_LOCK_RETRY_BUDGET_MS = 30_000;
const INSTALL_LOCK_RETRY_DELAY_MS = 2_000;

/**
 * Fetches one msb invocation's stdout byte-exact (CRLF normalized to LF, but
 * the presence or absence of a trailing newline preserved), unlike `invoke`,
 * whose line-based reconstruction appends a trailing newline to any non-empty
 * output — erasing exactly the signal the Windows polling follower's
 * mid-write holdback keys on (an unterminated tail may have been read
 * mid-write; a newline-terminated one is complete). Rejects on spawn failure,
 * timeout, or a non-zero exit: msb's own internal errors print to stderr and
 * exit non-zero with EMPTY stdout, indistinguishable from a genuinely-empty
 * response unless the exit code is checked.
 */
function fetchStdoutExact(msbPath: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolveFetch, rejectFetch) => {
    const child = spawn(msbPath, args, { stdio: [CLOSED_STDIN, "pipe", "pipe"] });
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
      rejectFetch(new BackendError(`msb ${args.join(" ")} timed out after ${timeoutMs}ms and was force-killed`));
    }, timeoutMs);

    child.once("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      rejectFetch(new BackendError(`failed to spawn 'msb ${args.join(" ")}': ${err.message}`));
    });

    // "close" (not "exit") so both stdio streams have fully flushed before
    // the accumulated text is read.
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        rejectFetch(new BackendError(`msb ${args.join(" ")} exited ${code ?? "unknown"}: ${stderr.trim()}`));
        return;
      }
      resolveFetch(stdout.replace(/\r\n/g, "\n"));
    });
  });
}

/** Renders a heal attempt's outcome for the second-failure message — the
 * heal's own failure (e.g. "image not found") is itself informative to
 * whoever reads the error. */
function describeHeal(heal: ExecResult | unknown): string {
  if (heal !== null && typeof heal === "object" && "exitCode" in heal) {
    const result = heal as ExecResult;
    return result.exitCode === 0
      ? "removed"
      : `'msb image remove' exited ${result.exitCode}: ${result.stderr.trim()}`;
  }
  return `'msb image remove' itself failed to run: ${heal instanceof Error ? heal.message : String(heal)}`;
}

/**
 * True when `ref` (an absolute path ref) looks like a checkpoint artifact
 * this backend itself would have written — a directory named `snap_<hex>`
 * (msb's own snapshot-store naming since 0.7.1 — see
 * `parseSnapshotCreateArtifactPath`) containing a `snapshot.json` file, the
 * same shape `hasCheckpoint` checks for. `removeCheckpoint`'s recursive
 * delete is gated on this: `ref` is caller-supplied (a corrupt or
 * hand-edited registry entry), and skipping the shape check would let an
 * arbitrary path get `fs.rm(..., { recursive: true })`'d just because it
 * happened to be passed in as a "ref".
 */
async function looksLikeCheckpointArtifactDir(ref: string): Promise<boolean> {
  if (!/^snap_[0-9a-f]+$/i.test(path.basename(ref))) {
    return false;
  }
  const stat = await fs.stat(ref).catch(() => undefined);
  if (stat === undefined || !stat.isDirectory()) {
    return false;
  }
  return fs
    .access(path.join(ref, "snapshot.json"))
    .then(() => true)
    .catch(() => false);
}

interface HandleState {
  attached: ChildProcess | undefined;
  // True once the attached `msb run` child has actually exited. The attached
  // child IS msb's supervisor for the sandbox's whole lifetime (confirmed
  // against the real msb binary — SIGKILLing it transitions the microVM to
  // Stopped, and it only exits once `msb stop` runs), so under normal
  // operation this stays false until stop() itself causes the exit. It
  // exists to guard the one case where the child is no longer around to
  // notify anyone: if it already died before stop() runs (crashed, or killed
  // by something external), Node's ChildProcess never replays a past "exit"
  // event to a listener added after the fact, so a fresh one-shot listener
  // attached inside stop() would wait out the full
  // ATTACHED_PROC_STOP_TIMEOUT_MS for an event that already happened and
  // will never fire again.
  attachedExited: boolean;
  resources: ExecTunnel[];
  logTail: string[];
  // The workload argv `createCheckpoint` captured from this sandbox's guest
  // — via `captureGuestWorkloadCmdline` — during its MOST RECENT checkpoint
  // call, when that call's source spec had no explicit `command`. Survives
  // past that call so `capturedWorkloadCommand()` can hand it back to
  // `GenericContainer.checkpoint()` for the named-checkpoint registry write;
  // `undefined` whenever nothing was captured (explicit command, no
  // checkpoint taken yet, or a capture attempt that itself failed).
  capturedCommand: string[] | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Drains a child's merged stdout+stderr line-by-line into `onLine`, keeping
 * no more than `TAIL_LINES` for diagnostics. Returns a promise that settles
 * once the stream ends, so callers can await "everything this child will
 * ever print has been seen" without polling.
 */
function drainTail(stream: NodeJS.ReadableStream, tail: string[]): Promise<void> {
  return new Promise((resolveDrain) => {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => {
      tail.push(line);
      if (tail.length > TAIL_LINES) {
        tail.shift();
      }
    });
    rl.on("close", () => resolveDrain());
  });
}

/**
 * Busybox-ash-compatible: finds the first non-kernel child of PID 1 in the
 * guest and prints its `/proc/<pid>/cmdline` RAW — NUL-separated with a
 * trailing NUL, the kernel's own on-disk shape, never re-encoded by this
 * script itself — to stdout, exit 0; exits 1 if none is found. Walks
 * every `/proc/<pid>/stat` in NUMERIC pid order (`ls | sort -n`, since a bare
 * shell glob sorts lexically — "10" before "2" — which is wrong for "the
 * first child") and, for each, reads field 4 (`ppid`, 1-indexed per
 * `/proc/pid/stat`'s own `pid (comm) state ppid ...` layout), skipping any
 * whose `ppid` isn't `1`. `comm` is split out via the FIRST `(` and the LAST
 * `)` (`${st#*(}` / `${comm%)*}`, both plain POSIX parameter expansion, no
 * `extglob` needed) rather than a naive single-`(`/`)` split, since a
 * process name may itself contain spaces (or, in principle, parens) — the
 * same robustness a greedy sed capture between the first "(" and the last
 * ")" would get. Two names are excluded even though
 * their `ppid` may show `1`: the guest's own init (`init.krun`) and any
 * bracketed kernel-thread name (`[kworker/0:1]`, `[ksoftirqd/0]`, ...) — the
 * shape every kernel thread's `comm` renders as. Read by `MsbCliBackend`'s
 * own `createCheckpoint`, BEFORE it stops the source sandbox — see that
 * method's own doc — via a plain `exec`, never anything backend-specific
 * beyond that: this is guest-side shell, not msb CLI surface.
 */
const CAPTURE_WORKLOAD_CMDLINE_SCRIPT = [
  // A marker comment, not functional shell — lets the msb fixture (and any
  // future test double) recognize this exact exec call by its script
  // content rather than guessing from argv shape alone.
  "# rightsize:capture-workload-cmdline",
  "for pid in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$' | sort -n); do",
  "  st=$(cat /proc/$pid/stat 2>/dev/null) || continue",
  "  rest=${st##*) }",
  "  set -- $rest",
  "  ppid=$2",
  "  if [ \"$ppid\" != \"1\" ]; then continue; fi",
  "  comm=${st#*(}",
  "  comm=${comm%)*}",
  "  case \"$comm\" in",
  "    init.krun|\\[*\\]) continue ;;",
  "  esac",
  "  cat /proc/$pid/cmdline",
  "  exit 0",
  "done",
  "exit 1",
].join("\n");

/**
 * Parses `CAPTURE_WORKLOAD_CMDLINE_SCRIPT`'s stdout — the discovered
 * process's raw `/proc/<pid>/cmdline` bytes, NUL-separated with a trailing
 * NUL — into an argv. `captureGuestWorkloadCmdline` fetches this through the
 * ordinary `exec()` (`invoke()`'s line-based reconstruction, not
 * `fetchStdoutExact`'s byte-exact one — see that function's own doc), which
 * appends a trailing `\n` to any non-empty output; since the guest script's
 * own output never contains a real newline of its own (it is exactly the
 * NUL-joined cmdline bytes), that single appended `\n` is always the whole
 * of `invoke()`'s own last "line" and is stripped here before splitting,
 * rather than being read back as a bogus trailing argv element. `undefined`
 * on anything that isn't a clean, non-empty argv after that: empty output
 * (the script found no matching child, exited 1, or the guest's own cmdline
 * was itself empty) or content that splits into zero non-empty tokens. Never
 * throws — see `captureGuestWorkloadCmdline`'s own doc on why a capture
 * failure must never fail the checkpoint that triggered it.
 */
function parseCapturedWorkloadCmdline(stdout: string): string[] | undefined {
  if (stdout.length === 0) {
    return undefined;
  }
  const withoutTrailingNewline = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  const parts = withoutTrailingNewline.split("\0").filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/**
 * The attached-mode CLI driver: every sandbox this backend starts runs as a
 * held child process (`msb run`, no `-d`) because detached mode never
 * executes the image's own ENTRYPOINT/CMD — only attached mode does.
 * Readiness is never inferred from that child's own output; it comes from
 * polling `msb ls --format json` until the name shows `"Running"`. The
 * attached child's stdout/stderr carries msb's own boot diagnostics and is
 * kept only for pre-Running failure messages — it is not a dependable
 * workload-log source (on Windows it does not relay guest stdout at all);
 * workload logs are always fetched through the `msb logs` channel.
 *
 * `create()` on the `BackendProvider` interface is synchronous, but locating
 * (and possibly downloading) the pinned `msb` binary is inherently async.
 * The seam: this backend holds a memoized `ensureInstalled()` promise and
 * every method awaits it once before doing anything else, so construction
 * stays cheap and the actual provisioning happens lazily on first use.
 */
export class MsbCliBackend implements SandboxBackend {
  /** `"microsandbox"` — matched against `RIGHTSIZE_BACKEND` and used in `dev.rightsize.runId`-style diagnostics. */
  readonly name = "microsandbox";
  readonly supportsNativeNetworks = false;
  /** Each sandbox is its own microVM with its own kernel; checkpoint/restore is a disk snapshot, which restarts the workload. */
  readonly capabilities: BackendCapabilities = {
    /** Each sandbox is a microVM with its own kernel. */
    hardwareIsolated: true,
    /** Disk-snapshot checkpoint/restore via `msb snapshot`. */
    checkpoint: true,
    /** The stop/snapshot/reboot cycle reboots the microVM — the workload restarts. */
    checkpointRestartsWorkload: true,
  };

  // Both keyed by a sandbox's CURRENT name (== SandboxHandle.id) — normally
  // stable for a handle's whole lifetime, except across createCheckpoint's
  // own reboot, which re-keys both from the source sandbox's name to the
  // fresh one it boots under (see that method's own doc).
  private readonly handles = new Map<string, HandleState>();
  private readonly startedNames = new Set<string>();
  // Mirrors msbPathPromise's eventual value as soon as it settles, purely so
  // cleanupSync (the synchronous process-exit path, which cannot await
  // anything) has a best-effort synchronous read of it. Never written to
  // except by this one .then() below; never awaited anywhere else.
  private resolvedMsbPath: string | undefined;
  // Test-only override seam for rebootRetryingAlreadyExists' own budget/delay
  // — defaults to the real CHECKPOINT_REBOOT_ALREADY_EXISTS_RETRY_BUDGET_MS/
  // _DELAY_MS constants so production behavior is unchanged. Without this, a
  // budget-exhaustion red-proof would mean a unit test actually blocking for
  // the real ~30s; a test reaches these the same way it already reaches
  // `handles`/`startedNames` elsewhere in this suite — an unsafe cast — to
  // shrink them to milliseconds instead.
  private checkpointRebootAlreadyExistsRetryBudgetMs = CHECKPOINT_REBOOT_ALREADY_EXISTS_RETRY_BUDGET_MS;
  private checkpointRebootAlreadyExistsRetryDelayMs = CHECKPOINT_REBOOT_ALREADY_EXISTS_RETRY_DELAY_MS;

  constructor(private readonly msbPathPromise: Promise<string>) {
    this.msbPathPromise.then(
      (p) => {
        this.resolvedMsbPath = p;
      },
      () => {
        // Provisioning failed: cleanupSync has nothing to clean up with
        // either, and every other method will surface the same rejection
        // when it awaits msbPathPromise itself.
      },
    );
  }

  private async msbPath(): Promise<string> {
    return this.msbPathPromise;
  }

  async create(spec: ContainerSpec): Promise<SandboxHandle> {
    this.handles.set(spec.name, { attached: undefined, attachedExited: false, resources: [], logTail: [], capturedCommand: undefined });
    return { id: spec.name, spec };
  }

  /**
   * Boots via `bootOnce`, retrying two classified transient failures once
   * each. A boot that hit msb's state-database error — usually the
   * startup-migration race (see `isMsbStateDbError`) — is retried after a
   * short delay with no heal step; the race is transient by construction. On a first failure carrying msb's
   * image-cache-corruption signature (see `isImageCacheCorruption`), heals by removing
   * just the affected image's cache entry (`msb image remove <image>`, result
   * ignored — including "image not found", since the real signal is whether
   * the retried boot succeeds, not whether removal reported success) and
   * retries the boot exactly once. A second identical failure surfaces an
   * error naming the image and the attempted heal instead of retrying
   * further. The heal is scoped to the one image reference — never the whole
   * cache directory, and never any sandbox state.
   *
   * The failed first attempt never reached Running, so `state.attached` and
   * `startedNames` (both populated only on success, inside `bootOnce`) carry
   * no state from it to double-register, and its child has already been
   * reaped there.
   *
   * Two corruption shapes were found empirically and the same one command
   * heals both: the failing image's manifest was never committed to msb's
   * cache database (a concurrent pull lost the race for a shared base layer
   * before its own manifest write landed) — `image remove` reports "image not
   * found" and the retry succeeds anyway, because by then the concurrent
   * winner has finished materializing the shared layer — or the manifest IS
   * committed but the cache file backing one of its layers is gone, where
   * `image remove` clears the stale entry and the retry re-pulls from
   * scratch.
   */
  async start(handle: SandboxHandle): Promise<void> {
    const msbPath = await this.msbPath();
    const state = this.handles.get(handle.id);
    if (state === undefined) {
      throw new BackendError(`no handle state for sandbox '${handle.id}' — create() was never called for it`);
    }
    await this.bootClassified(msbPath, handle, state);
  }

  /**
   * A boot attempt wrapped in every classified-transient retry this backend
   * knows: the install-lock poll, the one-shot state-database retry, and the
   * one-shot image-cache heal. Both the ordinary `start()` path and the
   * checkpoint cycle's post-snapshot reboot come through here — a reboot
   * from a snapshot (now `msb restore ...`, see `bootRestoreOnce`) is
   * as exposed to msb's transients as any other boot, and skipping the
   * classification there turned a passing install-lock poll into an
   * immediate checkpoint failure on a live Windows run. The image-cache heal
   * targets `handle.spec.image`, which for a restore is the checkpoint ref
   * GenericContainer.fromCheckpoint() threaded through as the builder's
   * "image" — never a real OCI reference `msb image remove` can act on
   * meaningfully; this predates the 0.7.1 migration (the same was true of
   * `--from-snapshot` boots) and is unchanged here.
   */
  private async bootClassified(msbPath: string, handle: SandboxHandle, state: HandleState): Promise<void> {
    let firstOutput: string;
    try {
      await this.bootOnce(msbPath, handle, state);
      return;
    } catch (first) {
      if (first instanceof InstallLockActiveError) {
        // msb refuses `run` outright while its internal install lock is held
        // (see isMsbInstallLockActive). The message names a deadline ~30
        // minutes out, but every captured occurrence cleared within the same
        // test run — boots seconds later succeeded — so this polls briefly
        // rather than trusting the deadline. The budget expiring surfaces the
        // last refusal: a lock held that long really is stuck, and waiting
        // here would only hide it.
        const deadline = Date.now() + INSTALL_LOCK_RETRY_BUDGET_MS;
        let last = first;
        while (Date.now() < deadline) {
          await sleep(INSTALL_LOCK_RETRY_DELAY_MS);
          try {
            await this.bootOnce(msbPath, handle, state);
            return;
          } catch (again) {
            if (!(again instanceof InstallLockActiveError)) {
              throw again;
            }
            last = again;
          }
        }
        throw new BackendError(
          `msb run for sandbox ${handle.id} was refused for ${INSTALL_LOCK_RETRY_BUDGET_MS / 1000}s ` +
            `by msb's install-operation lock — every observed occurrence cleared within seconds, so a ` +
            `lock held this long looks like a genuinely stuck msb install on this host.\n${last.output}`,
        );
      }
      if (first instanceof StateDbError) {
        // Usually the startup-migration race, transient by construction (see
        // isMsbStateDbError): the winning msb invocation's migration commits
        // and a retried boot finds the schema in place. No heal step, one
        // retry, second failure propagates — the same one-shot policy as the
        // image-cache heal below.
        await sleep(STATE_DB_RETRY_DELAY_MS);
        try {
          await this.bootOnce(msbPath, handle, state);
          return;
        } catch (second) {
          if (!(second instanceof StateDbError)) {
            throw second;
          }
          throw new BackendError(
            `msb run for sandbox ${handle.id} hit msb's state-database error twice in a row — ` +
              `the usual cause (concurrent msb invocations racing startup migrations) is transient ` +
              `and one retry covers it, so this looks like real state-database trouble on this ` +
              `host.\nfirst attempt:\n${first.output}\nafter retry:\n${second.output}`,
          );
        }
      }
      if (first instanceof RestoreAccessDeniedError) {
        // Windows-only in practice (see isRestoreAccessDeniedFailure's own
        // doc): a brief file-handle release lag on the just-written snapshot
        // artifact right after the source sandbox's own teardown. A short,
        // bounded number of retries covers it without masking a genuinely
        // stuck lock — only ever reached from bootRestoreOnce, since this
        // signature is specific to a restore invocation's own artifact read.
        let last = first;
        for (let attempt = 1; attempt <= RESTORE_ACCESS_DENIED_RETRY_LIMIT; attempt++) {
          await sleep(RESTORE_ACCESS_DENIED_RETRY_DELAY_MS);
          try {
            await this.bootOnce(msbPath, handle, state);
            return;
          } catch (again) {
            if (!(again instanceof RestoreAccessDeniedError)) {
              throw again;
            }
            last = again;
          }
        }
        throw new BackendError(
          `msb restore for sandbox ${handle.id} hit a Windows access-denied failure on its just-written ` +
            `snapshot artifact ${RESTORE_ACCESS_DENIED_RETRY_LIMIT} times in a row — this is normally a ` +
            `brief file-handle release lag that clears within one retry, so a failure held this long looks ` +
            `like a genuinely stuck lock on this host.\n${last.output}`,
        );
      }
      if (!(first instanceof ImageCacheCorruptionError)) {
        throw first;
      }
      firstOutput = first.output;
    }
    const heal: ExecResult | unknown = await invoke(
      msbPath,
      MsbCommands.imageRemove(handle.spec.image),
      STOP_TIMEOUT_MS,
    ).catch((e: unknown) => e);
    try {
      await this.bootOnce(msbPath, handle, state);
    } catch (second) {
      if (!(second instanceof ImageCacheCorruptionError)) {
        throw second;
      }
      throw new BackendError(
        `msb run for sandbox ${handle.id} hit its image cache error twice in a row for image ` +
          `'${handle.spec.image}', even after removing that image's cache entry (${describeHeal(heal)}) ` +
          `and retrying — this is likely a deeper cache corruption than this backend's one-shot heal ` +
          `covers; try clearing the msb image cache by hand ('msb image prune' or removing the cache ` +
          `directory under MSB_HOME).\nfirst attempt:\n${firstOutput}\nafter heal + retry:\n${second.output}`,
      );
    }
  }

  /**
   * One boot attempt, dispatched by shape: an ordinary spec (no
   * `checkpointRef`) drives `run()`'s ATTACHED supervision model
   * (`bootRunOnce`); a checkpoint-restore spec drives `msb restore`'s
   * fundamentally different DETACHED shape (`bootRestoreOnce`) — see each
   * method's own doc. Resets the per-attempt diagnostics tail before either:
   * a retried boot must not blend its tail with the failed attempt's.
   */
  private async bootOnce(msbPath: string, handle: SandboxHandle, state: HandleState): Promise<void> {
    state.logTail = [];
    state.attachedExited = false;

    if (handle.spec.checkpointRef !== undefined) {
      await this.bootRestoreOnce(msbPath, handle, state);
      return;
    }
    await this.bootRunOnce(msbPath, handle, state);
  }

  /**
   * One RUN boot attempt: spawns ATTACHED `msb run`, which stays alive as
   * the sandbox's own supervisor for its whole lifetime, and polls
   * `msb ls --format json` until the name shows Running.
   *
   * `state.attached` and (for non-keepAlive specs) `startedNames` are
   * populated only on success; on any failure the child is reaped here (for
   * the classified early-exit failures it has already exited; a readiness
   * timeout leaves it alive and it is hard-killed) so a failed attempt leaves
   * no live process or registered cleanup state behind — the caller owns
   * retry policy, never cleanup (an exit-0 success without a live child is
   * the one exception: the fast-exit case below, see `isCompletedFastExit`'s
   * own doc). An early exit is classified from the child's combined output:
   * the image-cache-corruption signature throws `ImageCacheCorruptionError`
   * (the one failure `start()` heals and retries), a host-port bind conflict
   * throws `PortBindConflictError`, and otherwise — if the exit code was 0 —
   * `isCompletedFastExit` gets a chance to reclassify the exit as a workload
   * that ran to completion before this poll loop could ever observe Running
   * (msb 0.6.16's convergent-lifecycle rework; see that method's own doc);
   * anything else surfaces the raw output as an ordinary boot failure,
   * unchanged.
   */
  private async bootRunOnce(msbPath: string, handle: SandboxHandle, state: HandleState): Promise<void> {
    const argv = MsbCommands.run(handle.spec);
    const child = spawn(msbPath, argv, { stdio: [CLOSED_STDIN, "pipe", "pipe"] });
    // Merge stdout+stderr into one tail, kept only for the boot diagnostics
    // below: this pipe is the sole carrier of msb's own output (registry/pull
    // errors, crash output printed before the sandbox exists). It is not a
    // dependable workload-log source — on Windows the attached process does
    // not relay guest stdout at all — so logs() never reads it; workload
    // output always comes from a `msb logs` invocation.
    const stdoutDone = drainTail(child.stdout, state.logTail);
    const stderrDone = drainTail(child.stderr, state.logTail);

    let exited: { code: number | null } | undefined;
    child.once("exit", (code) => {
      exited = { code };
      state.attachedExited = true;
    });

    const deadline = Date.now() + FIRST_RUN_PULL_TIMEOUT_MS;
    for (;;) {
      if (exited !== undefined) {
        await Promise.all([stdoutDone, stderrDone]);
        const output = state.logTail.join("\n");
        if (isImageCacheCorruption(output)) {
          throw new ImageCacheCorruptionError(output);
        }
        if (isMsbStateDbError(output)) {
          throw new StateDbError(output);
        }
        if (isMsbInstallLockActive(output)) {
          throw new InstallLockActiveError(output);
        }
        if (isPortBindConflictOutput(output)) {
          throw new PortBindConflictError(`msb run for sandbox ${handle.id} could not bind a host port: ${output}`);
        }
        if (exited.code === 0 && (await this.isCompletedFastExit(msbPath, handle.id))) {
          // The workload ran to completion before this poll loop ever
          // observed Running — see isCompletedFastExit's own doc. Started-
          // and-already-finished: register it exactly like an ordinary
          // successful boot. state.attachedExited is already true (the
          // "exit" listener above set it) and state.attached is left
          // undefined, since there is no live process left to reference —
          // stop() checks attachedExited before it would ever touch
          // state.attached, so it is already safe to call on this handle.
          if (!handle.spec.keepAlive) {
            this.startedNames.add(handle.id);
          }
          return;
        }
        throw new BackendError(
          `msb run for sandbox ${handle.id} exited (code ${exited.code ?? "unknown"}) ` +
            `before reaching Running — check the image entrypoint and 'msb run' ` +
            `output below:\n${output}`,
        );
      }
      if ((await this.runningSandboxNames(msbPath)).has(handle.id)) {
        state.attached = child;
        // keepAlive (reuse) sandboxes must survive this process's own exit —
        // see close() below — so they are never added to the own-run
        // cleanup set in the first place (addendum item 6).
        if (!handle.spec.keepAlive) {
          this.startedNames.add(handle.id);
        }
        return;
      }
      if (Date.now() >= deadline) {
        child.kill("SIGKILL");
        throw new BackendError(
          `Sandbox ${handle.id} did not reach Running within ${FIRST_RUN_PULL_TIMEOUT_MS / 1000}s — this ` +
            `can mean a slow image pull, a crash-looping entrypoint, or msb itself being unresponsive; ` +
            `last output:\n${state.logTail.join("\n")}`,
        );
      }
      await sleep(READINESS_POLL_MS);
    }
  }

  /**
   * One RESTORE boot attempt. `msb restore` is not `run`'s attached
   * supervision model at all — EMPIRICALLY VERIFIED against msb 0.7.1 (its
   * own `restore.rs` doc: "Restore a snapshot into a new detached
   * sandbox"), the restore CLI process exits — typically within seconds,
   * often with little or no stdout — the INSTANT activation succeeds, while
   * the sandbox keeps booting in the background and only reaches Running
   * some time after that (live-confirmed: `msb ls` shows Running, and exec
   * works, only once the restore process has already exited). A clean exit
   * is therefore not itself a completed boot, and a nonzero exit is msb's
   * own failure signal with the reason on stdout/stderr — the inverse of
   * `run`'s attached child, whose exit before Running always means failure.
   *
   * Two phases follow directly from those two facts:
   *   1. Spawn `msb restore ...` and wait for IT to exit, bounded by
   *      `FIRST_RUN_PULL_TIMEOUT_MS` — the same boot budget `bootRunOnce`
   *      polls against; a restore's own activation is exposed to the same
   *      "this could be a slow cold operation" uncertainty a pull is.
   *      Classified from the combined output the same way any boot's early
   *      exit is (install-lock, state-db, image-cache-corruption,
   *      port-bind-conflict — see `bootClassified`'s own doc on why a
   *      restore boot needs the identical classification an ordinary one
   *      gets) — a nonzero, unclassified exit throws an ordinary
   *      `BackendError` carrying the output, same shape as `bootRunOnce`'s.
   *   2. Once it exits 0, poll `msb ls` for the sandbox to reach Running —
   *      the same `READINESS_POLL_MS` cadence and a fresh instance of the
   *      identical `FIRST_RUN_PULL_TIMEOUT_MS` budget the attached path's
   *      own poll uses (so a restore boot gets the identical readiness
   *      patience an ordinary one does, counted from when there is
   *      actually something to poll for rather than shaved out of phase
   *      1's own budget). The sandbox settling on exactly `"Stopped"`, or
   *      its name disappearing from a `msb ls` listing that itself came
   *      back, is a definite failure the moment it is observed — never
   *      worth waiting out the rest of the budget for, unlike a status
   *      that simply hasn't reached Running yet.
   *   3. The `ls` probe itself failing to run or return in time (spawn
   *      error, or the same `LOGS_TIMEOUT_MS` `invoke` enforces on every
   *      other probe) is a different thing entirely from the sandbox's name
   *      being missing from a listing that DID come back, even though both
   *      collapse to the same `undefined` once the probe's own promise is
   *      caught — see `isCompletedFastExit`'s own doc, whose sibling
   *      contract this mirrors: a probe failure must never be upgraded into
   *      a false, specific diagnosis ("disappeared from msb ls entirely" is
   *      exactly that kind of false claim when the truth is just that `ls`
   *      itself didn't answer in time). A failed probe is therefore treated
   *      as "not yet confirmed either way" and retried within budget —
   *      install-lock races and an overloaded msb daemon are the same
   *      transient shapes this file already documents for `run`/`restore`/
   *      `stop`, and one `ls` hiccup during the readiness window must not
   *      turn into a spurious restore failure.
   *
   * The `msb restore` CLI process itself is never held onto — it has already
   * exited by the time phase 2 even starts, and msb itself (out-of-process)
   * is the sandbox's own supervisor from here on, the same as it always was.
   * But a restored sandbox reaches Running with ONLY its guest agent inside
   * — the captured workload never re-executes on its own (EMPIRICALLY
   * VERIFIED against msb 0.7.1) — so once Running is confirmed, this method
   * calls `reviveWorkload` to start it itself BEFORE returning: THAT call is
   * what populates `state.attached` (a workload-revival `msb exec` child,
   * not the restore CLI process), and `stop()`'s ordinary attached-child
   * handling (exit-based death detection, the SIGKILL escalation) applies to
   * IT exactly as it always did for `bootRunOnce`'s own attached `msb run`
   * child. See `reviveWorkload`'s own doc for the full revival contract,
   * including the typed error a checkpoint predating workload-cmdline
   * capture throws instead of booting silently idle.
   */
  private async bootRestoreOnce(msbPath: string, handle: SandboxHandle, state: HandleState): Promise<void> {
    const argv = MsbCommands.restore(handle.spec);
    const child = spawn(msbPath, argv, { stdio: [CLOSED_STDIN, "pipe", "pipe"] });
    const stdoutDone = drainTail(child.stdout, state.logTail);
    const stderrDone = drainTail(child.stderr, state.logTail);

    const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGKILL");
        rejectExit(
          new BackendError(
            `msb restore for sandbox ${handle.id} did not exit within ${FIRST_RUN_PULL_TIMEOUT_MS / 1000}s — ` +
              `msb itself may be unresponsive; last output:\n${state.logTail.join("\n")}`,
          ),
        );
      }, FIRST_RUN_PULL_TIMEOUT_MS);
      child.once("exit", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolveExit(code ?? -1);
      });
    });

    await Promise.all([stdoutDone, stderrDone]);
    const output = state.logTail.join("\n");
    if (isImageCacheCorruption(output)) {
      throw new ImageCacheCorruptionError(output);
    }
    if (isMsbStateDbError(output)) {
      throw new StateDbError(output);
    }
    if (isMsbInstallLockActive(output)) {
      throw new InstallLockActiveError(output);
    }
    if (isPortBindConflictOutput(output)) {
      throw new PortBindConflictError(`msb restore for sandbox ${handle.id} could not bind a host port: ${output}`);
    }
    if (isRestoreAccessDeniedFailure(output)) {
      throw new RestoreAccessDeniedError(output);
    }
    if (isSandboxAlreadyExistsFailure(output)) {
      throw new SandboxAlreadyExistsError(output);
    }
    if (exitCode !== 0) {
      throw new BackendError(
        `msb restore for sandbox ${handle.id} exited (code ${exitCode}) — check the snapshot ref and ` +
          `'msb restore' output below:\n${output}`,
      );
    }

    // Exit 0: the restore CLI's own task is done and it has already
    // detached (see this method's own doc) — poll for Running the same way
    // bootRunOnce does, under a fresh instance of the identical budget.
    const readyDeadline = Date.now() + FIRST_RUN_PULL_TIMEOUT_MS;
    let lastSeenStatus: string | undefined;
    for (;;) {
      const ls = await invoke(msbPath, MsbCommands.ls(), LOGS_TIMEOUT_MS).catch(() => undefined);
      // `ls === undefined` here means the probe itself never came back
      // (spawn error, or its own LOGS_TIMEOUT_MS timing out) — a DIFFERENT
      // thing from a returned listing that genuinely omits the sandbox's
      // name (see this method's own doc, point 3, and `isCompletedFastExit`'s
      // sibling doc). Only a listing that actually came back gets to update
      // `lastSeenStatus` or trigger the Stopped/disappeared fast-fail below;
      // a failed probe falls straight through to the readiness-budget check
      // and is retried, never asserted as "the sandbox disappeared."
      if (ls !== undefined) {
        lastSeenStatus = statusOf(ls.stdout, handle.id);
        if (lastSeenStatus === "Running") {
          // `msb restore` boots a restored sandbox with only its guest agent
          // inside — the captured workload never re-runs on its own (see
          // this method's own doc and `reviveWorkload`'s) — so this backend
          // starts it itself before registering the boot as complete. A
          // `reviveWorkload` failure propagates unclassified: never register
          // `startedNames` for a sandbox whose workload never actually came
          // up.
          await this.reviveWorkload(msbPath, handle, state);
          if (!handle.spec.keepAlive) {
            this.startedNames.add(handle.id);
          }
          return;
        }
        if (lastSeenStatus === "Stopped" || lastSeenStatus === undefined) {
          throw new BackendError(await this.restoreBootFailureMessage(msbPath, handle.id, lastSeenStatus, false));
        }
      }
      if (Date.now() >= readyDeadline) {
        throw new BackendError(await this.restoreBootFailureMessage(msbPath, handle.id, lastSeenStatus, true));
      }
      await sleep(READINESS_POLL_MS);
    }
  }

  /**
   * Renders a restore boot's post-mortem message once its poll for Running
   * has definitely failed (a settled `"Stopped"`, the name disappearing
   * from `msb ls` outright, or the readiness budget itself running out).
   * `msb restore` itself already exited 0 by this point, so the CLI
   * process's own output (already surfaced for a nonzero exit, above) has
   * nothing left to add — `msb logs --source system` is the one channel
   * that can still show what happened to the sandbox's own background boot
   * (see `MsbCommands.systemLog`'s own doc and `isCompletedFastExit`, its
   * other caller). Best-effort: a failed probe falls back to a plain "no
   * output" note rather than letting a diagnostics-gathering failure itself
   * throw and mask the real one.
   */
  private async restoreBootFailureMessage(
    msbPath: string,
    id: string,
    status: string | undefined,
    timedOut: boolean,
  ): Promise<string> {
    const systemLog = await invoke(msbPath, MsbCommands.systemLog(id), LOGS_TIMEOUT_MS).catch(() => undefined);
    const diagnostics =
      systemLog !== undefined && systemLog.stdout.trim() !== ""
        ? `'msb logs ${id} --source system' output:\n${systemLog.stdout}`
        : `'msb logs ${id} --source system' produced no output`;
    // `status` is the last CONFIRMED status a returned `msb ls` listing
    // actually reported — never a value fabricated from a failed probe (see
    // bootRestoreOnce's own doc, point 3): `undefined` here on the timedOut
    // branch means every `ls` probe across the whole readiness budget failed
    // to even come back, not that a listing came back without the name in
    // it (that is the non-timedOut, "disappeared" branch below, which is
    // only ever reached from a listing that DID come back).
    const reason = timedOut
      ? `did not reach Running within ${FIRST_RUN_PULL_TIMEOUT_MS / 1000}s of 'msb restore' exiting ` +
        `(last confirmed status: ${status ?? "none — 'msb ls' never returned a usable listing"})`
      : status === undefined
        ? `disappeared from 'msb ls' entirely`
        : `settled as '${status}' in 'msb ls'`;
    return `sandbox ${id} was restored ('msb restore' exited 0) but ${reason} before ever reaching Running — ${diagnostics}`;
  }

  /**
   * Starts the workload a restore itself never re-runs. EMPIRICALLY VERIFIED
   * against msb 0.7.1: a restored sandbox reaches Running with ONLY its
   * guest agent inside (`guest ps` shows `/init.krun` and kernel threads —
   * the captured workload command does not re-execute; `msb start`/`msb
   * logs` on such a sandbox are equally idle/empty). Only ever called from
   * `bootRestoreOnce`, once it has confirmed Running — see this class's own
   * doc on `bootRestoreOnce`.
   *
   * Spawns a LONG-LIVED, attached `msb exec [-e K=V]... <name> -- <argv>`
   * session (`MsbCommands.execWithEnv`, env from `handle.spec.env` — a
   * restore's own `msb restore` has no `-e`/`--env` flag at all, so this exec
   * is the one place a restored sandbox's guest ever sees it again) — this
   * becomes the sandbox's own workload from here on, and exec sessions are
   * exactly what msb's own log capture records (the primary session's
   * stdout/stderr land in `exec.log`, served by `msb logs`/`-f` — see
   * `MsbCommands.exec`'s own doc). This exec child slots into the EXACT SAME
   * `state.attached` role `bootRunOnce`'s own attached `msb run` child fills
   * for an ordinary boot: child-exit-based death detection, reap-on-stop
   * (`stop()`'s SIGKILL escalation), and every other attached-child teardown
   * semantic apply to it unchanged — the detached-restore round left that
   * slot merely optional, never removed it.
   *
   * `handle.spec.command` is ALREADY the fully-resolved workload argv by the
   * time this runs, in priority order: an explicit command the source
   * container carried, or — when it had none — the guest cmdline
   * `createCheckpoint` captured at checkpoint time, merged in by
   * `createCheckpoint` itself (for its own immediate reboot) or by
   * `fromCheckpointRegistryEntry` (for a registry-mediated restore, same or
   * later process — see both functions' own docs). `undefined` here means
   * NEITHER source exists — an old registry entry predating capture, or one
   * whose capture attempt itself failed — so this throws
   * `CheckpointWorkloadCommandMissingError` itself rather than depending on
   * a caller to have checked first: never boot a restored sandbox silently
   * idle.
   *
   * The exec child gets a brief settle window (`EXEC_REVIVE_SETTLE_MS`) to
   * prove it isn't an immediate boot failure before this returns success —
   * mirroring `bootRunOnce`'s own exit-vs-Running race, except a restore's
   * exec session has no separate "Running" signal of its own to poll for
   * (the SANDBOX already reports Running regardless of whether this exec
   * succeeds), so a settle window is what that race collapses to here. An
   * exit observed within the window is classified exactly like
   * `bootRunOnce`'s own early exit: exit 0 counts as success only when
   * `isCompletedFastExit` ALSO confirms it (the sandbox itself settled
   * Stopped with the boot-completion marker — the repo's existing fast-exit-
   * completion semantics, reused verbatim); any other exit — nonzero, or
   * exit 0 without that confirmation — throws a `BackendError` carrying the
   * exec child's own output, the same failure shape an attached run's early
   * exit already has.
   */
  private async reviveWorkload(msbPath: string, handle: SandboxHandle, state: HandleState): Promise<void> {
    const command = handle.spec.command;
    if (command === undefined) {
      throw new CheckpointWorkloadCommandMissingError(handle.spec.checkpointRef ?? handle.id);
    }

    state.logTail = [];
    const argv = MsbCommands.execWithEnv(handle.id, handle.spec.env, command);
    const child = spawn(msbPath, argv, { stdio: [CLOSED_STDIN, "pipe", "pipe"] });
    const stdoutDone = drainTail(child.stdout, state.logTail);
    const stderrDone = drainTail(child.stderr, state.logTail);

    let exited: { code: number | null } | undefined;
    child.once("exit", (code) => {
      exited = { code };
      state.attachedExited = true;
    });

    const settleDeadline = Date.now() + EXEC_REVIVE_SETTLE_MS;
    while (exited === undefined && Date.now() < settleDeadline) {
      await sleep(READINESS_POLL_MS);
    }

    if (exited === undefined) {
      // Stayed up through the whole settle window — the ordinary long-lived
      // case. Slots into state.attached exactly like bootRunOnce's own
      // attached child.
      state.attached = child;
      return;
    }

    await Promise.all([stdoutDone, stderrDone]);
    const output = state.logTail.join("\n");
    if (exited.code === 0 && (await this.isCompletedFastExit(msbPath, handle.id))) {
      // Mirrors bootRunOnce's own fast-exit success case: the workload ran to
      // completion so quickly this settle window caught its natural exit
      // rather than a crash. No live child left to hold onto — state.attached
      // stays undefined, same as bootRunOnce's own fast-exit branch.
      return;
    }
    throw new BackendError(
      `msb exec for sandbox ${handle.id}'s revived workload exited (code ${exited.code ?? "unknown"}) before ` +
        `staying up — check the workload command and its output below:\n${output}`,
    );
  }

  /**
   * Best-effort: execs `CAPTURE_WORKLOAD_CMDLINE_SCRIPT` in `handle`'s guest
   * and parses its stdout via `parseCapturedWorkloadCmdline`. Only ever
   * called from `createCheckpoint`, BEFORE it stops the sandbox (see that
   * method's own doc), and only when `handle.spec.command` is undefined — an
   * explicit command needs no capture. Never throws: an exec failure
   * (nonzero exit, the exec channel itself erroring) and unparseable output
   * both resolve `undefined` rather than failing the checkpoint — the
   * captured cmdline is a best-effort fallback, and its absence is fully
   * handled later, at restore time (`reviveWorkload` throws
   * `CheckpointWorkloadCommandMissingError` when neither an explicit nor a
   * captured command exists).
   */
  private async captureGuestWorkloadCmdline(handle: SandboxHandle): Promise<string[] | undefined> {
    try {
      const result = await this.exec(handle, ["sh", "-c", CAPTURE_WORKLOAD_CMDLINE_SCRIPT]);
      if (result.exitCode !== 0) {
        return undefined;
      }
      return parseCapturedWorkloadCmdline(result.stdout);
    } catch {
      return undefined;
    }
  }

  /**
   * SPI implementation of `SandboxBackend.capturedWorkloadCommand` — see its
   * own doc. Reads back whatever `createCheckpoint` most recently stashed on
   * this sandbox's `HandleState` (keyed by name, so it survives the
   * stop/snapshot/reboot cycle's own handle-object churn); `undefined` if
   * this sandbox was never checkpointed, or its checkpoint needed no
   * capture, or the capture attempt failed.
   */
  capturedWorkloadCommand(handle: SandboxHandle): ReadonlyArray<string> | undefined {
    return this.handles.get(handle.id)?.capturedCommand;
  }

  /**
   * The fast-exit post-mortem classification: only ever consulted from
   * `bootRunOnce` above, and only once the attached `msb run` child has already
   * exited with code 0 before Running was observed. msb 0.6.16's
   * convergent-lifecycle rework means a workload that finishes quickly is
   * never observed `"Running"` at all — only `"Starting"`, then the attached
   * process exits 0 as the microVM's own natural completion — which by
   * itself is indistinguishable from a genuinely dead boot (the msb
   * 0.6.10-0.6.13 Windows agentless-death failures also exited 0 before
   * Running). Two signals, BOTH required, tell the two apart: `msb ls`
   * reports the sandbox's own state as exactly `"Stopped"` (a settled entry —
   * missing or some other status does not count), AND its system log carries
   * the boot-completion marker msb's guest agent writes only once it has
   * actually come up (see `hasSandboxStartedMarker`) — the agentless-death
   * failures never produced it, since the agent never came up in them.
   *
   * Either probe failing to even run (spawn error, timeout — `invoke` only
   * rejects on those, never on exit code) is treated the same as a missing
   * signal, never as a reason to throw a different error from this method:
   * a probe failure must never be upgraded into a false "it completed
   * successfully", and the caller's own fallback error already covers "this
   * could not be classified as success."
   */
  private async isCompletedFastExit(msbPath: string, id: string): Promise<boolean> {
    const ls = await invoke(msbPath, MsbCommands.ls(), LOGS_TIMEOUT_MS).catch(() => undefined);
    if (ls === undefined || statusOf(ls.stdout, id) !== "Stopped") {
      return false;
    }
    const systemLog = await invoke(msbPath, MsbCommands.systemLog(id), LOGS_TIMEOUT_MS).catch(() => undefined);
    return systemLog !== undefined && hasSandboxStartedMarker(systemLog.stdout);
  }

  async stop(handle: SandboxHandle): Promise<void> {
    const msbPath = await this.msbPath();
    const state = this.handles.get(handle.id);
    if (state !== undefined) {
      for (const tunnel of state.resources) {
        await tunnel.close().catch(() => {});
      }
      state.resources = [];
    }
    await invoke(msbPath, MsbCommands.stop(handle.id), STOP_TIMEOUT_MS).catch(() => {});
    const attached = state?.attached;
    // The attached child is either an ordinary boot's `msb run` process —
    // msb's own supervisor for this sandbox, staying alive for its entire
    // lifetime — or, for a restored sandbox, the `msb exec` session
    // `reviveWorkload` spawned to revive its captured workload (msb itself,
    // out-of-process, is the actual supervisor there; this exec child is
    // just the workload session riding inside it). Either way it stays alive
    // until the sandbox itself stops, and only exits once the `msb stop`
    // call just above lands, so the common path here is "attach a listener,
    // then observe the exit that our own stop just caused." state.attachedExited
    // exists for the other case: if the child
    // had already died before this method ever ran (crashed, or killed by
    // something external), start()'s own listener already flipped it, and
    // Node never replays a past "exit" event to a listener attached after
    // the fact — without this check, stop() would attach a listener for an
    // event that will never come and wait out the full timeout before
    // falling back to SIGKILL.
    //
    // `attached.kill("SIGKILL")` below is the escalation path, not the
    // graceful one — the graceful stop is the `msb stop` invocation above,
    // which already ran and quiesced the sandbox before this ever fires. On
    // Windows, `ChildProcess.kill()` ignores the signal name entirely and
    // always calls `TerminateProcess` (Windows has no real signal delivery
    // at the Node level), so this escalation is already a hard terminate
    // there regardless of which signal string is passed; nothing about the
    // ordering above needs to change because the graceful step was already
    // the `msb stop` call, not a signal to this child.
    if (attached !== undefined && state !== undefined && !state.attachedExited) {
      const exitedInTime = await new Promise<boolean>((resolveWait) => {
        const timer = setTimeout(() => resolveWait(false), ATTACHED_PROC_STOP_TIMEOUT_MS);
        attached.once("exit", () => {
          clearTimeout(timer);
          resolveWait(true);
        });
      });
      if (!exitedInTime) {
        attached.kill("SIGKILL");
      }
    }
    if (state !== undefined) {
      state.attached = undefined;
    }
  }

  async remove(handle: SandboxHandle): Promise<void> {
    const msbPath = await this.msbPath();
    await invoke(msbPath, MsbCommands.rm(handle.id), STOP_TIMEOUT_MS).catch(() => {});
    this.startedNames.delete(handle.id);
    this.handles.delete(handle.id);
  }

  /**
   * `createCheckpoint`'s own reboot step, with msb's "sandbox already
   * exists" refusal (`SandboxAlreadyExistsError`, see
   * `isSandboxAlreadyExistsFailure`'s own doc) retried on a bounded budget
   * instead of surfaced immediately. Originally written because the
   * checkpoint cycle's `rm` right before this can return once the sandbox's
   * database record clears, well before its on-disk directory actually
   * releases on a loaded Windows host, so a `restore` under the SAME name
   * could race that lingering directory straight into msb's own refusal —
   * see `CHECKPOINT_REBOOT_ALREADY_EXISTS_RETRY_BUDGET_MS`'s own doc. The
   * reboot this now guards restores under a FRESH name instead (see
   * `createCheckpoint`'s own doc), which sidesteps that exact race
   * structurally — a name nothing else has ever used cannot collide with a
   * lingering directory belonging to a name nothing will ever restore under
   * again. This retry stays as DORMANT DEFENSE regardless: it is cheap,
   * still correct if `SandboxAlreadyExistsError` were ever hit for some
   * other reason, and simply will not trigger on the ordinary path anymore.
   *
   * `this.checkpointRebootAlreadyExistsRetryBudgetMs`/`_RetryDelayMs` back
   * this loop rather than the bare module constants directly, so a
   * budget-exhaustion test can shrink them to milliseconds instead of
   * actually blocking for the real ~30s — see those fields' own doc.
   *
   * Only `SandboxAlreadyExistsError` is retried here; any other failure
   * `bootClassified` throws (on the first attempt or a later one) propagates
   * immediately, unretried — this exists for exactly the one known-transient
   * signature, not as a generic reboot retry. Never reached by the ordinary
   * `start()` path: a `GenericContainer.fromCheckpoint(cp).start()` restore
   * of a fresh name calls `bootClassified` directly, whose own catch chain
   * has never caught `SandboxAlreadyExistsError` and still doesn't — an
   * already-exists failure there (only reachable if a caller reuses a name
   * that is still live) keeps propagating as-is, a real error rather than
   * this backend's own release race to paper over.
   */
  private async rebootRetryingAlreadyExists(msbPath: string, handle: SandboxHandle, state: HandleState): Promise<void> {
    try {
      await this.bootClassified(msbPath, handle, state);
      return;
    } catch (first) {
      if (!(first instanceof SandboxAlreadyExistsError)) {
        throw first;
      }
      const deadline = Date.now() + this.checkpointRebootAlreadyExistsRetryBudgetMs;
      let last = first;
      while (Date.now() < deadline) {
        await sleep(this.checkpointRebootAlreadyExistsRetryDelayMs);
        try {
          await this.bootClassified(msbPath, handle, state);
          return;
        } catch (again) {
          if (!(again instanceof SandboxAlreadyExistsError)) {
            throw again;
          }
          last = again;
        }
      }
      throw new BackendError(
        `msb restore for sandbox ${handle.id} kept hitting msb's "sandbox already exists" refusal for ` +
          `${this.checkpointRebootAlreadyExistsRetryBudgetMs / 1000}s — msb's own on-disk sandbox directory ` +
          `can lag its database record's own release on a loaded Windows host well past a short wait, but a ` +
          `refusal held this long looks like a genuinely stuck sandbox rather than a release race.\n${last.output}`,
      );
    }
  }

  /**
   * The stop/snapshot/reboot cycle: `msb stop <name>` (reusing this
   * backend's own `stop()`, which also quiesces the attached child and any
   * network-link tunnels), `msb snapshot create --from-sandbox <name> <ref>`
   * (whose printed artifact path — never `ref` itself — becomes the
   * EFFECTIVE checkpoint ref this method returns; see
   * `parseSnapshotCreateArtifactPath`), then `msb rm <name>` followed by
   * `msb restore <effective-ref> --name <fresh-name>` of a FRESH name from
   * that snapshot (via `bootRestoreOnce`, see `MsbCommands.restore`'s own
   * doc — no `--disk-only`, which a disk-scope snapshot rejects) — never
   * `msb start`. The fresh name — never the original — is minted by
   * `nextSandboxName()` (the same generator `GenericContainer.start()`'s own
   * ordinary boot loop uses; see `core/sandbox-name.ts`) because msb's own
   * restore-time collision check (`existing.is_some() || dir_exists`) can
   * still see the just-`rm`-ed sandbox's on-disk directory as present for a
   * window after `msb rm` returns — EMPIRICALLY VERIFIED on Windows CI, that
   * directory has outlived the database record by more than 3.5 seconds
   * under load (see `CHECKPOINT_REBOOT_ALREADY_EXISTS_RETRY_BUDGET_MS`'s own
   * doc). A same-name restore only ever RETRIES through that race; a
   * different name sidesteps it structurally — a name nothing else is using
   * can never collide with a lingering directory. On success, this method
   * mutates `handle.id` and `handle.spec` (name only — see below) IN PLACE
   * on the caller's own `handle`, so every subsequent operation against it
   * (exec/logs/stop/rm, and — one layer up, via the SAME `SandboxHandle`
   * reference — `GenericContainer.checkpoint()`'s own post-reboot
   * `installNetworkLinks`/wait-strategy re-run and `capturedWorkloadCommand()`
   * call) targets the sandbox actually running now. `SandboxBackend`'s own
   * interface doc calls `SandboxHandle` "immutable" — this is the one
   * carve-out, and only this method makes it: a checkpoint reboot is the one
   * operation that changes what sandbox a handle even refers to. `ports`,
   * `env`, and `memoryLimitMb` are untouched by the rename — same ports, env,
   * and memory ceiling as before the reboot, only the name differs.
   * Upstream's
   * detached-start path (`Sandbox::start_detached`) passes
   * `CREATE_BREAKAWAY_FROM_JOB` on Windows, which `ERROR_ACCESS_DENIED`s
   * outright whenever the msb CLI runs inside a job object that doesn't
   * grant breakaway rights — a Gradle/cargo/node test runner on a hosted
   * Windows runner, or any process that embeds this library inside its own
   * restrictive job object — and that denial is deterministic, not
   * transient, so no retry shape fixes it. Before 0.7.1, attached `msb run`
   * (including its `--from-snapshot` boots) never hit this, which is why the
   * reboot has always gone through the classified boot path (`bootClassified`)
   * rather than `msb start`. `msb restore` has no attached/detached
   * distinction of its own — its CLI process always calls `sandbox.detach()`
   * internally and exits once activation is confirmed (see
   * `bootRestoreOnce`'s own doc on why its exit is a SUCCESS signal, not
   * something to reap) — so whether it shares upstream's
   * `CREATE_BREAKAWAY_FROM_JOB` path on Windows is NOT verified here: this
   * backend never runs the real msb binary (see this repo's hard "never boot
   * a sandbox" rule), so this is a real open question for CI, not something
   * this migration could confirm either way. If it recurs, it will surface
   * as an ordinary unclassified `BackendError` out of `bootRestoreOnce`
   * (deterministic exit-code failure, not one of the classified transients
   * above), the same shape a genuine breakaway denial always took.
   * `rm`-ing the sandbox first and restoring a fresh one under a fresh
   * name, same ports/memory (via a spec identical to `handle.spec` except
   * `name`/`checkpointRef` set to the fresh name and the EFFECTIVE ref this
   * method discovers, below — env is no longer threaded through at all, see
   * `MsbCommands.restore`) reproduces the exact same observable contract
   * MODULO the name itself, which was always an implementation detail, not
   * part of what a checkpoint promises to preserve. This backend's own
   * `handles`/`startedNames` registries ARE re-keyed from the old name to
   * the new one (see below), and the fresh name is tracked in the reaping
   * ledger before the restore is even attempted, exactly like an ordinary
   * `create()` — the old name's own ledger entry is deliberately left alone,
   * for the ledger's existing not-found-tolerant sweep to find (it was
   * already `msb rm`-ed above). Its workload restarts from scratch (the VM
   * reboots), which is why `capabilities.checkpointRestartsWorkload` is
   * `true` here and the generic layer re-runs the wait strategy after this
   * returns — AFTER `bootRestoreOnce` has already revived the workload
   * itself via `reviveWorkload` (see that method's own doc): `msb restore`
   * boots the reboot idle, only the guest agent inside, so `bootRestoreOnce`
   * no longer leaves `state.attached` untouched the way it did before this
   * revival step existed — it now carries the workload-revival exec child,
   * the same attached-child slot `bootRunOnce`'s own `msb run` child fills
   * for an ordinary boot.
   *
   * Before stopping the source sandbox, this also best-effort captures its
   * guest workload cmdline (`captureGuestWorkloadCmdline`) when
   * `handle.spec.command` is undefined — the image's own default entrypoint
   * was running, so there is no explicit command for `reviveWorkload` to
   * fall back on at either this method's own immediate reboot or a later,
   * registry-mediated restore. See that method's own doc for why a capture
   * failure never fails the checkpoint itself.
   *
   * If the snapshot step fails, the sandbox is left stopped — no
   * best-effort restart, since that restart would itself be the broken `msb
   * start` call — and the error names the failed step plus the by-hand
   * remedy. If the snapshot step SUCCEEDS but the reboot from it fails, the
   * sandbox has already been removed by the time that's known, so the error
   * instead names the checkpoint ref and points at `fromCheckpoint()` as the
   * recovery path.
   *
   * Refuses outright, before any of the above, when `handle.spec.tmpfsRootMb`
   * is set: a tmpfs root has nothing on disk for a snapshot to capture.
   *
   * `ref` is the WORKING ref this method is asked to checkpoint under — its
   * basename becomes the snapshot create call's `<name>` argument (still
   * meaningful: it lands in msb's own index, see `MsbCommands.snapshotCreate`'s
   * own doc) and, for a path ref, its dirname becomes `--dest-dir`. It is
   * NOT necessarily where the artifact ends up: EMPIRICALLY VERIFIED against
   * a real msb 0.7.1 binary, `snapshot create` always writes under
   * `<destDir-or-default>/<sandbox>/snap_<32-hex-digest>`, a path `name`
   * never determines. This method therefore parses that real artifact path
   * back out of the command's own stdout (last non-empty line, required to
   * be absolute — see `parseSnapshotCreateArtifactPath`) and returns THAT as
   * the EFFECTIVE ref — the one used for the reboot below and the one the
   * caller (`GenericContainer.checkpoint()`) stores in the registry and
   * hands back on the `Checkpoint` it returns. Malformed or unrecognizable
   * output (empty, no absolute last line) throws a `BackendError` quoting
   * the raw, unparsed output verbatim rather than guessing a ref.
   */
  async createCheckpoint(handle: SandboxHandle, ref: string): Promise<string> {
    if (handle.spec.tmpfsRootMb !== undefined) {
      // Checked before touching the sandbox at all: a tmpfs root is
      // ephemeral, so stopping it first would gain nothing worth throwing
      // away a running sandbox for.
      throw new TmpfsRootCheckpointError();
    }
    const msbPath = await this.msbPath();
    // Captured up front: `handle.id` itself is mutated in place, below, once
    // the reboot under the fresh name has actually succeeded — every
    // reference to the SOURCE sandbox's own name in this method (the
    // stop/snapshot/rm steps, the pre-mutation error messages) goes through
    // this local instead, never `handle.id` directly, so it stays correct
    // regardless of when that mutation happens.
    const originalName = handle.id;
    const state = this.handles.get(originalName);
    if (state === undefined) {
      throw new BackendError(`no handle state for sandbox '${originalName}' — create() was never called for it`);
    }

    // Guest cmdline capture — BEFORE stopping the source sandbox (see
    // captureGuestWorkloadCmdline's own doc) — only when there is no
    // explicit command for a restore to fall back on later. Best-effort: a
    // capture failure never fails the checkpoint itself (captureGuestWorkloadCmdline
    // already swallows it into `undefined`); its absence only surfaces
    // later, at restore time, as CheckpointWorkloadCommandMissingError.
    // Stashed on `state` (kept by reference across this method's own
    // re-keying below, so it survives the remove+reboot churn) for
    // `capturedWorkloadCommand()` to hand back to `GenericContainer.checkpoint()`
    // afterward.
    const capturedCommand = handle.spec.command === undefined ? await this.captureGuestWorkloadCmdline(handle) : undefined;
    state.capturedCommand = capturedCommand;

    await this.stop(handle);

    // A path ref (see checkpoint/ref.ts) hands msb the ref's own basename as
    // the snapshot NAME and the parent as --dest-dir — the parent directory
    // is honored, but (since msb 0.7.1) the artifact itself lands nested
    // under <parent>/<sandbox>/snap_<digest>, never literally at `ref`; see
    // this method's own doc. A bare-name ref (pre-dest-dir checkpoints,
    // still restorable) keeps going through msb's own default snapshot
    // store, unchanged.
    const isPathRef = path.isAbsolute(ref);
    if (isPathRef) {
      await fs.mkdir(path.dirname(ref), { recursive: true });
    }
    const snapshotArgv = isPathRef
      ? MsbCommands.snapshotCreate(originalName, path.basename(ref), path.dirname(ref))
      : MsbCommands.snapshotCreate(originalName, ref);
    const snap = await invoke(msbPath, snapshotArgv, CHECKPOINT_TIMEOUT_MS);
    if (snap.exitCode !== 0) {
      throw new BackendError(
        `msb snapshot create --from ${originalName} ${ref} failed (exit ${snap.exitCode}): ${snap.stderr.trim()} — ` +
          `the sandbox is left stopped; run 'msb start ${originalName}' by hand to bring it back up.`,
      );
    }
    const effectiveRef = parseSnapshotCreateArtifactPath(snap.stdout);
    if (effectiveRef === undefined) {
      throw new BackendError(
        `msb snapshot create --from ${originalName} ${ref} did not print a recognizable artifact path as its ` +
          `last line — the sandbox is left stopped; run 'msb start ${originalName}' by hand to bring it back up. ` +
          `Raw output:\n${snap.stdout}${snap.stderr}`,
      );
    }

    await invoke(msbPath, MsbCommands.rm(originalName), STOP_TIMEOUT_MS).catch(() => {});

    // A FRESH sandbox name for the reboot — never `originalName` — from the
    // SAME generator every ordinary GenericContainer.start() boot uses (see
    // core/sandbox-name.ts's own doc on why this is the one, shared counter).
    // See this method's own doc for why: msb's own restore-time collision
    // check can still see the just-`rm`-ed sandbox's on-disk directory as
    // present for a window after `msb rm` returns, on a loaded Windows host,
    // and a fresh name sidesteps that race structurally rather than merely
    // retrying through it.
    const freshName = nextSandboxName();

    // Tracked in the reaping ledger BEFORE the restore is even attempted —
    // exactly like an ordinary create() (see GenericContainer.start()'s own
    // trackSandbox call) — so a process that dies mid-reboot still leaves
    // the ledger a superset of this run's live sandboxes. `originalName`'s
    // own ledger entry is deliberately left alone: it was already `msb
    // rm`-ed above, and the ledger's sweep is already not-found-tolerant for
    // exactly this shape (a name the ledger still lists but msb itself has
    // no record of).
    if (!handle.spec.keepAlive) {
      await trackSandbox(freshName);
    }

    // `command` resolves the same way `fromCheckpointRegistryEntry` resolves
    // it for a later, registry-mediated restore: the source's own explicit
    // command first, the guest cmdline just captured above as the fallback —
    // so `reviveWorkload`, inside the reboot this triggers next, already has
    // the fully-resolved workload argv without any restore-time lookup. This
    // merged `command` (and `checkpointRef`) live ONLY on `rebootHandle`,
    // never on the caller's own `handle.spec` (mutated below) — that spec
    // must keep reading back exactly what the SOURCE container's own
    // `spec.command` was (`undefined` when there was none), since
    // `GenericContainer.checkpoint()` reads `handle.spec` again right after
    // this returns to build the named-checkpoint registry entry, which
    // pins that same "explicit command vs. captured fallback" distinction
    // as two separate fields (see `CheckpointRegistryEntry`'s own doc).
    const rebootHandle: SandboxHandle = {
      id: freshName,
      spec: { ...handle.spec, name: freshName, checkpointRef: effectiveRef, command: handle.spec.command ?? capturedCommand },
    };
    try {
      await this.rebootRetryingAlreadyExists(msbPath, rebootHandle, state);
    } catch (err) {
      // The fresh name never came up — untrack it again rather than leaving
      // a permanently-stale ledger entry for a name this method will never
      // retry under (mirrors GenericContainer.start()'s own untrackSandbox
      // call on a failed attempt).
      if (!handle.spec.keepAlive) {
        await untrackSandbox(freshName);
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new BackendError(
        `sandbox '${originalName}' was removed after a successful checkpoint snapshot, but booting a fresh ` +
          `sandbox back up from that snapshot under the new name '${freshName}' failed: ${detail} — the ` +
          `sandbox's disk state is preserved in checkpoint '${effectiveRef}', restorable via ` +
          `GenericContainer.fromCheckpoint().`,
      );
    }

    // The reboot succeeded under `freshName`, not `originalName` — re-key
    // this backend's own runtime registries (see class doc on `handles`),
    // then publish the new identity onto the CALLER's own handle object, IN
    // PLACE, so every subsequent operation on it targets the sandbox
    // actually running now (see this method's own doc). Only `id`/`spec.name`
    // change on the live handle — `spec.command`/`spec.checkpointRef` stay
    // exactly as they were on the SOURCE spec; see the comment on
    // `rebootHandle` above for why.
    this.handles.delete(originalName);
    this.handles.set(freshName, state);
    this.startedNames.delete(originalName);
    const mutableHandle = handle as { id: string; spec: ContainerSpec };
    mutableHandle.id = freshName;
    mutableHandle.spec = { ...handle.spec, name: freshName };

    return effectiveRef;
  }

  /**
   * Best-effort `msb snapshot rm <ref> -f` — "not found" is success, the
   * same contract as `removeByName`. `ref` is passed FULL, never reduced to
   * `path.basename(ref)`: EMPIRICALLY VERIFIED against a real msb 0.7.1
   * binary, name-based removal does not resolve at all — the artifact PATH
   * is the only address that reliably works (see `MsbCommands.snapshotRemove`'s
   * own doc). Every real caller already hands this the EFFECTIVE ref
   * `createCheckpoint` returned (an absolute path since 0.7.1), so this is
   * also simply correct for the common case, not just a defensive choice.
   *
   * One failure shape is deliberately NOT swallowed alongside "not found":
   * msb refuses to remove a snapshot that is still the current HEAD of
   * older siblings from the same source sandbox (see
   * `isSnapshotHeadRemovalRefused`) — that refusal propagates as a
   * `BackendError` naming msb's own remedy, rather than silently doing
   * nothing, since automatic head rotation is out of scope for this method
   * (see the checkpoints guide's cleanup section for the documented
   * limitation).
   *
   * msb's own removal deletes both its index entry and the dest-dir
   * artifact for a path ref, but afterwards this also best-effort
   * recursively deletes the ref path itself: if msb's index ever loses
   * track of an artifact without deleting it, the directory would otherwise
   * linger under the cache dir forever. That recursive delete is gated on
   * `looksLikeCheckpointArtifactDir` first — a `ref` is caller-supplied (a
   * corrupt registry entry, a hand-edited env var, …), and a `fs.rm(ref, {
   * recursive: true })` on an unverified path would happily wipe out an
   * arbitrary directory that merely happens to share its name.
   */
  async removeCheckpoint(ref: string): Promise<void> {
    const msbPath = await this.msbPath();
    const isPathRef = path.isAbsolute(ref);
    const result = await invoke(msbPath, MsbCommands.snapshotRemove(ref), CHECKPOINT_TIMEOUT_MS).catch(() => undefined);
    if (result !== undefined && result.exitCode !== 0 && isSnapshotHeadRemovalRefused(result.stderr)) {
      throw new BackendError(
        `msb snapshot rm ${ref} -f was refused (exit ${result.exitCode}): ${result.stderr.trim()} — this ` +
          `checkpoint is still the newest snapshot of other, older ones from the same source sandbox; ` +
          `select another snapshot as head first ('msb snapshot head ...', see msb's own message above), ` +
          `or remove the older siblings first.`,
      );
    }
    if (isPathRef && (await looksLikeCheckpointArtifactDir(ref))) {
      await fs.rm(ref, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * `msb snapshot inspect <ref>` — exit 0 means the snapshot exists. A
   * non-zero exit whose stderr carries msb's own "snapshot not found"
   * framing (see `isSnapshotNotFoundError`, confirmed verbatim against the
   * real msb 0.6.8 binary) resolves `false` — a genuine miss. Any OTHER
   * non-zero exit (a corrupted state db, a permission error, a malformed
   * argument, an msb crash) throws `BackendError` carrying the raw stderr
   * instead of collapsing to `false`: `invoke()` itself only rejects on a
   * spawn or timeout failure (never on exit code — see `logs()`'s own doc on
   * that), so without this check a genuine probe failure would silently
   * resolve `false` and let `Checkpoints.find`'s stale-cleanup best-effort
   * delete a perfectly valid registry entry over what may be a transient msb
   * failure — exactly the "no best-effort false on probe errors" the SPI's
   * own contract forbids.
   *
   * A path ref never reaches any of that: it names a directory msb itself
   * wrote under the cache dir (see checkpoint/ref.ts and createCheckpoint's
   * `--dest-dir` handling above), so its presence is answered by a plain
   * filesystem check for `<ref>/snapshot.json` — no msb call at all.
   */
  async hasCheckpoint(ref: string): Promise<boolean> {
    if (path.isAbsolute(ref)) {
      return fs
        .access(path.join(ref, "snapshot.json"))
        .then(() => true)
        .catch(() => false);
    }
    const msbPath = await this.msbPath();
    const result = await invoke(msbPath, MsbCommands.snapshotInspect(ref), CHECKPOINT_TIMEOUT_MS);
    if (result.exitCode === 0) {
      return true;
    }
    if (isSnapshotNotFoundError(result.stderr)) {
      return false;
    }
    throw new BackendError(`msb snapshot inspect ${ref} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }

  /**
   * `msb snapshot save <ref> <destFile>` — writes the `.tar.zst` artifact
   * `Checkpoints.exportTo` bundles into its own archive container. Never
   * `--with-image` (see the checkpoints guide's own note on why: its import
   * fails an integrity check in 0.6.6, so archives never bundle the OCI
   * image — the destination machine pulls it on the restored container's
   * first boot).
   *
   * On Windows, msb 0.6.7 and 0.6.8 fail this call every single time: they
   * finish writing the archive to a staging file beside the destination and
   * then fsync it through a read-only handle, which Windows refuses with
   * `ERROR_ACCESS_DENIED`, so the rename onto the destination never happens.
   * When that specific failure is what came back, `salvageStagedArchive`
   * performs the rename msb stopped one line short of and the export counts as
   * having succeeded; anything else, on any platform, surfaces msb's own
   * stderr as before. See `isSnapshotSaveAccessDeniedFailure` for why the
   * match is on the error NUMBER and why the salvage insists on finding
   * exactly one staging file. This heals itself once msb fixes the fsync — the
   * error stops occurring and the branch stops being taken — so it is
   * deliberately not tied to the pinned msb version.
   */
  async exportCheckpoint(ref: string, destFile: string): Promise<void> {
    const msbPath = await this.msbPath();
    const result = await invoke(msbPath, MsbCommands.snapshotExport(ref, destFile), CHECKPOINT_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      if (
        process.platform === "win32" &&
        isSnapshotSaveAccessDeniedFailure(result.stderr) &&
        (await salvageStagedArchive(destFile))
      ) {
        return;
      }
      throw new BackendError(
        `msb snapshot save ${ref} ${destFile} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  /**
   * `msb snapshot load <archive> --dest <checkpointsDir>`, then resolves the
   * EFFECTIVE ref: EMPIRICALLY VERIFIED against a real msb 0.7.1 binary, a
   * successful load prints a `group msb-<hex>: head snap_<digest>
   * (Initialized)` line, a digest line, and finally the loaded artifact's
   * own absolute path as its LAST line — `<checkpointsDir>/<generated-
   * group>/snap_<digest>`, never the archive's own recorded `ref` — parsed
   * back out by `parseImportedArtifactPath` (the same last-non-empty-line,
   * must-be-absolute defensive pattern `parseSnapshotCreateArtifactPath`
   * uses for `snapshot create`). `checkpointsDir` is always this backend's
   * own checkpoints cache directory (`<cacheDir>/checkpoints`, the same
   * directory `checkpointRef()` mints created-checkpoint refs under) —
   * omitting `--dest` would import into msb's own global default snapshot
   * store instead, outside anywhere this library looks for or cleans up
   * checkpoints. Created fresh (mkdir -p) before the load, since nothing
   * guarantees a caller ever created a checkpoint locally first (an
   * imported-only machine has no reason to have this directory yet).
   *
   * This replaces the pre-0.7.1 shape entirely: `snapshot load` used to
   * write under a digest-derived directory name with no `--dest` of its
   * own, so this method had to parse out just that bare NAME and then
   * separately CONFIRM it via `msb snapshot list --format json` before
   * handing it back (the only way to get a usable ref at all, since the
   * bare name alone still had to resolve against msb's default store). 0.7.1
   * prints the full, directly-usable, already-`--dest`-scoped path as part
   * of `load`'s own output, so that whole list-and-confirm round trip is
   * gone — dead code that this migration deletes outright, not merely
   * bypassed.
   *
   * An already-exists failure — msb's own content-addressed dedup — is
   * treated as success, since the artifact is already present under that
   * digest either way, and its stderr is parsed the same way as a success's
   * stdout; any OTHER import failure surfaces msb's own stderr in a
   * `BackendError`, and unparseable output (no recognizable absolute last
   * line — e.g. only the "group ... (Initialized)" line, msb's OWN wording
   * for a state that is not itself a path) throws a `BackendError` quoting
   * the raw output verbatim rather than misreading a status line as a ref.
   * `_ref` (the archive's own recorded ref) is unused here — msb's importer
   * never takes one, unlike docker's, where the effective ref really is the
   * ref passed in.
   */
  async importCheckpoint(srcFile: string, _ref: string): Promise<string> {
    const msbPath = await this.msbPath();
    const checkpointsDir = path.join(cacheDir(), "checkpoints");
    await fs.mkdir(checkpointsDir, { recursive: true });

    const imported = await invoke(msbPath, MsbCommands.snapshotImport(srcFile, checkpointsDir), CHECKPOINT_TIMEOUT_MS);

    let artifactPath: string | undefined;
    if (imported.exitCode === 0) {
      artifactPath = parseImportedArtifactPath(imported.stdout);
    } else if (isSnapshotAlreadyExistsError(imported.stderr)) {
      artifactPath = parseImportedArtifactPath(imported.stderr);
    } else {
      throw new BackendError(
        `msb snapshot load ${srcFile} --dest ${checkpointsDir} failed (exit ${imported.exitCode}): ${imported.stderr.trim()}`,
      );
    }
    if (artifactPath === undefined) {
      throw new BackendError(
        `msb snapshot load ${srcFile} --dest ${checkpointsDir} did not print a recognizable artifact path as its ` +
          `last line — output:\n${imported.stdout}${imported.stderr}`,
      );
    }
    return artifactPath;
  }

  private async runningSandboxNames(msbPath: string): Promise<Set<string>> {
    const result = await invoke(msbPath, MsbCommands.ls(), LOGS_TIMEOUT_MS);
    return runningNames(result.stdout);
  }

  /**
   * Runs `cmd` in the guest, retrying while msb reports it cannot reach the
   * guest agent's endpoint yet (see `isAgentEndpointNotReady`). A sandbox
   * shows `"Running"` before that endpoint is guaranteed to exist, so an exec
   * issued immediately after `start()` returns can arrive first; this closes
   * that window rather than leaving every caller to rediscover it. Only that
   * one failure shape is retried — a guest command's own non-zero exit
   * returns on the first attempt, unchanged, and so does any agent error
   * raised once the connection is actually established.
   */
  async exec(handle: SandboxHandle, cmd: ReadonlyArray<string>): Promise<ExecResult> {
    const msbPath = await this.msbPath();
    const args = MsbCommands.exec(handle.id, cmd);
    const deadline = Date.now() + AGENT_ENDPOINT_RETRY_BUDGET_MS;
    for (;;) {
      const result = await invoke(msbPath, args, EXEC_TIMEOUT_MS);
      if (result.exitCode === 0 || !isAgentEndpointNotReady(result.stderr) || Date.now() >= deadline) {
        return result;
      }
      await sleep(AGENT_ENDPOINT_RETRY_DELAY_MS);
    }
  }

  /**
   * A fresh `msb logs <name> --tail 1000` invocation, same on every platform.
   * This is the workload's own output, as distinct from the attached
   * `msb run` child's pipe (drained in start() into a tail kept only for
   * pre-Running crash diagnostics): on Windows the attached process does not
   * relay guest stdout at all, while `msb logs` does everywhere, so this is
   * the only channel this method can source from. Never rejects on a
   * missing/removed sandbox — invoke() only rejects on spawn failure or
   * timeout, never on exit code, so a failing `msb logs` call resolves with
   * whatever (possibly empty) stdout it produced.
   */
  async logs(handle: SandboxHandle): Promise<string> {
    const msbPath = await this.msbPath();
    return (await invoke(msbPath, MsbCommands.logs(handle.id), LOGS_TIMEOUT_MS)).stdout;
  }

  /**
   * `msb logs -f` never exits once the sandbox stops (confirmed against the
   * real msb binary — it blocks on read forever instead of the documented
   * clean exit). A watchdog polls `msb ls` in the background; the instant
   * the sandbox leaves Running it quiesces the stuck follow child FIRST
   * (kill it, wait for the reader to finish draining whatever was already
   * buffered) so `delivered` reflects everything the live stream will ever
   * produce, THEN does one authoritative non-follow `msb logs` fetch and
   * replays only the lines after `delivered` — guarded so that replay can
   * only ever happen once. An explicit `close()` never triggers a replay:
   * closing means the caller asked delivery to stop, not "catch me up."
   *
   * On Windows hosts this routes to `followLogsByPolling` instead: there,
   * `msb logs -f` stays alive for the sandbox's whole run but never relays a
   * single line to its stdout pipe while the sandbox is Running (confirmed
   * against the real binary on a hosted windows-2025 runner — the same lines
   * are retrievable through non-follow `msb logs` the whole time), so a
   * pipe-reading follow child can never deliver a live line on Windows.
   */
  async followLogs(handle: SandboxHandle, consumer: (line: string) => void): Promise<FollowHandle> {
    const msbPath = await this.msbPath();
    if (process.platform === "win32") {
      return this.followLogsByPolling(msbPath, handle, consumer);
    }
    const child = spawn(msbPath, MsbCommands.followLogs(handle.id), { stdio: [CLOSED_STDIN, "pipe", "pipe"] });

    let delivered = 0;
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const readerDone = new Promise<void>((resolveReader) => {
      rl.on("line", (line) => {
        delivered++;
        consumer(line);
      });
      rl.on("close", () => resolveReader());
    });
    // stderr of `logs -f` carries no separate signal this backend acts on;
    // drain it so the pipe never backs up and stalls the child.
    child.stderr.resume();

    let flushed = false;
    let closeRequested = false;
    let watchdogDone: Promise<void> | undefined;

    const flushTailOnce = async (): Promise<void> => {
      child.kill();
      await readerDone;
      if (flushed) {
        return;
      }
      flushed = true;
      const full = (await invoke(msbPath, MsbCommands.logs(handle.id), LOGS_TIMEOUT_MS)).stdout;
      for (const line of undeliveredLines(full, delivered)) {
        consumer(line);
      }
    };

    const runWatchdog = async (): Promise<void> => {
      while (!child.killed && !closeRequested) {
        const names = await this.runningSandboxNames(msbPath).catch(() => new Set<string>());
        if (!names.has(handle.id)) {
          await flushTailOnce();
          return;
        }
        await sleep(READINESS_POLL_MS);
      }
    };
    watchdogDone = runWatchdog();

    return {
      close: async (): Promise<void> => {
        closeRequested = true;
        child.kill();
        await readerDone;
        await watchdogDone;
        // Deliberately no flushTailOnce() call here: an explicit close means
        // "stop delivery," never "catch me up." If the sandbox had already
        // left Running before close() was called, the watchdog's own flush
        // already ran and this is a no-op by way of the `flushed` guard.
      },
    };
  }

  /**
   * Windows follow-logs path: no follow child at all. One async loop polls
   * the non-follow `msb logs` fetch and delivers each fetch's not-yet-
   * delivered lines, tracked by a monotonic `delivered` index — the same
   * index-based diffing the POSIX watchdog's one-shot replay uses, made
   * continuous. Delivery contract is identical to the POSIX path: in order,
   * each line at most once, nothing after `close()`.
   *
   * A fetch's last line is held back only while the sandbox is Running AND
   * the fetched text does not end with a newline: an unterminated tail may
   * have been read mid-write, and delivering it early would split one
   * workload line into two deliveries (the next fetch's index-diff would then
   * skip its completed form). A newline-terminated tail is complete and
   * delivers immediately — a workload that trickles complete lines while
   * staying alive must see each line arrive live, not stall behind a
   * holdback. Once the sandbox leaves Running, a final fetch (see
   * `deliverTerminalTail`) delivers everything outstanding, including a
   * trailing unterminated line.
   *
   * Every msb invocation this poller makes runs to completion strictly before
   * the next one starts — exactly one in-flight child at a time from this
   * code path. A failed `msb ls`/`msb logs` invocation — spawn error,
   * timeout, or msb exiting non-zero (msb's own internal errors print to
   * stderr and exit non-zero with EMPTY stdout, indistinguishable from a
   * genuinely-empty response unless the exit code is checked) — is never read
   * as "the sandbox stopped" or "the log is empty"; it retries.
   */
  private followLogsByPolling(
    msbPath: string,
    handle: SandboxHandle,
    consumer: (line: string) => void,
  ): FollowHandle {
    let closeRequested = false;

    const pollerDone = (async (): Promise<void> => {
      let delivered = 0;
      for (;;) {
        if (closeRequested) {
          return; // An explicit close never triggers delivery of anything new.
        }
        let running: boolean;
        try {
          const ls = await invoke(msbPath, MsbCommands.ls(), LOGS_TIMEOUT_MS);
          if (ls.exitCode !== 0) {
            throw new BackendError(`msb ls exited ${ls.exitCode}: ${ls.stderr.trim()}`);
          }
          running = runningNames(ls.stdout).has(handle.id);
        } catch {
          await sleep(READINESS_POLL_MS);
          continue;
        }

        if (!running) {
          await this.deliverTerminalTail(msbPath, handle.id, delivered, consumer, () => closeRequested);
          return;
        }

        let full: string;
        try {
          full = await fetchStdoutExact(msbPath, MsbCommands.logs(handle.id), LOGS_TIMEOUT_MS);
        } catch {
          await sleep(READINESS_POLL_MS);
          continue;
        }

        const lines = undeliveredLines(full, 0);
        // msb's Windows log store can briefly show a single empty line before
        // the workload's first real output lands, and that phantom line is
        // REPLACED by the real content on a later read rather than prepended
        // to it (observed against the real binary on a hosted windows-2025
        // runner: delivering it permanently shifted the index-diff by one and
        // swallowed the first real line in every follow). Until something
        // non-empty has been delivered, an all-empty snapshot is "no content
        // yet" — a workload's genuine interior blank lines are unaffected,
        // since they arrive inside content-bearing snapshots.
        if (delivered === 0 && lines.every((l) => l === "")) {
          await sleep(READINESS_POLL_MS);
          continue;
        }
        const lastLineMayBeMidWrite = full.length > 0 && !full.endsWith("\n");
        const deliverable = lastLineMayBeMidWrite ? Math.max(delivered, lines.length - 1) : lines.length;
        for (let i = delivered; i < deliverable; i++) {
          if (closeRequested) {
            return;
          }
          consumer(lines[i] as string);
        }
        delivered = Math.max(delivered, deliverable);
        await sleep(READINESS_POLL_MS);
      }
    })();

    return {
      close: async (): Promise<void> => {
        closeRequested = true;
        await pollerDone;
      },
    };
  }

  /**
   * Delivers everything outstanding once the sandbox is confirmed no longer
   * Running: retries the `msb logs` fetch only while it keeps failing to
   * invoke at all (bounded by `TERMINAL_FETCH_FAILURE_BUDGET_MS`), and
   * delivers from the very first successful fetch — withholding nothing,
   * since a stopped sandbox's log cannot grow, so there is no more mid-write
   * risk. This is the one place a trailing unterminated line reaches the
   * consumer on Windows.
   */
  private async deliverTerminalTail(
    msbPath: string,
    id: string,
    delivered: number,
    consumer: (line: string) => void,
    isCloseRequested: () => boolean,
  ): Promise<void> {
    const deadline = Date.now() + TERMINAL_FETCH_FAILURE_BUDGET_MS;
    let full = "";
    for (;;) {
      try {
        full = await fetchStdoutExact(msbPath, MsbCommands.logs(id), LOGS_TIMEOUT_MS);
        break;
      } catch {
        if (isCloseRequested() || Date.now() >= deadline) {
          break;
        }
        await sleep(READINESS_POLL_MS);
      }
    }
    // The same phantom-empty-line guard the live poll loop applies (see
    // `followLogsByPolling`): a store still showing only empty lines when
    // nothing was ever delivered means the workload produced no output, not
    // that it printed blanks.
    if (delivered === 0 && undeliveredLines(full, 0).every((l) => l === "")) {
      return;
    }
    for (const line of undeliveredLines(full, delivered)) {
      if (isCloseRequested()) {
        return;
      }
      consumer(line);
    }
  }

  async ensureNetwork(_networkId: string): Promise<void> {
    // Emulated via the host gateway; there is no native network object to create.
  }

  async removeNetwork(_networkId: string): Promise<void> {
    // Nothing was created for ensureNetwork(); nothing to remove.
  }

  /**
   * Networks are emulated because there is no bridge/subnet the current
   * msb exposes on macOS — the only data path into a running sandbox is the
   * exec channel. Four concerns, each its own guard: reject duplicate guest
   * ports, validate every alias (they get shell-interpolated), probe for
   * `nc`, then install `/etc/hosts` aliases and spawn one tunnel per link.
   */
  async installNetworkLinks(handle: SandboxHandle, links: ReadonlyArray<NetworkLink>): Promise<void> {
    if (links.length === 0) {
      return;
    }
    const msbPath = await this.msbPath();
    requireNoDuplicateGuestPorts(links);
    requireAliasesAreValid(links);

    const ncProbe = await this.exec(handle, ["sh", "-c", "command -v nc"]);
    if (ncProbe.exitCode !== 0) {
      throw new UnsupportedByBackendError(
        `network links (no nc/busybox in consumer image '${handle.spec.image}')`,
        this.name,
        "run this test with RIGHTSIZE_BACKEND=docker instead",
      );
    }

    const hostsResult = await this.exec(handle, ["sh", "-c", hostsAliasScript(links)]);
    if (hostsResult.exitCode !== 0) {
      throw new BackendError(`failed to install /etc/hosts aliases in ${handle.id}: ${hostsResult.stderr}`);
    }

    const state = this.handles.get(handle.id);
    for (const link of links) {
      const tunnel = new ExecTunnel(msbPath, handle.id, link);
      if (state !== undefined) {
        state.resources.push(tunnel);
      }
    }
  }

  /**
   * `msb copy -q <hostPath> <name>:<containerPath>` — the transfer only;
   * `GenericContainer.copyFileToContainer()` already confirmed the sandbox
   * is running, validated the absolute path, and ran the guest-side
   * `mkdir -p` before this is ever called. A nonzero exit surfaces the
   * tool's own stderr rather than a silent success.
   */
  async copyToContainer(handle: SandboxHandle, hostPath: string, containerPath: string): Promise<void> {
    const msbPath = await this.msbPath();
    const result = await invoke(msbPath, MsbCommands.copyIn(hostPath, handle.id, containerPath), COPY_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      throw new BackendError(
        `msb copy into ${handle.id}:${containerPath} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  /** The reverse direction of `copyToContainer` — see its own doc. */
  async copyFromContainer(handle: SandboxHandle, containerPath: string, hostPath: string): Promise<void> {
    const msbPath = await this.msbPath();
    const result = await invoke(msbPath, MsbCommands.copyOut(handle.id, containerPath, hostPath), COPY_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      throw new BackendError(
        `msb copy from ${handle.id}:${containerPath} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  // This process's own-run cleanup sweep. `startedNames` never contains a
  // keepAlive sandbox's name (bootOnce skips adding it), so this loop leaves
  // reuse sandboxes running by construction — no keepAlive check needed here.
  async close(): Promise<void> {
    const msbPath = await this.msbPath().catch(() => undefined);
    if (msbPath === undefined) {
      return;
    }
    for (const name of [...this.startedNames]) {
      await this.removeByName(name);
    }
  }

  /**
   * Synchronous, blocking teardown for the process-exit path, where the
   * event loop is not available to await this backend's normal async
   * stop/remove. `spawnSync` is the one primitive Node offers that actually
   * blocks the process here; failures are swallowed because the process is
   * exiting regardless and there is no caller left to report them to.
   */
  cleanupSync(id: string): void {
    // A container only ever reaches start() (and therefore only ever gets
    // registered for sync cleanup) after msbPathPromise has already
    // resolved, so resolvedMsbPath is populated by the time this can matter
    // in practice; the undefined case below covers only the very first
    // provisioning attempt racing its own constructor's .then().
    const msbPath = this.resolvedMsbPath;
    if (msbPath === undefined) {
      return;
    }
    try {
      spawnSync(msbPath, MsbCommands.stop(id));
    } catch {
      // Best-effort.
    }
    try {
      spawnSync(msbPath, MsbCommands.rm(id));
    } catch {
      // Best-effort.
    }
  }

  /**
   * Best-effort stop+remove of a sandbox identified by NAME — the shape the
   * reaping ledger and sweep need, since they only ever store names (a
   * sweep running in a different process, or a different rightsize
   * language entirely, never held a handle here). "Not found" is silently
   * fine. Each step is retried once if it hits msb's own state-database
   * error (see `isMsbStateDbError`) — the same startup-migration race the
   * boot path retries, which a sweep can just as easily race against a
   * concurrent `msb` invocation from another process.
   */
  async removeByName(name: string): Promise<void> {
    const msbPath = await this.msbPath();
    await this.invokeRemoveStepWithRetry(msbPath, MsbCommands.stop(name));
    await this.invokeRemoveStepWithRetry(msbPath, MsbCommands.rm(name));
  }

  private async invokeRemoveStepWithRetry(msbPath: string, args: readonly string[]): Promise<void> {
    const result = await invoke(msbPath, args, STOP_TIMEOUT_MS).catch(() => undefined);
    const output = result === undefined ? "" : `${result.stdout}\n${result.stderr}`;
    if (isMsbStateDbError(output)) {
      await sleep(STATE_DB_RETRY_DELAY_MS);
      await invoke(msbPath, args, STOP_TIMEOUT_MS).catch(() => {});
    }
  }

  /**
   * Reuse's adopt-path liveness check: `spec.name` is running iff it shows
   * up in `msb ls`'s `"Running"` set, the same source `bootOnce`'s own
   * readiness poll uses. This never touches `this.handles` — a name found
   * running here was very possibly created by an earlier process this
   * backend instance never itself called `create()` for.
   */
  async findRunning(spec: ContainerSpec): Promise<SandboxHandle | undefined> {
    const msbPath = await this.msbPath();
    const running = await this.runningSandboxNames(msbPath);
    if (!running.has(spec.name)) {
      return undefined;
    }
    return { id: spec.name, spec };
  }

  /** The reaper watchdog's kill-command prefixes: the provisioned `msb` binary plus the same `stop`/`rm` subcommands `removeByName` itself invokes. msb has no native network object, so `removeNetwork` is empty. */
  async reaperKillCommand(): Promise<ReaperKillCommand> {
    const msbPath = await this.msbPath();
    return { stop: [msbPath, "stop"], remove: [msbPath, "rm"], removeNetwork: [] };
  }
}
