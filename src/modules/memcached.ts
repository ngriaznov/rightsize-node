import * as net from "node:net";
import { GenericContainer } from "../core/generic-container.js";
import { ContainerLaunchError } from "../core/errors.js";
import type { WaitStrategy, WaitTarget } from "../core/wait.js";

const GUEST_PORT = 11211;
const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;
const PROBE_TIMEOUT_MS = 1_000;
const LOG_TAIL_LINES = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Speaks the memcached text protocol instead of trusting a bare TCP
 * connect: the docker userland proxy (and the msb port-publish emulation)
 * accepts the host port before the guest's memcached process is actually
 * listening, and memcached itself never logs anything on startup, so
 * there is no log line to wait on either. Sending `version` and requiring
 * a `VERSION` reply proves a real memcached is on the other end.
 */
export class MemcachedRespondsStrategy implements WaitStrategy {
  private timeoutMs = DEFAULT_TIMEOUT_MS;

  withStartupTimeout(ms: number): this {
    this.timeoutMs = ms;
    return this;
  }

  private probe(host: string, port: number): Promise<boolean> {
    return new Promise((resolveProbe) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (ready: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(hardTimer);
        socket.removeAllListeners();
        socket.destroy();
        resolveProbe(ready);
      };

      // Defense in depth: socket.setTimeout() below is the primary bound,
      // but a plain JS timer as a backstop costs nothing and closes a class
      // of bug this codebase has hit before (see the connect/response
      // timeout added to DockerClient.send()) — a socket-level timeout that,
      // on at least one runtime, intermittently never fires for a connection
      // that never completes, leaving nothing else to ever settle this
      // promise. waitUntilReady's own polling loop can't rescue a probe()
      // call that never resolves in the first place.
      const hardTimer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS + 500);

      socket.setTimeout(PROBE_TIMEOUT_MS);
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
      socket.connect(port, host, () => {
        socket.write("version\r\n");
      });
      let buffered = "";
      socket.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        const line = buffered.split("\r\n")[0] ?? "";
        if (line.length > 0) {
          finish(line.startsWith("VERSION"));
        }
      });
    });
  }

  async waitUntilReady(target: WaitTarget): Promise<void> {
    const guestPort = target.exposedGuestPorts[0];
    if (guestPort === undefined) {
      return;
    }
    const hostPort = target.mappedPort(guestPort);
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      if (await this.probe(target.host, hostPort)) {
        return;
      }
      if (Date.now() >= deadline) {
        let logs: string;
        try {
          logs = await target.currentLogs();
        } catch {
          logs = "";
        }
        const tail = logs.split("\n").slice(-LOG_TAIL_LINES).join("\n");
        throw new ContainerLaunchError(
          `Timed out waiting for ${target.describe()} to reply to a VERSION probe.\n${tail}`,
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

/** A single-node Memcached container, ready-checked with a protocol-level `version` probe. */
export class MemcachedContainer extends GenericContainer {
  constructor(image = "memcached:1.6-alpine") {
    super(image);
    this.withExposedPorts(GUEST_PORT).waitingFor(new MemcachedRespondsStrategy());
  }

  static override async start(image = "memcached:1.6-alpine"): Promise<MemcachedContainer> {
    return (await new MemcachedContainer(image).start()) as MemcachedContainer;
  }

  /** The `host:port` address of the running container. */
  get address(): string {
    return `${this.host}:${this.getMappedPort(GUEST_PORT)}`;
  }
}
