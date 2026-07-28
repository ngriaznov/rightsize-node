import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";
import { DockerImageName } from "../core/docker-image-name.js";
import type { ContainerSpec } from "../core/model.js";

const GUEST_PORT = 8529;
const EXPECTED_REPOSITORY = "arangodb";
const DEFAULT_IMAGE = "arangodb:latest";

/**
 * A single-node ArangoDB container. Auth is disabled by default; see
 * `withRootPassword` to enable it.
 *
 * No-arg construction floats to `arangodb:latest`, so the version tracks
 * upstream rather than this library's release cycle (verified against
 * `arangodb:3.11`).
 */
export class ArangoContainer extends GenericContainer {
  private rootPassword: string | undefined;

  constructor(image: string | DockerImageName = DEFAULT_IMAGE) {
    super(DockerImageName.requireCompatible(image, EXPECTED_REPOSITORY));
    this.withExposedPorts(GUEST_PORT)
      .withEnv("ARANGO_NO_AUTH", "1")
      .waitingFor(Wait.forHttp("/_api/version").forPort(GUEST_PORT).forStatusCode(200));
  }

  static override async start(image: string | DockerImageName = DEFAULT_IMAGE): Promise<ArangoContainer> {
    return (await new ArangoContainer(image).start()) as ArangoContainer;
  }

  /** Enables auth with the given root password, instead of the default no-auth setup. */
  withRootPassword(password: string): this {
    this.rootPassword = password;
    return this.withEnv("ARANGO_ROOT_PASSWORD", password);
  }

  // ARANGO_NO_AUTH and ARANGO_ROOT_PASSWORD are mutually exclusive on the
  // image; GenericContainer has no env-removal builder, so the no-auth
  // default is dropped here, at spec-build time, once a root password has
  // actually been requested — rather than threading a removeEnv method
  // through the base class for one module's one edge case.
  protected override customizeSpec(spec: ContainerSpec, _mapped: (guest: number) => number): ContainerSpec {
    if (this.rootPassword === undefined) {
      return spec;
    }
    return { ...spec, env: spec.env.filter(([key]) => key !== "ARANGO_NO_AUTH") };
  }

  /** The HTTP API endpoint for the running container. */
  get endpoint(): string {
    return `http://${this.host}:${this.getMappedPort(GUEST_PORT)}`;
  }
}
