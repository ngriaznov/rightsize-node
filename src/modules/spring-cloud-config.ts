import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";

const GUEST_PORT = 8888;

/**
 * A Spring Cloud Config Server container, ready-checked via its actuator
 * health endpoint.
 *
 * Paketo's memory calculator sizes this JVM image's fixed regions
 * (measured ~704763K) above microsandbox's default microVM RAM (~450MB),
 * so `withMemoryLimit(1024)` is set by default here — without it, the
 * container never becomes ready on msb (times out around 180s); with it,
 * boot completes in roughly 19s.
 */
export class SpringCloudConfigContainer extends GenericContainer {
  constructor(image = "hyness/spring-cloud-config-server:latest") {
    super(image);
    this.withExposedPorts(GUEST_PORT).waitingFor(Wait.forHttp("/actuator/health").forPort(GUEST_PORT));
    this.withMemoryLimit(1024);
  }

  static override async start(image = "hyness/spring-cloud-config-server:latest"): Promise<SpringCloudConfigContainer> {
    return (await new SpringCloudConfigContainer(image).start()) as SpringCloudConfigContainer;
  }

  /** The config server's base URI for the running container. */
  get uri(): string {
    return `http://${this.host}:${this.getMappedPort(GUEST_PORT)}`;
  }
}
