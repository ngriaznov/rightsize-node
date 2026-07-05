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
 * The one interface every container backend implements. Host ports arrive
 * in `ContainerSpec.ports` already chosen (see `FreePorts`) — a backend
 * binds them, it never allocates its own.
 */
export interface SandboxBackend {
  /** The backend's own name (`"microsandbox"` or `"docker"`). */
  readonly name: string;
  /** `true` for docker (native bridge networks); `false` for msb, which emulates links over exec-stream tunnels instead. */
  readonly supportsNativeNetworks: boolean;
  /** Allocate the backend-native container without starting it. Must not bind ports or run the workload yet. */
  create(spec: ContainerSpec): Promise<SandboxHandle>;
  /** Boot the workload. On a bind conflict, throw (or wrap a cause chain ending in) `PortBindConflictError` so `GenericContainer`'s retry loop can classify it. */
  start(handle: SandboxHandle): Promise<void>;
  /** Best-effort stop; callers swallow failures during teardown. */
  stop(handle: SandboxHandle): Promise<void>;
  /** Best-effort removal of the backend-native resource; callers swallow failures during teardown. */
  remove(handle: SandboxHandle): Promise<void>;
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
