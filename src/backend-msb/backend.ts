import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { RunId } from "../core/run-id.js";
import { BackendError, PortBindConflictError, UnsupportedByBackendError } from "../core/errors.js";
import type { SandboxBackend, SandboxHandle, FollowHandle, NetworkLink } from "../core/backend.js";
import type { ContainerSpec, ExecResult } from "../core/model.js";
import { MsbCommands } from "./commands.js";
import { runningNames } from "./ls-json.js";
import { invoke, CLOSED_STDIN } from "./invoke.js";
import { isPortBindConflictOutput } from "./port-conflict.js";
import { orphanNames } from "./reaper.js";
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

  async start(handle: SandboxHandle): Promise<void> {
    const msbPath = await this.msbPath();
    const state = this.handles.get(handle.id);
    if (state === undefined) {
      throw new BackendError(`no handle state for sandbox '${handle.id}' — create() was never called for it`);
    }

    const child = spawn(msbPath, MsbCommands.run(handle.spec), { stdio: [CLOSED_STDIN, "pipe", "pipe"] });
    state.attached = child;
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
        this.startedNames.add(handle.id);
        return;
      }
      if (Date.now() >= deadline) {
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
   */
  async followLogs(handle: SandboxHandle, consumer: (line: string) => void): Promise<FollowHandle> {
    const msbPath = await this.msbPath();
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

  async close(): Promise<void> {
    const msbPath = await this.msbPath().catch(() => undefined);
    if (msbPath === undefined) {
      return;
    }
    for (const name of [...this.startedNames]) {
      await this.silently(msbPath, name);
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

  /** Remove leftover `rz-<other-runid>-*` sandboxes from a crashed prior run — never this run's own. */
  async sweepOrphans(): Promise<void> {
    const msbPath = await this.msbPath();
    const result = await invoke(msbPath, MsbCommands.ls(), LOGS_TIMEOUT_MS);
    for (const name of orphanNames(result.stdout, RunId.value)) {
      await this.silently(msbPath, name);
    }
  }

  private async silently(msbPath: string, name: string): Promise<void> {
    await invoke(msbPath, MsbCommands.stop(name), STOP_TIMEOUT_MS).catch(() => {});
    await invoke(msbPath, MsbCommands.rm(name), STOP_TIMEOUT_MS).catch(() => {});
  }
}
