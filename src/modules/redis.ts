import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";
import { DockerImageName } from "../core/docker-image-name.js";

const GUEST_PORT = 6379;
const EXPECTED_REPOSITORY = "redis";
const DEFAULT_IMAGE = "redis:latest";

/**
 * A single-node Redis container. Readiness is anchored on Redis's own
 * "Ready to accept connections" log line rather than a TCP probe: on a loaded
 * host the port forwarder can accept and hold a connection in the window
 * between Redis binding its socket and actually serving, which a bare
 * listening-port check cannot see through.
 *
 * No-arg construction floats to `redis:latest`, so the version tracks
 * upstream rather than this library's release cycle (verified against
 * `redis:8.6-alpine`). `latest` is Debian-based, not Alpine — functionally
 * equivalent, just a larger pull.
 */
export class RedisContainer extends GenericContainer {
  constructor(image: string | DockerImageName = DEFAULT_IMAGE) {
    super(DockerImageName.requireCompatible(image, EXPECTED_REPOSITORY));
    this.withExposedPorts(GUEST_PORT).waitingFor(Wait.forLogMessage(".*Ready to accept connections.*", 1));
  }

  static override async start(image: string | DockerImageName = DEFAULT_IMAGE): Promise<RedisContainer> {
    return (await new RedisContainer(image).start()) as RedisContainer;
  }

  /** A `redis://` connection URI for the running container. */
  get uri(): string {
    return `redis://${this.host}:${this.getMappedPort(GUEST_PORT)}`;
  }
}
