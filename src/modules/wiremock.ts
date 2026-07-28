import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";
import { DockerImageName } from "../core/docker-image-name.js";

const GUEST_PORT = 8080;
const EXPECTED_REPOSITORY = "wiremock/wiremock";
const DEFAULT_IMAGE = "wiremock/wiremock:latest";

/**
 * A single-node WireMock container — the TypeScript ecosystem has no
 * in-process WireMock equivalent (unlike the JVM, where WireMock runs
 * embedded in the test process); this module is the closest thing:
 * a real WireMock server, isolated per test run, reachable over HTTP.
 *
 * `/__admin/health` ships in 3.x (verified against 3.13.2) and is a small,
 * dependency-free readiness signal, so it's preferred over polling
 * `/__admin/mappings` (which would also return 200 once the admin API is
 * up, but reads as "list of stubs" rather than "am I healthy").
 *
 * No-arg construction floats to `wiremock/wiremock:latest`, so the version
 * tracks upstream rather than this library's release cycle (verified
 * against `wiremock/wiremock:3.13.2`).
 */
export class WireMockContainer extends GenericContainer {
  constructor(image: string | DockerImageName = DEFAULT_IMAGE) {
    super(DockerImageName.requireCompatible(image, EXPECTED_REPOSITORY));
    this.withExposedPorts(GUEST_PORT).waitingFor(Wait.forHttp("/__admin/health").forPort(GUEST_PORT));
  }

  static override async start(image: string | DockerImageName = DEFAULT_IMAGE): Promise<WireMockContainer> {
    return (await new WireMockContainer(image).start()) as WireMockContainer;
  }

  /** The stubbed API's base URL (mock endpoints are served from here). */
  get baseUrl(): string {
    return `http://${this.host}:${this.getMappedPort(GUEST_PORT)}`;
  }

  /** The admin API's base URL (`/__admin/...` — mapping management, health, requests). */
  get adminUrl(): string {
    return `${this.baseUrl}/__admin`;
  }
}
