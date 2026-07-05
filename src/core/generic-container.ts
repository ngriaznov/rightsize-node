import { FreePorts } from "./free-ports.js";
import { RunId } from "./run-id.js";
import { Network } from "./network.js";
import type { NetworkMember } from "./network.js";
import { PortBindConflictError } from "./errors.js";
import { Wait } from "./wait.js";
import type { WaitStrategy, WaitTarget } from "./wait.js";
import { registerSyncCleanup, unregisterSyncCleanup } from "./cleanup.js";
import type { SandboxBackend, SandboxHandle, FollowHandle } from "./backend.js";
import type { ContainerSpec, FileMount, ExecResult } from "./model.js";
import type { MountableFile } from "./mountable-file.js";
import { Backends } from "./backends.js";

const MAX_START_ATTEMPTS = 5;

let sequence = 0;
function nextSequence(): number {
  sequence += 1;
  return sequence;
}

/** Typed-first, string-fallback classification: walk the cause chain for a typed conflict, else match the daemon's own wording. */
function isPortBindConflict(err: unknown): boolean {
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof PortBindConflictError) {
      return true;
    }
    if (current instanceof Error) {
      const message = current.message.toLowerCase();
      if (message.includes("address already in use") || message.includes("already allocated")) {
        return true;
      }
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return false;
}

async function swallow(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // Best-effort teardown: never let a stop/remove failure escape.
  }
}

/**
 * The builder, launcher, and lifecycle guard for a single container — the
 * one class every module (`RedisContainer`, `PostgresContainer`, …)
 * subclasses, and the type you reach for directly for any image without a
 * dedicated module.
 *
 * The instance itself is the guard: after `start()` it implements
 * `Symbol.asyncDispose`, so `await using c = await new GenericContainer(img).start()`
 * tears the container down at scope exit — the direct analog of the Kotlin
 * `AutoCloseable` and Rust's RAII guard, expressed with TC39 explicit
 * resource management. Prefer `await using` in tests; use explicit
 * `start()`/`stop()` where a `using` scope can't span a framework hook
 * (Jest/Vitest `beforeAll`/`afterAll`, `node:test`'s `before`/`after`).
 *
 * Builder methods (`withEnv`, `withExposedPorts`, …) mutate and return
 * `this` for chaining; none of them perform I/O. All I/O happens in
 * `start()`, `stop()`, `exec()`, `logs()`, and `followOutput()`.
 */
export class GenericContainer implements AsyncDisposable, NetworkMember {
  private readonly image: string;
  private envPairs: Array<[string, string]> = [];
  private exposedPorts: number[] = [];
  private command: string[] | undefined;
  private network: Network | undefined;
  private aliasNames: string[] = [];
  private mounts: FileMount[] = [];
  private waitStrategy: WaitStrategy = Wait.forListeningPort();
  private memoryLimitMb: number | undefined;
  private backendOverride: SandboxBackend | undefined;

  private handle: SandboxHandle | undefined;
  private backend: SandboxBackend | undefined;
  private mappedPorts: Map<number, number> = new Map();
  private running = false;

  /** Builds against `image` (e.g. `"redis:8.6-alpine"`); no I/O happens until `start()`. */
  constructor(image: string) {
    this.image = image;
  }

  /** Convenience: `new GenericContainer(image).start()`. */
  static async start(image: string): Promise<GenericContainer> {
    return new GenericContainer(image).start();
  }

  /** Sets an environment variable visible to the workload. Last-write-wins if called again with the same key; insertion order is otherwise preserved. */
  withEnv(key: string, value: string): this {
    // Last-write-wins, insertion-ordered: drop any prior entry for this key
    // before pushing, so re-setting the same key doesn't duplicate it while
    // still preserving the position of first-set for untouched keys.
    this.envPairs = this.envPairs.filter(([k]) => k !== key);
    this.envPairs.push([key, value]);
    return this;
  }

