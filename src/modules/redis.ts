import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";

const GUEST_PORT = 6379;

/** A single-node Redis container. */
export class RedisContainer extends GenericContainer {
  constructor(image = "redis:8.6-alpine") {
    super(image);
    this.withExposedPorts(GUEST_PORT).waitingFor(Wait.forListeningPort());
  }

  static override async start(image = "redis:8.6-alpine"): Promise<RedisContainer> {
    return (await new RedisContainer(image).start()) as RedisContainer;
  }

  /** A `redis://` connection URI for the running container. */
  get uri(): string {
    return `redis://${this.host}:${this.getMappedPort(GUEST_PORT)}`;
  }
}
