import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";

const GUEST_PORT = 6379;

/**
 * A single-node Redis container. Readiness is anchored on Redis's own
 * "Ready to accept connections" log line rather than a TCP probe: on a loaded
 * host the port forwarder can accept and hold a connection in the window
 * between Redis binding its socket and actually serving, which a bare
 * listening-port check cannot see through.
 */
export class RedisContainer extends GenericContainer {
  constructor(image = "redis:8.6-alpine") {
    super(image);
    this.withExposedPorts(GUEST_PORT).waitingFor(Wait.forLogMessage(".*Ready to accept connections.*", 1));
  }

  static override async start(image = "redis:8.6-alpine"): Promise<RedisContainer> {
    return (await new RedisContainer(image).start()) as RedisContainer;
  }

  /** A `redis://` connection URI for the running container. */
  get uri(): string {
    return `redis://${this.host}:${this.getMappedPort(GUEST_PORT)}`;
  }
}
