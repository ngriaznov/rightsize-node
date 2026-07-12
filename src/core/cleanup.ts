/**
 * Best-effort exit-path cleanup — the JVM-shutdown-hook / Rust-cleanup-
 * thread analog for a process that dies (or is asked to die) before its
 * `await using` scopes unwind normally. Doubles as the process-local
 * registry of currently running containers the failure-diagnostics report
 * (`diagnostics.ts`) reads from — one live-container registry, not two: a
 * container is registered here the instant `GenericContainer.start()`
 * confirms it booted, and deregistered the instant `stop()` tears it down,
 * which is exactly the "currently running" window diagnostics needs too.
 *
 * Node's `process.on("exit", ...)` handler runs SYNCHRONOUSLY and cannot
 * `await` — by the time it fires, the event loop is already being torn
 * down, so a backend's real async `stop()`/`remove()` cannot run there.
 * Each backend therefore registers a synchronous, blocking teardown
 * function per live container (`child_process.spawnSync` for msb, a
 * blocking unix-socket DELETE for docker) instead of its normal async
 * path. This module only owns the REGISTRY and the process hooks; it has
 * no opinion on how any one backend tears a container down.
 *
 * This is a last-resort backstop, not the primary cleanup path — the
 * primary path is `GenericContainer.stop()` / `[Symbol.asyncDispose]`.
 * SIGKILL bypasses even this (no handler runs at all); the orphan reaper
 * each backend runs at startup (`sweepOrphans`) is the backstop for that
 * case, sweeping up `rz-<other-runid>-*` leftovers from a crashed prior
 * run.
 */
import type { SandboxBackend, SandboxHandle } from "./backend.js";

export type SyncCleanup = () => void;

interface RegisteredContainer {
  readonly handle: SandboxHandle;
  readonly backend: SandboxBackend;
  readonly cleanup: SyncCleanup;
}

const registered = new Map<string, RegisteredContainer>();
let hooksInstalled = false;

function runAll(): void {
  for (const entry of registered.values()) {
    try {
      entry.cleanup();
    } catch {
      // Best-effort: a failure to clean up one container must not block
      // cleanup of the others, and the process is exiting regardless.
    }
  }
  registered.clear();
}

function installHooksOnce(): void {
  if (hooksInstalled) {
    return;
  }
  hooksInstalled = true;

  process.on("exit", runAll);

  // SIGINT/SIGTERM: run the same synchronous cleanup, then re-raise the
  // signal so the process still exits the way it would have without this
  // handler (correct exit code, no swallowed Ctrl-C).
  //
  // On Windows this pair is best-effort, not the real safety net: Node
  // delivers a synthetic SIGINT for Ctrl+C (and SIGBREAK for Ctrl+Break,
  // which is not registered here) but there is no real SIGTERM delivery from
  // another process the way POSIX has it — Windows has no signal-based IPC
  // for that. The interactive Ctrl+C path still fires this handler as
  // expected; a `taskkill`-style external termination does not. The `"exit"`
  // handler above is therefore the one Windows-portable guarantee — it fires
  // on every normal process exit regardless of platform or what triggered
  // it — while this signal-handler loop is a POSIX nicety layered on top.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      runAll();
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
}

/** Registers a synchronous teardown for a live container, keyed by handle id — and, by the same call, adds it to the live-container registry `liveContainers()` exposes. */
export function registerSyncCleanup(handle: SandboxHandle, backend: SandboxBackend, cleanupFn: SyncCleanup): void {
  installHooksOnce();
  registered.set(handle.id, { handle, backend, cleanup: cleanupFn });
}

/** Unregisters a container's teardown once it has been stopped/removed normally — and removes it from the live-container registry. */
export function unregisterSyncCleanup(handleId: string): void {
  registered.delete(handleId);
}

/**
 * The process-local registry of currently running containers — every
 * container `registerSyncCleanup` currently holds, in start order. This is
 * `diagnostics.ts`'s data source; nothing else needs a second registry.
 */
export function liveContainers(): ReadonlyArray<{ readonly handle: SandboxHandle; readonly backend: SandboxBackend }> {
  return Array.from(registered.values(), ({ handle, backend }) => ({ handle, backend }));
}

/** Test seam: clears registered cleanups without running them. */
export function _resetForTests(): void {
  registered.clear();
}

/**
 * Test seam: runs every registered cleanup exactly the way the real "exit"
 * handler does (best-effort, swallowing failures, then clearing the
 * registry) without actually terminating the test process. This is how a
 * unit test proves the exit-path teardown is wired to something real,
 * rather than asserting on `registered`'s internal size.
 */
export function _runAllForTests(): void {
  runAll();
}
