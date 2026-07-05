import { GenericContainer } from "../core/generic-container.js";
import { Network } from "../core/network.js";
import { Wait } from "../core/wait.js";
import { UnsupportedByBackendError } from "../core/errors.js";
import type { SandboxBackend } from "../core/backend.js";

const RPC_PORT = 6123;
const REST_PORT = 8081;
const JOBMANAGER_MEMORY_MB = 1024;
const TASKMANAGER_MEMORY_MB = 1024;
const JOBMANAGER_ALIAS = "flink-jobmanager";

/**
 * A Flink JobManager container (REST 8081, RPC 6123), with an optional
 * companion TaskManager on Docker only — see `withTaskManager()`.
 *
 * `FLINK_PROPERTIES` must set `jobmanager.rpc.address` on the JobManager
 * itself (not just the TaskManager): the JobManager's own Pekko/Akka actor
 * system binds its external address from this property too, and the image's
 * default (`localhost`) doesn't resolve to anything reachable from a sibling
 * container. Both roles get `withMemoryLimit(1024)` — verified booting
 * cleanly on this machine at that floor for a bare JobManager and for the
 * two-container topology on docker.
 *
 * ### `withTaskManager()` — docker-only (KNOWN, adjudicated msb limitation)
 *
 * A real Flink session cluster needs a TaskManager to actually run
 * anything; it registers with the JobManager over a **persistent
 * bidirectional Pekko/Akka RPC connection**. msb's network-link emulation
 * (`ExecTunnel`) only carries **client-speaks-first, one-exchange-at-a-time**
 * traffic through an in-guest `nc` listener — and the `flink` image ships
 * neither `nc` nor `busybox` at all (confirmed: `command -v nc` and
 * `command -v busybox` both exit 127 in `flink:1.20.5`), so the tunnel's
 * `installNetworkLinks` step can't even probe for the listener it would
 * need, let alone carry Pekko's long-lived duplex traffic if it somehow
 * could. `withTaskManager()` therefore throws `UnsupportedByBackendError`
 * from `containerIsStarting()` — the instant `start()` has resolved the msb
 * backend, before `ensureNetwork`, port allocation, or the JobManager
 * container is created/booted at all — rather than attempting a boot that
 * would hang or fail deep inside Flink's own registration timeout. On
 * docker, the same builder produces a real two-container session cluster on
 * a shared `Network`, and the TaskManager registers successfully (verified:
 * `/taskmanagers` reports one registered TM with a live heartbeat).
 */
export class FlinkContainer extends GenericContainer {
  private readonly imageTag: string;
  private taskManagerRequested = false;
  private taskManagerContainer: GenericContainer | undefined;
  private taskManagerNetwork: Network | undefined;
  private ownedNetwork: Network | undefined;

  constructor(image = "flink:1.20.5") {
    super(image);
    this.imageTag = image;
    this.withExposedPorts(RPC_PORT, REST_PORT)
      .withEnv("FLINK_PROPERTIES", `jobmanager.rpc.address: ${JOBMANAGER_ALIAS}`)
      .withCommand("jobmanager")
      .withMemoryLimit(JOBMANAGER_MEMORY_MB)
      .withNetworkAliases(JOBMANAGER_ALIAS)
      .waitingFor(Wait.forHttp("/overview").forPort(REST_PORT).withStartupTimeout(120_000));
  }

  static override async start(image = "flink:1.20.5"): Promise<FlinkContainer> {
    return (await new FlinkContainer(image).start()) as FlinkContainer;
  }

  /**
   * Requests a companion TaskManager, started on a shared `Network` once
   * the JobManager is ready. Docker only — see the class doc for why msb
   * can't carry this topology; calling `start()` after this on msb throws
   * `UnsupportedByBackendError` from `containerIsStarting()`, before any
   * boot work (network, ports, or the JobManager container itself) begins.
   */
  withTaskManager(): this {
    this.taskManagerRequested = true;
    const net = Network.newNetwork();
    this.ownedNetwork = net;
    this.taskManagerNetwork = net;
    this.withNetwork(net);
    return this;
  }

  /**
   * Fires the instant `start()` resolves a backend — before `ensureNetwork`,
   * port allocation, or the JobManager container is created/booted at all.
   * Rejecting an msb + withTaskManager() combination here, instead of in
   * `containerIsStarted()` after the JobManager has already fully booted,
   * means the caller never pays for (or has to clean up after) a boot this
   * backend was never going to be able to complete.
   */
  protected override async containerIsStarting(backend: SandboxBackend): Promise<void> {
    if (this.taskManagerRequested && backend.name === "microsandbox") {
      throw new UnsupportedByBackendError(
        "Flink TaskManager registration",
        backend.name,
        "the flink image ships no nc/busybox for the network-link exec-tunnel, and TaskManager registration is a persistent bidirectional RPC the tunnel can't carry anyway — run this with RIGHTSIZE_BACKEND=docker instead",
      );
    }
  }

  protected override async containerIsStarted(): Promise<void> {
    if (!this.taskManagerRequested) {
      return;
    }
    const backend = this.currentBackend();
    const network = this.taskManagerNetwork;
    if (network === undefined) {
      throw new Error("withTaskManager() requires a network, but none was set");
    }
    const taskManager = new GenericContainer(this.imageTag)
      .withEnv("FLINK_PROPERTIES", `jobmanager.rpc.address: ${JOBMANAGER_ALIAS}`)
      .withCommand("taskmanager")
      .withMemoryLimit(TASKMANAGER_MEMORY_MB)
      .withNetwork(network)
      // Use the SAME backend this JobManager actually resolved (test
      // doubles and an explicit RIGHTSIZE_BACKEND override must both carry
      // through to the companion container, not re-resolve independently).
      .withBackend(backend);
    this.taskManagerContainer = await taskManager.start();
  }

  override async stop(): Promise<void> {
    if (this.taskManagerContainer !== undefined) {
      await this.taskManagerContainer.stop();
      this.taskManagerContainer = undefined;
    }
    await super.stop();
    if (this.ownedNetwork !== undefined) {
      await this.ownedNetwork.close();
      this.ownedNetwork = undefined;
    }
  }

  /** The REST base URL for the running JobManager. */
  get restUrl(): string {
    return `http://${this.host}:${this.getMappedPort(REST_PORT)}`;
  }
}
