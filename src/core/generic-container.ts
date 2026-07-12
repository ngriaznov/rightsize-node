import { randomBytes } from "node:crypto";
import { FreePorts } from "./free-ports.js";
import { RunId } from "./run-id.js";
import { Network } from "./network.js";
import type { NetworkMember } from "./network.js";
import { PortBindConflictError, IsolationRequiredError, CheckpointUnsupportedError } from "./errors.js";
import { Wait } from "./wait.js";
import type { WaitStrategy, WaitTarget } from "./wait.js";
import { registerSyncCleanup, unregisterSyncCleanup } from "./cleanup.js";
import type { SandboxBackend, SandboxHandle, FollowHandle } from "./backend.js";
import type { ContainerSpec, FileMount, ExecResult, Checkpoint } from "./model.js";
import type { MountableFile } from "./mountable-file.js";
import { Backends } from "./backends.js";
import { trackSandbox, untrackSandbox, trackNetwork } from "./reaper/init.js";
import { cacheDir } from "./cache-dir.js";
import { ReuseWithNetworkError } from "./errors.js";
import { reuseEnabled } from "./reuse/env.js";
import { reuseHash, reuseName } from "./reuse/hash.js";
import { readRegistry, writeRegistryAtomic, removeRegistry, type ReuseRegistryEntry } from "./reuse/registry.js";

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

/** `Map<guestPort, hostPort>` → the registry's `{"<guestPort>": <hostPort>}` shape — JSON object keys are always strings. */
function portsToRegistryRecord(ports: ReadonlyMap<number, number>): Record<string, number> {
  const record: Record<string, number> = {};
  for (const [guestPort, hostPort] of ports) {
    record[String(guestPort)] = hostPort;
  }
  return record;
}

