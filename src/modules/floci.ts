import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";

const AWS_PORT = 4566;
const AZURE_PORT = 4577;
const GCP_PORT = 4588;

/**
 * A [floci.io](https://floci.io) cloud emulator — one native Quarkus image
 * per cloud provider, each speaking that provider's REST APIs against an
 * in-memory backing store. One module type covers all three variants; pick
 * one via the `FlociContainer.aws()`/`.azure()`/`.gcp()` factory functions
 * (there is no bare `new FlociContainer(...)` or `static start()` — each
 * factory pins the provider's own image and guest port, so it's the only
 * entry point) and call `.start()` on the result, e.g. `await
 * FlociContainer.aws().start()`.
 *
 * ### Readiness — `/health` works uniformly, unlike the AWS-flavored `/_localstack/health`
 *
 * All three variants answer a plain `GET /health` with `200` and a small
 * JSON status body the moment the embedded Quarkus HTTP listener is up
 * (verified against real boots of `floci/floci:1.5.30`,
 * `floci/floci-az:0.8.0`, and `floci/floci-gcp:0.4.0`) — pinned as the one
 * wait path that works across all three; no log-wait fallback was needed.
 *
 * ### No signing needed — verified against the AWS variant's S3 surface
 *
 * The AWS variant's S3-shaped REST endpoints accept unsigned requests with
 * no `Authorization` header at all: `PUT /<bucket>` (create-bucket), `PUT
 * /<bucket>/<key>` (put-object), and `GET /<bucket>/<key>` (get-object) all
 * round-trip successfully with a bare HTTP client call — no SigV4, no AWS
 * SDK dependency required.
 *
 * ### Memory — tiny, no ladder needed
 *
 * All three images are native (GraalVM) Quarkus binaries; a real boot
 * settles under 150MiB RSS, and each variant boots and answers `/health`
 * under msb's default microVM RAM with no `withMemoryLimit` override.
 */
export class FlociContainer extends GenericContainer {
  private readonly guestPort: number;

  private constructor(image: string, port: number) {
    super(image);
    this.guestPort = port;
    this.withExposedPorts(port).waitingFor(Wait.forHttp("/health").forPort(port));
  }

  /** The AWS emulator (`floci/floci:1.5.30`), guest port 4566 — S3, DynamoDB, SQS, etc. */
  static aws(image = "floci/floci:1.5.30"): FlociContainer {
    return new FlociContainer(image, AWS_PORT);
  }

  /** The Azure emulator (`floci/floci-az:0.8.0`), guest port 4577. */
  static azure(image = "floci/floci-az:0.8.0"): FlociContainer {
    return new FlociContainer(image, AZURE_PORT);
  }

  /** The GCP emulator (`floci/floci-gcp:0.4.0`), guest port 4588. */
  static gcp(image = "floci/floci-gcp:0.4.0"): FlociContainer {
    return new FlociContainer(image, GCP_PORT);
  }

  /** This variant's REST endpoint — the base URL for every emulated API call. */
  get endpointUrl(): string {
    return `http://${this.host}:${this.getMappedPort(this.guestPort)}`;
  }
}
