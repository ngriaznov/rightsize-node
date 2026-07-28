import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";
import { DockerImageName } from "../core/docker-image-name.js";

const REST_PORT = 6333;
const GRPC_PORT = 6334;
const EXPECTED_REPOSITORY = "qdrant/qdrant";
const DEFAULT_IMAGE = "qdrant/qdrant:latest";

/**
 * A single-node Qdrant container — a vector search engine.
 *
 * No-arg construction floats to `qdrant/qdrant:latest`, so the version
 * tracks upstream rather than this library's release cycle (verified
 * against `qdrant/qdrant:v1.18.3`, arm64 — note the image's tags carry a
 * leading `v`, unlike most catalog images here).
 *
 * Exposes both the REST API (6333, what `restUrl` wraps) and the gRPC port
 * (6334, published but not wrapped by any helper here).
 *
 * Readiness is a plain HTTP 200 on `/readyz`, answered on the very first
 * poll in the verified boot — no long startup timeout override is needed.
 * No `withMemoryLimit` override either: a full create-collection/upsert/
 * search round-trip was verified with no memory limit set, in a guest
 * reporting ~480 MB total.
 */
export class QdrantContainer extends GenericContainer {
  constructor(image: string | DockerImageName = DEFAULT_IMAGE) {
    super(DockerImageName.requireCompatible(image, EXPECTED_REPOSITORY));
    this.withExposedPorts(REST_PORT, GRPC_PORT).waitingFor(Wait.forHttp("/readyz").forPort(REST_PORT));
  }

  static override async start(image: string | DockerImageName = DEFAULT_IMAGE): Promise<QdrantContainer> {
    return (await new QdrantContainer(image).start()) as QdrantContainer;
  }

  /** The REST API's base URL for the running container. */
  get restUrl(): string {
    return `http://${this.host}:${this.getMappedPort(REST_PORT)}`;
  }
}