  /** Publishes these guest ports to pre-allocated host ports (see `FreePorts`); read back with `getMappedPort`. */
  withExposedPorts(...ports: number[]): this {
    this.exposedPorts.push(...ports);
    return this;
  }

  /** Overrides the image's default ENTRYPOINT/CMD. Omit this call entirely to run the image unmodified. */
  withCommand(...cmd: string[]): this {
    this.command = cmd;
    return this;
  }

  /** Joins a `Network`, making this container reachable from (and to) its running siblings by alias. */
  withNetwork(net: Network): this {
    this.network = net;
    return this;
  }

  /** Names this container answers to on its network — resolved via `Network.resolve(alias, port)` by other members. */
  withNetworkAliases(...names: string[]): this {
    this.aliasNames.push(...names);
    return this;
  }

  /** Copies a host file into the guest before boot, at `guestPath`. Read-only is enforced on docker; advisory only on msb (current microsandbox releases do not enforce guest-side read-only mounts). */
  withCopyFileToContainer(file: MountableFile, guestPath: string): this {
    this.mounts.push({ hostPath: file.path, guestPath, readOnly: true });
    return this;
  }

  /** Sets the readiness check `start()` waits on before returning. Defaults to `Wait.forListeningPort()`. */
  waitingFor(strategy: WaitStrategy): this {
    this.waitStrategy = strategy;
    return this;
  }

  /** Raises the container's memory ceiling (in MB) above the backend default — required by several JVM-heavy modules; see each module's own doc for its pin. */
  withMemoryLimit(megabytes: number): this {
    this.memoryLimitMb = megabytes;
    return this;
  }

  /** Test/advanced seam: pin the backend instead of resolving `Backends.active()`. */
  withBackend(backend: SandboxBackend): this {
    this.backendOverride = backend;
    return this;
  }

  /** Module hook: override to adjust the spec once mapped host ports are known (e.g. advertised listeners). */
  protected customizeSpec(spec: ContainerSpec, _mapped: (guest: number) => number): ContainerSpec {
    return spec;
  }

