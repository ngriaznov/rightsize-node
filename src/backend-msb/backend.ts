import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { BackendError, PortBindConflictError, UnsupportedByBackendError } from "../core/errors.js";
import type { SandboxBackend, SandboxHandle, FollowHandle, NetworkLink, ReaperKillCommand, BackendCapabilities } from "../core/backend.js";
import type { ContainerSpec, ExecResult } from "../core/model.js";
import { MsbCommands } from "./commands.js";
import { runningNames } from "./ls-json.js";
import { invoke, CLOSED_STDIN } from "./invoke.js";
import { isPortBindConflictOutput } from "./port-conflict.js";
import { isImageCacheCorruption } from "./image-cache.js";
import { isMsbStateDbError } from "./state-db.js";
import { undeliveredLines } from "./follow-replay.js";
import { requireNoDuplicateGuestPorts, requireAliasesAreValid, hostsAliasScript } from "./network-links.js";
import { ExecTunnel } from "./exec-tunnel.js";

const FIRST_RUN_PULL_TIMEOUT_MS = 600_000; // a cold pull can be slow
const READINESS_POLL_MS = 300;
const STOP_TIMEOUT_MS = 60_000;
const EXEC_TIMEOUT_MS = 120_000;
const LOGS_TIMEOUT_MS = 30_000;
const ATTACHED_PROC_STOP_TIMEOUT_MS = 10_000;
const TAIL_LINES = 50;
// How long the Windows polling follower's terminal fetch keeps retrying an
// `msb logs` invocation that itself keeps failing, once the sandbox is
// already confirmed no longer Running. Never a wait-for-content budget: a
// stopped sandbox's log cannot grow, so the first successful fetch is final.
const TERMINAL_FETCH_FAILURE_BUDGET_MS = 10_000;

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
 * How long to wait before retrying a boot that hit msb's state-database
 * error — enough for a winning concurrent invocation's migration transaction
 * to commit; the retry's own `msb run` startup dwarfs this either way.
 */
const STATE_DB_RETRY_DELAY_MS = 500;

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
  /** Each sandbox is its own microVM with its own kernel; no upstream microVM snapshot support yet. */
  readonly capabilities: BackendCapabilities = {
    /** Each sandbox is a microVM with its own kernel. */
    hardwareIsolated: true,
    /** No upstream microVM snapshot/restore support yet. */
    checkpoint: false,
  };

  private readonly handles = new Map<string, HandleState>();
  private readonly startedNames = new Set<string>();
  // Mirrors msbPathPromise's eventual value as soon as it settles, purely so
  // cleanupSync (the synchronous process-exit path, which cannot await
  // anything) has a best-effort synchronous read of it. Never written to
  // except by this one .then() below; never awaited anywhere else.
  private resolvedMsbPath: string | undefined;

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
    this.handles.set(spec.name, { attached: undefined, attachedExited: false, resources: [], logTail: [] });
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

    let firstOutput: string;
    try {
      await this.bootOnce(msbPath, handle, state);
      return;
    } catch (first) {
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
   * One boot attempt: spawns the attached `msb run` child and polls until the
   * sandbox reaches Running. `state.attached` and (for non-keepAlive specs)
   * `startedNames` are populated only on success; on any failure the child is reaped here (for
   * the classified early-exit failures it has already exited; a readiness
   * timeout leaves it alive and it is hard-killed) so a failed attempt leaves
   * no live process or registered cleanup state behind — the caller owns
   * retry policy, never cleanup. An early exit is classified from the child's
   * combined output: the image-cache-corruption signature throws
   * `ImageCacheCorruptionError` (the one failure `start()` heals and
   * retries), a host-port bind conflict throws `PortBindConflictError`, and
   * anything else surfaces the raw output.
   */
  private async bootOnce(msbPath: string, handle: SandboxHandle, state: HandleState): Promise<void> {
    // Fresh per-attempt diagnostics: a retried boot must not blend its tail
    // with the failed attempt's.
    state.logTail = [];
    state.attachedExited = false;

    const child = spawn(msbPath, MsbCommands.run(handle.spec), { stdio: [CLOSED_STDIN, "pipe", "pipe"] });
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
        if (isPortBindConflictOutput(output)) {
          throw new PortBindConflictError(
            `msb run for sandbox ${handle.id} could not bind a host port: ${output}`,
          );
        }
        throw new BackendError(
          `msb run for sandbox ${handle.id} exited (code ${exited.code ?? "unknown"}) before reaching ` +
            `Running — check the image entrypoint and 'msb run' output below:\n${output}`,
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
    // The attached `msb run` child is msb's own supervisor for this sandbox:
    // it stays alive for the sandbox's entire lifetime and only exits once
    // the `msb stop` call just above lands, so the common path here is
    // "attach a listener, then observe the exit that our own stop just
    // caused." state.attachedExited exists for the other case: if the child
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
   * Defensive only: `GenericContainer.checkpoint()` gates on
   * `capabilities.checkpoint` (`false` here) before ever calling this, so
   * this throw is unreachable in normal use — it exists so a caller that
   * somehow invokes the backend directly still gets a typed rejection
   * instead of a silent no-op or a confusing CLI error.
   */
  async commitToImage(_handle: SandboxHandle, _imageRef: string): Promise<void> {
    throw new UnsupportedByBackendError(
      "checkpoint/restore",
      this.name,
      "set RIGHTSIZE_BACKEND=docker — checkpoint/restore is implemented via image commit there; native microVM " +
        "snapshots for microsandbox are on the roadmap",
    );
  }

  private async runningSandboxNames(msbPath: string): Promise<Set<string>> {
    const result = await invoke(msbPath, MsbCommands.ls(), LOGS_TIMEOUT_MS);
    return runningNames(result.stdout);
  }

  async exec(handle: SandboxHandle, cmd: ReadonlyArray<string>): Promise<ExecResult> {
    const msbPath = await this.msbPath();
    return invoke(msbPath, MsbCommands.exec(handle.id, cmd), EXEC_TIMEOUT_MS);
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
