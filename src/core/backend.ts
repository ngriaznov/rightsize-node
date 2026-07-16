import type { ContainerSpec, ExecResult } from "./model.js";

/**
 * One alias a container should be reachable under from a running sibling on
 * the same `Network`, computed by `Network.linksForNewMember()`. A native
 * backend (docker) ignores these — its bridge network already resolves
 * aliases; an emulating backend (msb) uses them to wire up its tunnels.
 */
export interface NetworkLink {
  /** The name the sibling should be reachable under. */
  readonly alias: string;
  /** The sibling's exposed guest port. */
  readonly guestPort: number;
  /** The sibling's host-side mapped port to tunnel/route traffic to. */
  readonly targetHostPort: number;
}

/**
 * Backend-native opaque container reference. Immutable id + spec; any
 * mutable runtime state (attached child process, log tail, tunnels) lives
 * backend-side keyed by `id`, never bolted onto this object.
 */
export interface SandboxHandle {
  /** The backend-native container id (or name, for msb). */
  readonly id: string;
  /** The spec this container was created from. */
  readonly spec: ContainerSpec;
}

/** Owns the close mechanism for a live followOutput stream: stop delivery, never flush. */
export interface FollowHandle {
  /** Stops delivering further lines. Never flushes a trailing fragment — that only happens on the workload's own natural end. */
  close(): Promise<void>;
}

/**
 * The argv PREFIXES a backend's own CLI uses to stop/remove a sandbox, or
 * remove a network, by NAME — a sandbox/network name is appended by the
 * caller to whichever prefix applies. This is for the reaper watchdog: a
 * detached, out-of-process script spawned to outlive this process's own
 * SIGKILL, which therefore cannot call back into this backend's normal
 * async methods and instead shells out directly. `stop`/`removeNetwork` may
 * be empty arrays where a backend has no separate stop step (docker's
 * `rm -f` does both in one call) or no native network object to remove (msb
 * emulates networks entirely in-guest — there is nothing to tear down).
 */
export interface ReaperKillCommand {
  /** Argv prefix for this backend's "stop" step; empty if the backend has none (docker's `rm -f` does both in one call). */
  readonly stop: ReadonlyArray<string>;
  /** Argv prefix for this backend's "remove" step. */
  readonly remove: ReadonlyArray<string>;
  /** Argv prefix for removing a network by id/name; empty if the backend has no native network object (msb emulates networks entirely in-guest). */
  readonly removeNetwork: ReadonlyArray<string>;
}

/**
 * Capability flags describing what a backend's own execution model can and
 * cannot guarantee — distinct from `supportsNativeNetworks` (a networking
 * detail), this is the seam API-level requirements like
 * `withRequireIsolation()` and `checkpoint()` gate on. A value is set once
 * per backend and never changes at runtime.
 */
export interface BackendCapabilities {
  /**
   * `true` when each sandbox runs in its own hardware-virtualized microVM
   * with its own kernel (msb); `false` when sandboxes share the host kernel
   * (docker). `withRequireIsolation()` demands `true`.
   */
  readonly hardwareIsolated: boolean;
  /**
   * `true` when the backend can checkpoint/restore a sandbox's state
   * (docker: commit-to-image; msb: disk snapshot via `msb snapshot`).
   * `GenericContainer.checkpoint()` demands `true`.
   */
  readonly checkpoint: boolean;
  /**
   * `true` when a `checkpoint()` call on this backend restarts the
   * sandbox's workload as a side effect of capturing state (msb: the
   * stop/snapshot/reboot cycle boots a fresh microVM) — `false` when the
   * sandbox is undisturbed (docker: commit-to-image never touches the
   * running container). `GenericContainer.checkpoint()` re-runs the
   * container's own wait strategy before returning exactly when this is
   * `true`, so a caller never gets back a false-ready container.
   */
  readonly checkpointRestartsWorkload: boolean;
}

