import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";

const CONTROLLER_PORT = 9000;
const BROKER_PORT = 8000;
const STARTUP_TIMEOUT_MS = 180_000;

/**
 * A single-container Apache Pinot QuickStart cluster (controller + broker +
 * server + ZooKeeper, all four JVMs colocated in one image, started with
 * `QuickStart -type EMPTY` for a clean cluster with no demo tables).
 *
 * Two pins here correct guesses that turned out wrong against the real
 * 1.5.1 image:
 *
 * - The broker's query port is **8000**, not 8099. The image exposes
 *   8096–8099 (controller admin, and various internal ports) plus 9000, but
 *   QuickStart's broker binds 8000 for client queries; 8099 is never opened
 *   by this entrypoint.
 * - The image bakes `-Xmx4G` into the QuickStart launch scripts, so it needs
 *   `withMemoryLimit(4096)` on msb regardless of how modest the workload is.
 *   Measured on this machine: 2048/2560MB microVMs get OOM-killed outright;
 *   3072MB boots but runs at ~99% memory pressure with Helix RPC timeouts
 *   under any load; 4096MB is the first limit that boots AND stays stable
 *   (~74% steady-state utilization). This is a hard floor, not a tunable
 *   default — do not lower it.
 */
export class PinotContainer extends GenericContainer {
  constructor(image = "apachepinot/pinot:1.5.1") {
    super(image);
    this.withExposedPorts(CONTROLLER_PORT, BROKER_PORT)
      .withCommand("QuickStart", "-type", "EMPTY")
      .withMemoryLimit(4096)
      // A four-JVM cluster (controller+broker+server+ZK) cold-booting in one
      // microVM/container is legitimately slow; 180s gives it room without
      // masking a real hang.
      .waitingFor(Wait.forHttp("/health").forPort(CONTROLLER_PORT).withStartupTimeout(STARTUP_TIMEOUT_MS));
  }

  static override async start(image = "apachepinot/pinot:1.5.1"): Promise<PinotContainer> {
    return (await new PinotContainer(image).start()) as PinotContainer;
  }

  /** The controller's REST base URL (schema/table admin, `/health`). */
  get controllerUrl(): string {
    return `http://${this.host}:${this.getMappedPort(CONTROLLER_PORT)}`;
  }

  /** The broker's query base URL. */
  get brokerUrl(): string {
    return `http://${this.host}:${this.getMappedPort(BROKER_PORT)}`;
  }
}
