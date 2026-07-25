import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";

const API_PORT = 9000;
const CONSOLE_PORT = 9001;

/**
 * A single-node MinIO container — an S3-compatible object store. Requires
 * an explicit command: the image's default ENTRYPOINT alone does not serve,
 * so this module always runs `server /data --console-address :9001`.
 *
 * `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` default to `testuser`/
 * `testpassword`, not this library's usual `test`/`test` pair — MinIO
 * itself rejects a root password shorter than 8 characters, so `test` (4
 * characters) is a non-starter here.
 *
 * Exposes both the S3 API (9000, what `endpointUrl` wraps) and the web
 * console (9001, published for anyone who wants to open it directly; no
 * helper wraps it).
 *
 * Readiness is a protocol-aware HTTP check against `/minio/health/live` on
 * the API port — verified answering 200 on the very first poll after boot.
 */
export class MinIOContainer extends GenericContainer {
  private rootUserState = "testuser";
  private rootPasswordState = "testpassword";

  constructor(image = "minio/minio:RELEASE.2025-09-07T16-13-09Z") {
    super(image);
    this.withExposedPorts(API_PORT, CONSOLE_PORT)
      .withCommand("server", "/data", "--console-address", ":9001")
      .withEnv("MINIO_ROOT_USER", this.rootUserState)
      .withEnv("MINIO_ROOT_PASSWORD", this.rootPasswordState)
      .waitingFor(Wait.forHttp("/minio/health/live").forPort(API_PORT));
    // No withMemoryLimit override: the round-trip that verified this module
    // ran at 1024 MB, but whether MinIO actually needs more than msb's
    // default microVM sizing was never isolated in that pass — a floor
    // belongs here once that's measured on its own, not assumed from a
    // number that included the whole round-trip's overhead.
  }

  static override async start(image = "minio/minio:RELEASE.2025-09-07T16-13-09Z"): Promise<MinIOContainer> {
    return (await new MinIOContainer(image).start()) as MinIOContainer;
  }

  /** Overrides `MINIO_ROOT_USER` (default `testuser`). */
  withRootUser(user: string): this {
    this.rootUserState = user;
    return this.withEnv("MINIO_ROOT_USER", user);
  }

  /** Overrides `MINIO_ROOT_PASSWORD` (default `testpassword`). MinIO rejects anything shorter than 8 characters. */
  withRootPassword(password: string): this {
    this.rootPasswordState = password;
    return this.withEnv("MINIO_ROOT_PASSWORD", password);
  }

  /** The configured root user (default `testuser`). */
  get rootUser(): string {
    return this.rootUserState;
  }

  /** The configured root password (default `testpassword`). */
  get rootPassword(): string {
    return this.rootPasswordState;
  }

  /** The S3 API's base URL for the running container. */
  get endpointUrl(): string {
    return `http://${this.host}:${this.getMappedPort(API_PORT)}`;
  }
}