/**
 * The one interface every container backend implements. Host ports arrive
 * in `ContainerSpec.ports` already chosen (see `FreePorts`) — a backend
 * binds them, it never allocates its own.
 */
export interface SandboxBackend {
  /** The backend's own name (`"microsandbox"` or `"docker"`). */
  readonly name: string;
  /** `true` for docker (native bridge networks); `false` for msb, which emulates links over exec-stream tunnels instead. */
  readonly supportsNativeNetworks: boolean;
  /** This backend's isolation/checkpoint capability flags — see `BackendCapabilities`. */
  readonly capabilities: BackendCapabilities;
  /** Allocate the backend-native container without starting it. Must not bind ports or run the workload yet. */
  create(spec: ContainerSpec): Promise<SandboxHandle>;
  /** Boot the workload. On a bind conflict, throw (or wrap a cause chain ending in) `PortBindConflictError` so `GenericContainer`'s retry loop can classify it. */
  start(handle: SandboxHandle): Promise<void>;
  /** Best-effort stop; callers swallow failures during teardown. */
  stop(handle: SandboxHandle): Promise<void>;
  /** Best-effort removal of the backend-native resource; callers swallow failures during teardown. */
  remove(handle: SandboxHandle): Promise<void>;
  /**
   * Captures `handle`'s current state under `ref` —
   * `GenericContainer.checkpoint()`'s backend call, gated on
   * `capabilities.checkpoint` BEFORE this is ever reached, so an
   * unsupported backend never has to implement this for real (it may throw
   * defensively). Docker: commits the running container to image `ref`,
   * undisturbed. Microsandbox: stop the sandbox, `msb snapshot create` a
   * disk snapshot named `ref`, then start the sandbox back up — the
   * workload restarts, which is why `capabilities.checkpointRestartsWorkload`
   * exists. Never called on a backend whose `capabilities.checkpoint` is
   * `false`.
   */
  createCheckpoint(handle: SandboxHandle, ref: string): Promise<void>;
  /**
   * Best-effort removal of a checkpoint identified by `ref` (docker: `rmi`;
   * microsandbox: `msb snapshot rm`) — "not found" is success, the same
   * contract as `removeByName`. SPI-only: there is no public
   * `GenericContainer` method for this, only documented CLI one-liners for
   * end users; it exists so tests can keep shared CI state clean.
   */
  removeCheckpoint(ref: string): Promise<void>;
  /**
   * Probes whether a checkpoint artifact identified by `ref` still exists —
   * docker: image inspect; microsandbox: `msb snapshot inspect <ref>` exit
   * code. `Checkpoints.find`'s only caller: it never probes an entry
   * recorded under a DIFFERENT backend than the one this is called on, so in
   * practice this is only ever invoked on a backend whose
   * `capabilities.checkpoint` is `true`. A backend that never supports
   * checkpoints at all may implement this by throwing
   * `UnsupportedByBackendError`, the same defensive-throw convention
   * `createCheckpoint` documents for that case. A probe FAILURE (the
   * underlying call itself errors) must propagate — only a confirmed
   * "does not exist" may resolve `false`; best-effort `false` on an error is
   * not allowed.
   */
  hasCheckpoint(ref: string): Promise<boolean>;
  /**
   * Best-effort stop+remove of a sandbox identified by NAME rather than a
   * `SandboxHandle` — the reaping ledger only ever stores names (it must be
   * legible to a sweep running in a different process, possibly a
   * different rightsize language implementation entirely, that never held
   * a handle for this sandbox). "Not found" is silently fine: sweeps are
   * idempotent and may race another process's sweep for the same name.
   */
  removeByName(name: string): Promise<void>;
  /**
   * Checks whether a sandbox named `spec.name` is currently running and, if
   * so, returns a handle for it — reuse's adopt path, which never held a
   * handle for a sandbox a possibly-earlier process created. The returned
   * handle's `spec` is `spec` itself, embedded verbatim: this call never
   * re-derives a `ContainerSpec` from backend-native inspection data, it
   * only confirms liveness under the NAME the caller already built a spec
   * for. `undefined` means not running — including "the backend has no
   * record of this name at all."
   */
  findRunning(spec: ContainerSpec): Promise<SandboxHandle | undefined>;
  /** This backend's reaper watchdog kill-command prefixes — see `ReaperKillCommand`'s own doc. */
  reaperKillCommand(): Promise<ReaperKillCommand>;
  /** Run a one-shot command inside a running container and wait for it to exit. */
  exec(handle: SandboxHandle, cmd: ReadonlyArray<string>): Promise<ExecResult>;
  /** Fetch everything logged so far (bounded tail), for a one-shot read. */
  logs(handle: SandboxHandle): Promise<string>;
  /**
   * Stream log lines to `consumer` as they're produced, in order, with no
   * duplicates — including the final unterminated fragment after the
   * workload exits, delivered exactly once. Returns a handle whose `close()`
   * stops delivery without flushing anything further.
   */
  followLogs(handle: SandboxHandle, consumer: (line: string) => void): Promise<FollowHandle>;
  /** Idempotently ensure a network with this id exists. */
  ensureNetwork(networkId: string): Promise<void>;
  /** Best-effort removal of a network created by `ensureNetwork`. */
  removeNetwork(networkId: string): Promise<void>;
  /** Default no-op: docker relies on native networks. Only an emulating backend overrides it. */
  installNetworkLinks(handle: SandboxHandle, links: ReadonlyArray<NetworkLink>): Promise<void>;
  /**
   * Copies a host file or directory into the guest at `containerPath` — the
   * TRANSFER step only. `GenericContainer.copyFileToContainer()` owns the
   * running-check, the absolute-path check, and the `mkdir -p` pre-step (via
   * `exec`) before this is ever called; this method does only the copy
   * itself. `cp -r`-style destination naming: copying a directory to an
   * absent destination path produces that path as a copy of the source's
   * CONTENTS, not the source nested one level down — both backends' own
   * copy tools already behave this way. A failure must carry the
   * underlying tool's stderr in a `BackendError`, never a silent success.
   */
  copyToContainer(handle: SandboxHandle, hostPath: string, containerPath: string): Promise<void>;
  /** The reverse direction of `copyToContainer` — see its own doc for the shared contract (transfer only, `cp -r`-style naming, stderr on failure). */
  copyFromContainer(handle: SandboxHandle, containerPath: string, hostPath: string): Promise<void>;
  /** Best-effort teardown of backend-owned resources (sockets, child processes). */
  close(): Promise<void>;
  /**
   * Synchronous, blocking teardown of ONE container, for the process-exit
   * path only (`node:process`'s `"exit"` handler runs synchronously and
   * cannot `await` the backend's normal async `stop`/`remove`). Every
   * backend implements this with a blocking primitive of its own —
   * `child_process.spawnSync` for msb, a blocking unix-socket call for
   * docker — never by calling back into the async API. Best-effort: swallow
   * failures, the process is exiting regardless.
   */
  cleanupSync(id: string): void;
}

/**
 * The `ServiceLoader` analog: a backend subpath (`rightsize/backend-msb`,
 * `rightsize/backend-docker`) registers one of these at import time via
 * `registerBackend`. `Backends.resolve` picks the highest-priority supported
 * provider, or honors `RIGHTSIZE_BACKEND` when set.
 */
export interface BackendProvider {
  /** The provider's backend name, matched case-insensitively against `RIGHTSIZE_BACKEND`. */
  readonly name: string;
  /** Higher wins when multiple providers are supported (msb=20, docker=10). */
  readonly priority: number;
  /** MUST be synchronous — never return a Promise (a truthy Promise reads as "supported" to callers that don't await it). */
  isSupported(): boolean;
  /** Human-readable reason this provider isn't usable right now, surfaced when no supported provider exists. */
  unsupportedReason(): string;
  /** Construct the backend. Called once resolution has picked this provider. */
  create(): SandboxBackend;
}