  /** Module hook: runs after the container is ready (e.g. `rs.initiate` for a Mongo replica set). */
  protected containerIsStarted(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Module hook: runs the instant `start()` has resolved a backend — before
   * `ensureNetwork`, port allocation, or the container is created/booted at
   * all. The one hook that lets a module reject a backend-incompatible
   * request (e.g. `FlinkContainer.withTaskManager()` on msb) without paying
   * for a boot first. `containerIsStarted()` (above) fires much later, after
   * this container is already fully up — fine for post-readiness setup, but
   * too late to fail fast on a capability the backend never had.
   */
  protected containerIsStarting(_backend: SandboxBackend): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Module hook: the backend this container actually started against (only
   * valid once `start()` has resolved it — i.e. from within
   * `containerIsStarted()` or later). Lets a module's post-start hook branch
   * on backend capability, e.g. `FlinkContainer.withTaskManager()` throwing a
   * typed `UnsupportedByBackendError` on msb instead of attempting a
   * network-link topology the exec-tunnel emulation can't carry.
   */
  protected currentBackend(): SandboxBackend {
    return this.requireHandle().backend;
  }

  private resolveBackend(): SandboxBackend {
    return this.backendOverride ?? Backends.active();
  }

  private buildSpec(name: string, ports: Map<number, number>): ContainerSpec {
    const spec: ContainerSpec = {
      name,
      image: this.image,
      env: this.envPairs.map(([k, v]) => [k, v] as const),
      command: this.command,
      ports: this.exposedPorts.map((guestPort) => ({
        hostPort: ports.get(guestPort) ?? (() => {
          throw new Error(`no allocated host port for guest port ${guestPort}`);
        })(),
        guestPort,
      })),
      mounts: this.mounts,
      networkId: this.network?.id,
      aliases: this.aliasNames,
      runId: RunId.value,
      memoryLimitMb: this.memoryLimitMb,
    };
    return this.customizeSpec(spec, (guest) => {
      const p = ports.get(guest);
      if (p === undefined) {
        throw new Error(`no allocated host port for guest port ${guest}`);
      }
      return p;
    });
  }

  private async allocatePorts(): Promise<Map<number, number>> {
    const ports = new Map<number, number>();
    for (const guestPort of this.exposedPorts) {
      ports.set(guestPort, await FreePorts.allocate());
    }
    return ports;
  }

  private releasePorts(ports: Map<number, number>): void {
    for (const hostPort of ports.values()) {
      FreePorts.release(hostPort);
    }
  }

  /**
   * Resolves a backend, allocates host ports, boots the container, installs
   * any network links, and waits for readiness — in that order. On ANY
   * failure partway through (a bad wait strategy, a network-link rejection,
   * a port conflict exhausting its retries), everything already allocated
   * or started is torn down to completion BEFORE this rejects: a
   * half-started container never leaks, and there is no detached
   * fire-and-forget cleanup running after `start()` has already returned
   * control to the caller.
   *
   * A host-port-bind conflict specifically retries (up to 5 attempts) with
   * a fresh port before giving up — pre-allocated ports can still lose an
   * allocate-then-bind race to an unrelated process.
   */
  async start(): Promise<this> {
    const backend = this.resolveBackend();
    await this.containerIsStarting(backend);

    if (this.network !== undefined) {
      await backend.ensureNetwork(this.network.id);
    }

    let handle: SandboxHandle | undefined;
    let allocatedPorts: Map<number, number> | undefined;
    let lastConflict: unknown;

    for (let attempt = 0; attempt < MAX_START_ATTEMPTS; attempt++) {
      const ports = await this.allocatePorts();
      const name = `rz-${RunId.value}-${nextSequence()}`;
      const spec = this.buildSpec(name, ports);

      let createdHandle: SandboxHandle | undefined;
      try {
        createdHandle = await backend.create(spec);
        await backend.start(createdHandle);
        handle = createdHandle;
        allocatedPorts = ports;
        break;
      } catch (err) {
        if (createdHandle !== undefined) {
          await swallow(() => backend.stop(createdHandle as SandboxHandle));
          await swallow(() => backend.remove(createdHandle as SandboxHandle));
        }
        this.releasePorts(ports);
        if (isPortBindConflict(err)) {
          lastConflict = err;
          continue;
        }
        throw err;
      }
    }

    if (handle === undefined || allocatedPorts === undefined) {
      throw new Error(
        `Failed to start '${this.image}' after ${MAX_START_ATTEMPTS} attempts: every attempt hit a host port already in use by another process.`,
        { cause: lastConflict },
      );
    }

    // Assign guard fields: getMappedPort/exec/logs become valid from here,
    // even though readiness (below) hasn't been confirmed yet.
    this.handle = handle;
    this.backend = backend;
    this.mappedPorts = allocatedPorts;
    this.running = true;
    // Real synchronous teardown, not a placeholder: if this process dies
    // before stop() ever runs (process.exit / SIGINT / SIGTERM), the exit
    // hook in cleanup.ts calls straight into the backend's own blocking
    // cleanupSync — the same mechanism a crash-recovery reaper would find
    // necessary, just invoked proactively instead of on the next process's
    // startup sweep.
    registerSyncCleanup(handle.id, () => backend.cleanupSync(handle.id));

    try {
      const links = this.network?.linksForNewMember() ?? [];
      await backend.installNetworkLinks(handle, links);
      // Register AFTER links are computed/installed — a container must
      // never see itself in its own linksForNewMember() call.
      if (this.network !== undefined) {
        this.network.register(this, this.aliasNames, backend);
      }
      await this.waitStrategy.waitUntilReady(this.asWaitTarget());
    } catch (err) {
      // A half-started container never leaks regardless of which step
      // failed: tear down to completion before this rejection surfaces, so
      // start() never returns until cleanup has actually finished.
      await this.stop();
      throw err;
    }

    await this.containerIsStarted();
    return this;
  }

  /**
   * Stops and removes the backend-native resource, releases its host ports,
   * and clears the port map. Idempotent — stopping a container that never
   * started, or stopping twice, is a harmless no-op the second time. Errors
   * from the backend's own stop/remove calls are swallowed (best-effort
   * teardown); this method itself never throws.
   */
  async stop(): Promise<void> {
    if (!this.running || this.handle === undefined || this.backend === undefined) {
      return;
    }
    const handle = this.handle;
    const backend = this.backend;
    this.running = false;

    await swallow(() => backend.stop(handle));
    await swallow(() => backend.remove(handle));
    unregisterSyncCleanup(handle.id);

    this.releasePorts(this.mappedPorts);
    this.mappedPorts = new Map();
  }

  /** `= stop()`. What `await using c = await new GenericContainer(img).start()` calls at scope exit; never throws. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }

  /** Whether `start()` has completed and `stop()` has not yet run. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Always `"127.0.0.1"` — every published port is bound loopback-only, on both backends. */
  get host(): string {
    return "127.0.0.1";
  }

  /** Names this container answers to on its network (set via `withNetworkAliases`). Part of the `NetworkMember` contract `Network` uses to compute links. */
  get aliases(): ReadonlyArray<string> {
    return this.aliasNames;
  }

  /** Every guest port this container published (set via `withExposedPorts`). Part of the `NetworkMember` contract `Network` uses to compute links. */
  get exposedGuestPorts(): ReadonlyArray<number> {
    return this.exposedPorts;
  }

  /**
   * The host port bound to `guestPort`. Throws distinct messages for the
   * two ways this can be wrong: not running at all ("call start() first"),
   * versus running but never exposed via `withExposedPorts` ("call
   * withExposedPorts(N)").
   */
  getMappedPort(guestPort: number): number {
    if (!this.running) {
      throw new Error(`Container is not running — call start() first.`);
    }
    const port = this.mappedPorts.get(guestPort);
    if (port === undefined) {
      throw new Error(`Port ${guestPort} is not exposed — call withExposedPorts(${guestPort}).`);
    }
    return port;
  }

  /** Alias for `getMappedPort`, satisfying the `NetworkMember`/`WaitTarget` shape (which name this method `mappedPort`). */
  mappedPort(guestPort: number): number {
    return this.getMappedPort(guestPort);
  }

  private requireHandle(): { handle: SandboxHandle; backend: SandboxBackend } {
    if (!this.running || this.handle === undefined || this.backend === undefined) {
      throw new Error(`Container is not running — call start() first.`);
    }
    return { handle: this.handle, backend: this.backend };
  }

  /** Runs a one-shot command inside the running container and waits for it to exit. Throws if the container is not running. */
  async exec(...cmd: string[]): Promise<ExecResult> {
    const { handle, backend } = this.requireHandle();
    return backend.exec(handle, cmd);
  }

  /** Fetches the workload's logs so far (a bounded tail), as a single string. Throws if the container is not running. */
  async logs(): Promise<string> {
    const { handle, backend } = this.requireHandle();
    return backend.logs(handle);
  }

  /**
   * Streams log lines to `consumer` as they're produced, in order, with no
   * duplicates — including the final unterminated fragment after the
   * workload exits, delivered exactly once. Call `close()` on the returned
   * handle to stop delivery without flushing anything further.
   */
  async followOutput(consumer: (line: string) => void): Promise<FollowHandle> {
    const { handle, backend } = this.requireHandle();
    return backend.followLogs(handle, consumer);
  }

  private asWaitTarget(): WaitTarget {
    return {
      host: this.host,
      mappedPort: (guestPort: number) => this.getMappedPort(guestPort),
      exposedGuestPorts: this.exposedPorts,
      currentLogs: () => this.logs(),
      describe: () => `container '${this.handle?.spec.name ?? this.image}' (image ${this.image})`,
    };
  }
}
