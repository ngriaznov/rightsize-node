import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";

const AMQP_PORT = 5672;
const MANAGEMENT_PORT = 15672;

/**
 * A single-node RabbitMQ container with the management plugin enabled.
 * Defaults to the image's own `guest`/`guest` credentials; call
 * `withUsername`/`withPassword` before `start()` to override either (sets
 * `RABBITMQ_DEFAULT_USER`/`RABBITMQ_DEFAULT_PASS`).
 *
 * Readiness waits on the boot log line captured from a real
 * `rabbitmq:4-management-alpine` run: `Server startup complete; N plugins
 * started.` — NOT the shorter "Server startup complete" alone some older
 * 3.x docs quote, since 4.x always appends the plugin-count clause on the
 * same line. The wait regex (`.*Server startup complete.*`) only matches the
 * stable "Server startup complete" substring anywhere on the line, so the
 * trailing plugin-count clause — which varies by which plugins are
 * enabled — never has to match exactly. The management HTTP API's own
 * `/api/health/checks/...` endpoints require authenticated requests to
 * probe, which would need this module to bake in an HTTP+auth wait
 * strategy just to watch a JVM-style health check that AMQP's own boot log
 * already answers for free — the log wait is simpler and exercises exactly
 * the readiness rightsize's Wait strategies are for.
 *
 * RabbitMQ 4.x behavior note (not this module's concern to fix, but the
 * reason the IT declares durable/exclusive queues): 4.x rejects declaring a
 * transient (non-durable), non-exclusive queue — a behavior change from
 * 3.x. Consumers of this container must declare durable or exclusive
 * queues; a transient shared queue now errors at declare time.
 */
export class RabbitMQContainer extends GenericContainer {
  private usernameState = "guest";
  private passwordState = "guest";

  constructor(image = "rabbitmq:4-management-alpine") {
    super(image);
    this.withExposedPorts(AMQP_PORT, MANAGEMENT_PORT).waitingFor(
      Wait.forLogMessage(".*Server startup complete.*"),
    );
  }

  static override async start(image = "rabbitmq:4-management-alpine"): Promise<RabbitMQContainer> {
    return (await new RabbitMQContainer(image).start()) as RabbitMQContainer;
  }

  /** Overrides `RABBITMQ_DEFAULT_USER` (default `guest`). */
  withUsername(username: string): this {
    this.usernameState = username;
    return this.withEnv("RABBITMQ_DEFAULT_USER", username);
  }

  /** Overrides `RABBITMQ_DEFAULT_PASS` (default `guest`). */
  withPassword(password: string): this {
    this.passwordState = password;
    return this.withEnv("RABBITMQ_DEFAULT_PASS", password);
  }

  /** The configured AMQP username (default `guest`). */
  get username(): string {
    return this.usernameState;
  }

  /** The configured AMQP password (default `guest`). */
  get password(): string {
    return this.passwordState;
  }

  /** An `amqp://` connection URL for the running broker. */
  get amqpUrl(): string {
    return `amqp://${this.usernameState}:${this.passwordState}@${this.host}:${this.getMappedPort(AMQP_PORT)}`;
  }

  /** The management HTTP API's base URL for the running broker. */
  get managementUrl(): string {
    return `http://${this.host}:${this.getMappedPort(MANAGEMENT_PORT)}`;
  }
}
