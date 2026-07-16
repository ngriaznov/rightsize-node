import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";

const HTTP_PORT = 8080;
const MANAGEMENT_PORT = 9000;
const STARTUP_TIMEOUT_MS = 180_000;

/**
 * A single-node Keycloak container started with `start-dev` (an
 * in-memory/dev-mode boot — no external database wiring needed for tests).
 *
 * Two pins here are version-sensitive and were verified against 26.0.8
 * specifically:
 *
 * - **Env var names**: 26.x renamed the bootstrap-admin variables to
 *   `KC_BOOTSTRAP_ADMIN_USERNAME`/`KC_BOOTSTRAP_ADMIN_PASSWORD` (older
 *   releases used `KEYCLOAK_ADMIN`/`KEYCLOAK_ADMIN_PASSWORD`, which 26.x
 *   does not recognize). Confirmed by the boot log: `KC-SERVICES0077:
 *   Created temporary admin user with username admin`.
 * - **Health lives on the management port, not the app port.** 26.x splits
 *   HTTP (8080) from a separate management interface (9000, confirmed by
 *   the boot log: "Management interface listening on http://0.0.0.0:9000")
 *   that serves `/health/ready`; `KC_HEALTH_ENABLED=true` is required for
 *   that endpoint to exist at all.
 *
 * A four-JVM-adjacent Quarkus boot (Keycloak on Quarkus, with Infinispan +
 * an embedded H2) fits comfortably in `withMemoryLimit(1024)` (measured
 * ~55% utilization at rest) — set by default here.
 */
export class KeycloakContainer extends GenericContainer {
  private adminUsernameState = "admin";
  private adminPasswordState = "admin";

  constructor(image = "quay.io/keycloak/keycloak:26.0") {
    super(image);
    this.withExposedPorts(HTTP_PORT, MANAGEMENT_PORT)
      .withCommand("start-dev")
      .withEnv("KC_BOOTSTRAP_ADMIN_USERNAME", this.adminUsernameState)
      .withEnv("KC_BOOTSTRAP_ADMIN_PASSWORD", this.adminPasswordState)
      .withEnv("KC_HEALTH_ENABLED", "true")
      .withMemoryLimit(1024)
      .waitingFor(Wait.forHttp("/health/ready").forPort(MANAGEMENT_PORT).withStartupTimeout(STARTUP_TIMEOUT_MS));
  }

  static override async start(image = "quay.io/keycloak/keycloak:26.0"): Promise<KeycloakContainer> {
    return (await new KeycloakContainer(image).start()) as KeycloakContainer;
  }

  /** Overrides `KC_BOOTSTRAP_ADMIN_USERNAME` (default `admin`). */
  withAdminUsername(username: string): this {
    this.adminUsernameState = username;
    return this.withEnv("KC_BOOTSTRAP_ADMIN_USERNAME", username);
  }

  /** Overrides `KC_BOOTSTRAP_ADMIN_PASSWORD` (default `admin`). */
  withAdminPassword(password: string): this {
    this.adminPasswordState = password;
    return this.withEnv("KC_BOOTSTRAP_ADMIN_PASSWORD", password);
  }

  /** The configured bootstrap admin username (default `admin`). */
  get adminUsername(): string {
    return this.adminUsernameState;
  }

  /** The configured bootstrap admin password (default `admin`). */
  get adminPassword(): string {
    return this.adminPasswordState;
  }

  /** The auth server's base URL (the app HTTP port, 8080). */
  get authServerUrl(): string {
    return `http://${this.host}:${this.getMappedPort(HTTP_PORT)}`;
  }
}
