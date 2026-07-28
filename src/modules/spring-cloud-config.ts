import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";
import { DockerImageName } from "../core/docker-image-name.js";

const GUEST_PORT = 8888;
const EXPECTED_REPOSITORY = "hyness/spring-cloud-config-server";
const DEFAULT_IMAGE = "hyness/spring-cloud-config-server:latest";

/**
 * A Spring Cloud Config Server container, ready-checked via its actuator
 * health endpoint.
 *
 * No-arg construction floats to `hyness/spring-cloud-config-server:latest` —
 * this module has always defaulted to the floating tag, so there is no
 * pinned version its measurements below need to be re-attributed from.
 *
 * Paketo's memory calculator sizes this JVM image's fixed regions
 * (measured ~704763K) above microsandbox's default microVM RAM (~450MB),
 * so `withMemoryLimit(1024)` is set by default here — without it, the
 * container never becomes ready on msb (times out around 180s); with it,
 * boot completes in roughly 19s.
 */
export class SpringCloudConfigContainer extends GenericContainer {
  constructor(image: string | DockerImageName = DEFAULT_IMAGE) {
    super(DockerImageName.requireCompatible(image, EXPECTED_REPOSITORY));
    this.withExposedPorts(GUEST_PORT).waitingFor(Wait.forHttp("/actuator/health").forPort(GUEST_PORT));
    this.withMemoryLimit(1024);
  }

  static override async start(
    image: string | DockerImageName = DEFAULT_IMAGE,
  ): Promise<SpringCloudConfigContainer> {
    return (await new SpringCloudConfigContainer(image).start()) as SpringCloudConfigContainer;
  }

  /** The config server's base URI for the running container. */
  get uri(): string {
    return `http://${this.host}:${this.getMappedPort(GUEST_PORT)}`;
  }
}
