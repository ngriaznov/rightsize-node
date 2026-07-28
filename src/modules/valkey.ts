import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";
import { DockerImageName } from "../core/docker-image-name.js";

const GUEST_PORT = 6379;
const EXPECTED_REPOSITORY = "valkey/valkey";
const DEFAULT_IMAGE = "valkey/valkey:latest";

/**
 * A single-node Valkey container — the Redis-protocol-compatible fork,
 * following `RedisContainer`'s shape exactly. Readiness is anchored on the
 * same `Ready to accept connections tcp` log line Redis prints, for the
 * same reason: on a loaded host, msb's loopback forwarder can accept and
 * hold a TCP connection before the guest process is actually listening, so
 * a bare port probe risks returning before the server serves.
 *
 * `uri` deliberately uses the `redis://` scheme, not `valkey://`: every
 * client this library's tests and its users reach for — lettuce,
 * node-redis, or raw RESP over TCP — parses `redis://`, and Valkey speaks
 * that same wire protocol. This is not a copy-paste mistake.
 *
 * No-arg construction floats to `valkey/valkey:latest`, so the version
 * tracks upstream rather than this library's release cycle (verified
 * against `valkey/valkey:9.1-alpine`, including the no-memory-limit and PING
 * facts below). `latest` is Debian-based rather than Alpine — functionally
 * equivalent, larger to pull.
 */
export class ValkeyContainer extends GenericContainer {
  constructor(image: string | DockerImageName = DEFAULT_IMAGE) {
    super(DockerImageName.requireCompatible(image, EXPECTED_REPOSITORY));
    this.withExposedPorts(GUEST_PORT).waitingFor(Wait.forLogMessage(".*Ready to accept connections.*", 1));
    // No withMemoryLimit override: verified booting and answering PING with
    // no limit set beyond msb's default, well under 512 MB.
  }

  static override async start(image: string | DockerImageName = DEFAULT_IMAGE): Promise<ValkeyContainer> {
    return (await new ValkeyContainer(image).start()) as ValkeyContainer;
  }

  /** A `redis://` connection URI for the running container (see the class doc for why not `valkey://`). */
  get uri(): string {
    return `redis://${this.host}:${this.getMappedPort(GUEST_PORT)}`;
  }
}
