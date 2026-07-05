import type { BackendProvider, SandboxBackend } from "./backend.js";

// The ServiceLoader analog: an explicit process-global registry. Each
// backend subpath (`rightsize/backend-msb`, `rightsize/backend-docker`)
// calls registerBackend at import time — the `sideEffects` entry in
// package.json exists so bundlers keep that call.
const registered: BackendProvider[] = [];

/** Adds a provider to the process-global registry. Called once, at import time, by each backend subpath's `index.ts`. */
export function registerBackend(provider: BackendProvider): void {
  registered.push(provider);
}

/** Test seam: clears the process-global registry. Never call from library code. */
export function _resetRegistryForTests(): void {
  registered.length = 0;
}

function knownNames(providers: readonly BackendProvider[]): string {
  return providers.map((p) => p.name).join(", ");
}

/**
 * Pure resolution: no I/O, no module-global registry access, so it is fully
 * unit-testable with fake providers. `Backends.active()` is the impure
 * caller that supplies the real registry and `process.env`.
 */
export function resolve(providers: readonly BackendProvider[], requested: string | undefined): SandboxBackend {
  if (providers.length === 0) {
    throw new Error(
      "No backend providers are registered. Import 'rightsize/backend-msb' or 'rightsize/backend-docker' to register one.",
    );
  }

  if (requested !== undefined) {
    const wanted = requested.toLowerCase();
    const match = providers.find((p) => p.name.toLowerCase() === wanted);
    if (match === undefined) {
      throw new Error(`Unknown backend '${requested}'. Known backends: ${knownNames(providers)}.`);
    }
    if (!match.isSupported()) {
      throw new Error(`Backend '${match.name}' was requested but is not supported here: ${match.unsupportedReason()}`);
    }
    return match.create();
  }

  const supported = providers.filter((p) => p.isSupported());
  if (supported.length === 0) {
    const reasons = providers.map((p) => `${p.name}: ${p.unsupportedReason()}`).join("; ");
    throw new Error(`No supported backend found. ${reasons}`);
  }

  const winner = supported.reduce((best, candidate) => (candidate.priority > best.priority ? candidate : best));
  return winner.create();
}

let activeBackend: SandboxBackend | undefined;
let exitHookInstalled = false;

/**
 * Resolves once per process (memoized) against the real registry and
 * `process.env.RIGHTSIZE_BACKEND`, then registers the best-effort exit-path
 * cleanup (see `src/core/cleanup.ts`) the first time a backend is created.
 */
function active(): SandboxBackend {
  if (activeBackend === undefined) {
    activeBackend = resolve(registered, process.env["RIGHTSIZE_BACKEND"]);
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      let closeStarted = false;
      // "beforeExit" fires while the event loop is still alive (unlike
      // "exit", which runs synchronously and cannot await), so it's the one
      // hook where the backend's real async close() can actually run. It is
      // NOT a true shutdown hook, though: it fires at every full event-loop
      // drain, not only at process exit. With the once-guard below, close()
      // therefore runs at the FIRST complete drain — in a process that goes
      // fully idle between containers, that can be before its last container
      // was booted. Accepted tradeoff: a completely drained loop has no
      // pending timers, sockets, or awaits, so nothing in the process is
      // still waiting on those containers, and both backends stay usable
      // after close() (stateless per-request clients) for any later boot.
      // This is best-effort and NOT the primary safety net: a process that
      // dies via SIGKILL, or exits through the synchronous "exit" path
      // before beforeExit ever fires, is instead covered by the per-
      // container cleanupSync registered in cleanup.ts and by the orphan
      // reaper each backend runs at construction.
      //
      // "beforeExit" re-fires every time the event loop would otherwise go
      // idle. close() is async — it awaits HTTP/subprocess calls — so
      // invoking it unconditionally here schedules new event-loop work on
      // every firing, which makes the NEXT idle point trigger this same
      // handler again: an infinite close()-then-beforeExit cycle that never
      // lets the process exit (observed as a `node --test` run hanging
      // indefinitely after every assertion had already passed). The
      // closeStarted guard makes this a once-per-process call — the single
      // shutdown pass a process-lifetime cleanup hook is meant to be.
      process.on("beforeExit", () => {
        if (closeStarted) {
          return;
        }
        closeStarted = true;
        // Best-effort: a backend whose close() rejects — or, as a defensive
        // fake in a test can do, throws synchronously before ever producing
        // a Promise to attach .catch() to — must not crash the process on
        // its way out. There is no caller left to report the failure to.
        try {
          activeBackend?.close().catch(() => {});
        } catch {
          // Swallowed for the same reason as the .catch() above.
        }
      });
    }
  }
  return activeBackend;
}

/** Test seam: forces the next `Backends.active()` call to re-resolve. */
function _resetActiveForTests(): void {
  activeBackend = undefined;
  exitHookInstalled = false;
}

/** The library's single entry point for obtaining the active `SandboxBackend`. */
export const Backends = {
  /** Pure resolution against an explicit provider list — see `resolve` above. */
  resolve,
  /** The memoized, per-process active backend — resolved from whatever's registered plus `RIGHTSIZE_BACKEND`. */
  active,
  /** Test seam: forces the next `active()` call to re-resolve. Never call from library code. */
  _resetActiveForTests,
};
