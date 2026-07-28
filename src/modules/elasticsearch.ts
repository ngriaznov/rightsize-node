import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";
import { DockerImageName } from "../core/docker-image-name.js";

const REST_PORT = 9200;
const TRANSPORT_PORT = 9300;
const STARTUP_TIMEOUT_MS = 300_000;
const EXPECTED_REPOSITORY = "elasticsearch";

/**
 * A single-node Elasticsearch container.
 *
 * ### No no-arg constructor — Elastic publishes no floating tag
 *
 * Every other module in this library floats to the image's own `:latest`
 * (or an equivalent) when no image is given, so the version tracks upstream
 * rather than this library's release cycle. Elasticsearch has no such tag to
 * float to: `elasticsearch:latest`, `elasticsearch:9`, and `elasticsearch:8`
 * are all 404 on Docker Hub — Elastic publishes only full version tags
 * (verified against `elasticsearch:9.4.4`, arm64). An explicit image is
 * therefore required on both the constructor and `start()`; there is no
 * default to fall back to.
 *
 * ### Single-node config
 *
 * `discovery.type=single-node` skips the cluster-formation bootstrap
 * checks a multi-node deployment would otherwise wait on;
 * `xpack.security.enabled=false` disables TLS/auth so the REST API answers
 * plain HTTP with no client-side certificate or credential setup;
 * `ES_JAVA_OPTS=-Xms512m -Xmx512m` sizes the JVM heap down for a test boot.
 *
 * Exposes both the REST API (9200, what `restUrl` wraps) and the transport
 * port (9300, published but not wrapped by any helper here).
 *
 * ### Memory and readiness
 *
 * `withMemoryLimit(2560)` — measured ~1.1 GB resident in a 2.48 GB guest at
 * rest. Readiness is a plain HTTP 200 on `/`, reached in 27s on a quiet
 * local machine; 300s absorbs a loaded CI runner without masking a real
 * hang.
 *
 * **Cluster health never reaches `green` on a single node** — replica
 * shards (Elasticsearch's own default is one replica per index) have
 * nowhere to be assigned, so `/_cluster/health` reports `yellow`
 * indefinitely. A readiness check that waited for `green` would hang until
 * its own timeout; this module deliberately waits on the plain HTTP probe
 * above instead.
 */
export class ElasticsearchContainer extends GenericContainer {
  constructor(image: string | DockerImageName) {
    super(DockerImageName.requireCompatible(image, EXPECTED_REPOSITORY));
    this.withExposedPorts(REST_PORT, TRANSPORT_PORT)
      .withEnv("discovery.type", "single-node")
      .withEnv("xpack.security.enabled", "false")
      .withEnv("ES_JAVA_OPTS", "-Xms512m -Xmx512m")
      .withMemoryLimit(2560)
      .waitingFor(Wait.forHttp("/").forPort(REST_PORT).withStartupTimeout(STARTUP_TIMEOUT_MS));
  }

  /** No default image — see the class doc for why Elasticsearch has no floating tag to fall back to. */
  static override async start(image: string | DockerImageName): Promise<ElasticsearchContainer> {
    return (await new ElasticsearchContainer(image).start()) as ElasticsearchContainer;
  }

  /** The REST API's base URL for the running container. */
  get restUrl(): string {
    return `http://${this.host}:${this.getMappedPort(REST_PORT)}`;
  }
}