/** The inverse of `portsToRegistryRecord`. */
function registryRecordToPorts(record: Record<string, number>): Map<number, number> {
  const ports = new Map<number, number>();
  for (const [guestPort, hostPort] of Object.entries(record)) {
    ports.set(Number(guestPort), hostPort);
  }
  return ports;
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
  private reuseRequested = false;
  private requireIsolationRequested = false;

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

  /**
   * Builds a normal, ephemeral `GenericContainer` from a `Checkpoint`
   * (`checkpoint()`'s return value): image is `cp.imageRef`, and
   * env/command/exposed ports/memory limit default to `cp.spec` — chain
   * further builder calls (a different `waitingFor`, `withBackend`, …)
   * before `start()`, the same as any other container. Never carries over
   * `cp.spec`'s network/aliases/mounts — the committed image already has
   * the filesystem baked in, and (as with `withReuse()`'s own network
   * restriction) network topology is never part of what a checkpoint
   * captures. Once started, a restored container is ordinary in every
   * respect: fresh host ports, normal reaping-ledger tracking, normal stop.
   */
  static fromCheckpoint(cp: Checkpoint): GenericContainer {
    const container = new GenericContainer(cp.imageRef);
    for (const [key, value] of cp.spec.env) {
      container.withEnv(key, value);
    }
    if (cp.spec.command !== undefined) {
      container.withCommand(...cp.spec.command);
    }
    if (cp.spec.ports.length > 0) {
      container.withExposedPorts(...cp.spec.ports.map((p) => p.guestPort));
    }
    if (cp.spec.memoryLimitMb !== undefined) {
      container.withMemoryLimit(cp.spec.memoryLimitMb);
    }
    return container;
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

  /**
   * Marks this container for reuse: survive process exit and be ADOPTED —
   * not re-created — by the next equivalent container's `start()`, in this
   * process or a later one. Double opt-in: this API marker alone does
   * nothing unless `RIGHTSIZE_REUSE` is also `"true"` or `"1"` at `start()`
   * time. Marked-but-not-enabled starts as an ordinary ephemeral container
   * (Testcontainers semantics), with a one-time stderr note. See the
   * [reuse guide](/guide/reuse) for identity rules, the network
   * restriction, and manual cleanup.
   */
  withReuse(): this {
    this.reuseRequested = true;
    return this;
  }

  /**
   * Demands hardware-virtualized isolation: `start()` throws
   * `IsolationRequiredError` before any create/network work if the active
   * backend's `capabilities.hardwareIsolated` is `false` (the docker
   * fallback, which shares the host kernel), instead of silently degrading.
   * Use for tests that run untrusted code. See the
   * [isolation guide](/guide/isolation).
   */
  withRequireIsolation(): this {
    this.requireIsolationRequested = true;
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
      // This ephemeral path is never taken by an active reuse container —
      // that's buildReuseSpec()'s job, always with keepAlive: true. A
      // requested-but-env-disabled reuse container falls through to here
      // deliberately (Testcontainers semantics), so it must stay false.
      keepAlive: false,
    };
    return this.customizeSpec(spec, (guest) => {
      const p = ports.get(guest);
      if (p === undefined) {
        throw new Error(`no allocated host port for guest port ${guest}`);
      }
      return p;
    });
  }

  /** The reuse-active counterpart of `buildSpec`: always `keepAlive: true`, named `rz-reuse-<hash12>` rather than the run-scoped `rz-<runId>-<seq>`, and never joined to a `Network` (rejected earlier in `start()`). */
  private buildReuseSpec(name: string, ports: Map<number, number>): ContainerSpec {
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
      networkId: undefined,
      aliases: this.aliasNames,
      runId: RunId.value,
      memoryLimitMb: this.memoryLimitMb,
      keepAlive: true,
    };
    return this.customizeSpec(spec, (guest) => {
      const p = ports.get(guest);
      if (p === undefined) {
        throw new Error(`no allocated host port for guest port ${guest}`);
      }
      return p;
    });
  }

  /** This container's reuse identity hash — the reuse-relevant subset of its builder state, hashed per `reuseHash`'s canonical form. Reads every `withCopyFileToContainer` source file's CURRENT content, so a mutated source file between two `start()` calls changes identity. */
  private async computeReuseHash(): Promise<string> {
    return reuseHash({
      image: this.image,
      env: this.envPairs.map(([k, v]) => [k, v] as const),
      command: this.command,
      exposedPorts: this.exposedPorts,
      memoryLimitMb: this.memoryLimitMb,
      copies: this.mounts.map((m) => ({ guestPath: m.guestPath, hostPath: m.hostPath })),
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
    // Only the env-resolved path (never an explicit withBackend() override)
    // drives the reaper: writes this process's run record, sweeps dead runs
    // on first use, and spawns the watchdog. Skipping it for overrides is
    // deliberate (see the feature's own addendum) — the ledger's per-call
    // no-op guard means every trackSandbox/trackNetwork call below is
    // automatically inert for a process that never resolves a backend this
    // way, so nothing else here needs to branch on backendOverride too.
    if (this.backendOverride === undefined) {
      await Backends.reaperReady();
    }
    // Checked before the containerIsStarting hook and before any
    // network/port/create work — see withRequireIsolation()'s own doc. No
    // sandbox is ever created for a rejected request.
    if (this.requireIsolationRequested && !backend.capabilities.hardwareIsolated) {
      throw new IsolationRequiredError(backend.name);
    }
    await this.containerIsStarting(backend);

    // Double opt-in (see withReuse()'s own doc): both the API marker AND
    // RIGHTSIZE_REUSE must be set for reuse to actually engage. Requested-
    // but-not-enabled falls straight through to the ordinary ephemeral flow
    // below — ONE note on stderr, then Testcontainers-standard behavior.
    if (this.reuseRequested) {
      if (reuseEnabled(process.env)) {
        if (this.network !== undefined) {
          throw new ReuseWithNetworkError();
        }
        return this.startReuse(backend);
      }
      process.stderr.write(
        `[rightsize] reuse was requested via withReuse() for '${this.image}' but RIGHTSIZE_REUSE is not ` +
          `enabled — starting as an ordinary (non-reused) container.\n`,
      );
    }

    if (this.network !== undefined) {
      await backend.ensureNetwork(this.network.id);
      await trackNetwork(this.network.id);
    }

    let handle: SandboxHandle | undefined;
    let allocatedPorts: Map<number, number> | undefined;
    let lastConflict: unknown;

    for (let attempt = 0; attempt < MAX_START_ATTEMPTS; attempt++) {
      const ports = await this.allocatePorts();
      const name = `rz-${RunId.value}-${nextSequence()}`;
      const spec = this.buildSpec(name, ports);

      // Appended BEFORE create() — the ledger's `.sandboxes` file is always
      // a superset of this run's live sandboxes, never a subset. `keepAlive`
      // containers are never listed at all, so a sweep can never reach one
      // — this path only ever builds a spec via buildSpec(), which is
      // always keepAlive: false (see its own doc); an active reuse
      // container takes the entirely separate startReuse() path below.
      if (!spec.keepAlive) {
        await trackSandbox(name);
      }

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
        if (!spec.keepAlive) {
          await untrackSandbox(name);
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
    // startup sweep. `keepAlive` containers are kept OUT of this registry
    // entirely, the same way they're kept out of the ledger above: they're
    // meant to outlive this process, so the exit path must never tear one
    // down — see the note on the ledger append above for why this path
    // never sees keepAlive: true in practice.
    if (!handle.spec.keepAlive) {
      registerSyncCleanup(handle, backend, () => backend.cleanupSync(handle.id));
    }

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
   * The reuse-active start path — an entirely separate flow from the
   * ephemeral one above, never joining `MAX_START_ATTEMPTS`'s port-conflict
   * retry loop, the ledger, or the sync-cleanup registry (all deliberate:
   * see `withReuse()`'s own doc and the reaping addendum). Computes this
   * container's identity hash, then adopts an existing sandbox or creates a
   * fresh one under the deterministic `rz-reuse-<hash12>` name.
   */
  private async startReuse(backend: SandboxBackend): Promise<this> {
    const dir = cacheDir();
    const hash = await this.computeReuseHash();
    const name = reuseName(hash);

    const { handle, mappedPorts } = await this.adoptOrCreate(backend, dir, hash, name, false);

    this.handle = handle;
    this.backend = backend;
    this.mappedPorts = mappedPorts;
    this.running = true;
    // Deliberately no registerSyncCleanup and no ledger trackSandbox call —
    // a keepAlive sandbox must outlive this process, which is exactly what
    // both of those exist to prevent (see start()'s own doc on the
    // ephemeral path for the symmetric reasoning).

    await this.containerIsStarted();
    return this;
  }

  /**
   * Reads the registry once and either adopts (registry hit, running,
   * wait ok) or falls through to a fresh create — see the reuse spec's own
   * "Start flow when reuse is active" for the full state table this
   * implements. `isRetry` caps the name-collision recursion at one retry
   * (`adoptOrCreate` re-enters itself exactly once, from the create/start
   * failure branch below): "another process won the race" is expected to
   * resolve within one retry (by then its own registry write has very
   * likely landed); anything still colliding after that is a genuine
   * failure, not a race, and propagates.
   */
  private async adoptOrCreate(
    backend: SandboxBackend,
    dir: string,
    hash: string,
    name: string,
    isRetry: boolean,
  ): Promise<{ handle: SandboxHandle; mappedPorts: Map<number, number> }> {
    const read = await readRegistry(dir, hash);
    if (read.kind === "found") {
      const adopted = await this.tryAdopt(backend, dir, hash, name, read.entry);
      if (adopted !== undefined) {
        return adopted;
      }
      // tryAdopt already best-effort-removed the stale sandbox + registry
      // file; fall through to a fresh create below, same as "missing".
    } else if (read.kind === "corrupt") {
      // Unparseable: don't trust anything about what's there, but the name
      // is deterministic from `hash` regardless of registry content, so a
      // best-effort removal is still possible — see the reuse spec's
      // stale/corrupt-registry fallback.
      await this.cleanupStaleReuse(backend, dir, hash, name);
    } else {
      // read.kind === "missing": the common first-time-ever case, but ALSO
      // exactly the crash-mid-boot orphan window (see the reuse guide's
      // "recovering from a crash mid-boot" note): the registry entry is
      // only ever written AFTER a fresh-created reuse sandbox passes its
      // OWN wait strategy, so a process that crashed — or failed that wait
      // — between create() and that write can leave a sandbox RUNNING under
      // this exact deterministic name with no registry entry to say so.
      // `keepAlive` makes it invisible to reaping, so nothing else in this
      // library will ever clear it. Ask the backend directly whether that
      // name is live before racing a fresh create() against it.
      await this.removeOrphanedRunningReuse(backend, name);
    }

    // Same host-port-bind-conflict retry as the ephemeral flow in start()
    // (see MAX_START_ATTEMPTS there): a pre-allocated port can still lose an
    // allocate-then-bind race to an unrelated process, and a reuse create is
    // no less exposed to that than an ephemeral one.
    let handle: SandboxHandle | undefined;
    let allocatedPorts: Map<number, number> | undefined;
    let lastConflict: unknown;

    for (let attempt = 0; attempt < MAX_START_ATTEMPTS; attempt++) {
      const ports = await this.allocatePorts();
      const spec = this.buildReuseSpec(name, ports);

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
        if (!isRetry) {
          // "Another process won the race": if the name is running NOW,
          // this failure was very likely that collision rather than a
          // genuine backend error — re-enter the adopt path once rather
          // than surfacing a spurious create() failure. A create/start
          // failure for an unrelated reason leaves findRunning reporting
          // nothing, so the original error still propagates below.
          const runningNow = await backend.findRunning(spec).catch(() => undefined);
          if (runningNow !== undefined) {
            return this.adoptOrCreate(backend, dir, hash, name, true);
          }
        }
        throw err;
      }
    }

    if (handle === undefined || allocatedPorts === undefined) {
      throw new Error(
        `Failed to start reuse container '${this.image}' after ${MAX_START_ATTEMPTS} attempts: every attempt hit a host port already in use by another process.`,
        { cause: lastConflict },
      );
    }
    const ports = allocatedPorts;

    try {
      await this.waitStrategy.waitUntilReady(this.waitTargetFor(backend, handle, ports));
    } catch (err) {
      await swallow(() => backend.stop(handle));
      await swallow(() => backend.remove(handle));
      this.releasePorts(ports);
      throw err;
    }

    const entry: ReuseRegistryEntry = {
      name,
      image: this.image,
      ports: portsToRegistryRecord(ports),
      createdIso: new Date().toISOString(),
      backend: backend.name,
    };
    await writeRegistryAtomic(dir, hash, entry);

    return { handle, mappedPorts: ports };
  }

  /**
   * Registry hit → verify: confirm the name is actually running (backend
   * query, never trusted from the file alone), then re-run this
   * container's OWN wait strategy against the recorded ports — a running
   * sandbox that never became ready for THIS workload is exactly as
   * unadoptable as one that isn't running at all. `undefined` means adopt
   * failed for any reason (not running, or the wait failed); the caller's
   * best-effort cleanup already ran by the time this returns.
   */
  private async tryAdopt(
    backend: SandboxBackend,
    dir: string,
    hash: string,
    name: string,
    entry: ReuseRegistryEntry,
  ): Promise<{ handle: SandboxHandle; mappedPorts: Map<number, number> } | undefined> {
    const mappedPorts = registryRecordToPorts(entry.ports);
    const spec = this.buildReuseSpec(name, mappedPorts);

    const handle = await backend.findRunning(spec).catch(() => undefined);
    if (handle === undefined) {
      await this.cleanupStaleReuse(backend, dir, hash, name);
      return undefined;
    }

    try {
      await this.waitStrategy.waitUntilReady(this.waitTargetFor(backend, handle, mappedPorts));
    } catch {
      await this.cleanupStaleReuse(backend, dir, hash, name);
      return undefined;
    }

    return { handle, mappedPorts };
  }

  /** Best-effort: remove whatever's running under `name` (by name — this call never held a handle for it) and delete the registry file. Never throws. */
  private async cleanupStaleReuse(backend: SandboxBackend, dir: string, hash: string, name: string): Promise<void> {
    await swallow(() => backend.removeByName(name));
    await removeRegistry(dir, hash);
  }

  /**
   * The crash-mid-boot-orphan guard for the "no registry entry at all"
   * fresh-create path: confirms with the backend whether `name` is actually
   * running BEFORE this container's own create() attempt, and only then
   * best-effort-removes it — never a blind `removeByName` the way
   * `cleanupStaleReuse` above does for the corrupt/failed-verification
   * cases, where a registry entry (however stale) already proved something
   * about this identity once existed. Here nothing has ever proved that, so
   * the common empty-cache case (nothing running) pays no removal call at
   * all, and a concurrent creator that's already past ITS OWN create()-and-
   * register cycle by the time this runs is instead caught by the
   * name-collision-retry-into-adopt path below (a registry entry appearing
   * for it means that process won the race — adopt, don't remove). The spec
   * handed to `findRunning` here is a throwaway: any exposed ports serve
   * only to satisfy `ContainerSpec`'s shape, since every backend's
   * `findRunning` matches on `spec.name` alone.
   */
  private async removeOrphanedRunningReuse(backend: SandboxBackend, name: string): Promise<void> {
    const probePorts = new Map(this.exposedPorts.map((guestPort) => [guestPort, 0]));
    const probeSpec = this.buildReuseSpec(name, probePorts);
    const running = await backend.findRunning(probeSpec).catch(() => undefined);
    if (running !== undefined) {
      await swallow(() => backend.removeByName(name));
    }
  }

  /** The `WaitTarget` for a specific (backend, handle, ports) triple, independent of this instance's own `this.handle`/`this.backend`/`this.mappedPorts` — needed because reuse's adopt-verification wait runs BEFORE those fields are ever assigned. */
  private waitTargetFor(backend: SandboxBackend, handle: SandboxHandle, ports: Map<number, number>): WaitTarget {
    return {
      host: this.host,
      mappedPort: (guestPort: number): number => {
        const p = ports.get(guestPort);
        if (p === undefined) {
          throw new Error(`Port ${guestPort} is not exposed — call withExposedPorts(${guestPort}).`);
        }
        return p;
      },
      exposedGuestPorts: this.exposedPorts,
      currentLogs: () => backend.logs(handle),
      describe: () => `container '${handle.spec.name}' (image ${this.image})`,
    };
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

    // keepAlive (reuse) is the one case that is NOT teardown: the sandbox
    // is deliberately LEFT RUNNING — that's the whole feature — so none of
    // the backend-native stop/remove, the sync-cleanup registration (never
    // made in the first place, see start()), or the ledger untracking
    // (never tracked in the first place) apply here. Only this instance's
    // OWN bookkeeping (running flag, port map) is cleared below.
    if (handle.spec.keepAlive) {
      // The sandbox's host ports stay genuinely bound for as long as it
      // keeps running (indefinitely, past this call) — returning them to
      // FreePorts here would let an unrelated later allocation in THIS
      // process collide with a port that is still very much in use. They
      // simply stay marked issued for the rest of this process's lifetime;
      // only this instance's own view of them is cleared below.
      this.mappedPorts = new Map();
      return;
    }

    await swallow(() => backend.stop(handle));
    await swallow(() => backend.remove(handle));
    unregisterSyncCleanup(handle.id);
    await untrackSandbox(handle.spec.name);

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

  /**
   * Commits this running container's filesystem to a new image and returns
   * a `Checkpoint` — a FILESYSTEM capture, not a memory snapshot:
   * `fromCheckpoint()` boots a fresh container from the committed image
   * with processes restarting from scratch, not resuming. Requires the
   * active backend's `capabilities.checkpoint` (docker: `true`, via image
   * commit; microsandbox: `false`, no upstream microVM snapshot support
   * yet) — checked BEFORE any backend call, so an unsupported backend never
   * attempts one. Throws a state error (same shape as `exec`/`logs`) if
   * this container isn't currently running. Checkpoint images are never
   * auto-reaped (they're images, not containers) — see the checkpoints
   * guide for the manual cleanup one-liner.
   */
  async checkpoint(): Promise<Checkpoint> {
    const { handle, backend } = this.requireHandle();
    if (!backend.capabilities.checkpoint) {
      throw new CheckpointUnsupportedError(backend.name);
    }
    const imageRef = `rightsize/checkpoint:${randomBytes(6).toString("hex")}`;
    await backend.commitToImage(handle, imageRef);
    return { imageRef, spec: handle.spec };
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
