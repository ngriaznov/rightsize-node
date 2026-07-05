import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";

const GUEST_PORT = 5432;

/**
 * A single-node PostgreSQL container. Defaults to a `test`/`test`/`test`
 * user/password/database trio so `connectionString` is usable with zero
 * configuration; call `withUsername`/`withPassword`/`withDatabase` before
 * `start()` to override any of them.
 */
export class PostgresContainer extends GenericContainer {
  private usernameState = "test";
  private passwordState = "test";
  private databaseState = "test";

  constructor(image = "postgres:18-alpine") {
    super(image);
    this.withExposedPorts(GUEST_PORT)
      .withEnv("POSTGRES_USER", this.usernameState)
      .withEnv("POSTGRES_PASSWORD", this.passwordState)
      .withEnv("POSTGRES_DB", this.databaseState)
      // The official postgres:*-alpine image bakes DOCKER_PG_LLVM_DEPS into
      // its manifest with a literal tab character in the value (a
      // package-list built with `\t\t` continuation). msb's krun VMM
      // builder panics with InvalidAscii on that boot-env value before the
      // guest ever starts (reproduced with zero rightsize-set env vars —
      // it's the image, not us). Docker is unaffected. Overriding the var
      // here wins over the image default in both backends' env-merge order
      // and is a no-op for the build the image already baked, so it's a
      // safe, backend-portable fix rather than an msb-only special case.
      .withEnv("DOCKER_PG_LLVM_DEPS", "")
      // The postgres entrypoint starts the server once to run initdb
      // scripts against it, shuts it down, then starts it again for real —
      // printing "database system is ready to accept connections" BOTH
      // times. Waiting for the first occurrence races that restart: a
      // client can connect to the init-time server just before it's torn
      // down. times=2 waits for the second, durable listen.
      .waitingFor(Wait.forLogMessage(".*database system is ready to accept connections.*", 2));
  }

  static override async start(image = "postgres:18-alpine"): Promise<PostgresContainer> {
    return (await new PostgresContainer(image).start()) as PostgresContainer;
  }

  /** Overrides `POSTGRES_USER` (default `test`). */
  withUsername(username: string): this {
    this.usernameState = username;
    return this.withEnv("POSTGRES_USER", username);
  }

  /** Overrides `POSTGRES_PASSWORD` (default `test`). */
  withPassword(password: string): this {
    this.passwordState = password;
    return this.withEnv("POSTGRES_PASSWORD", password);
  }

  /** Overrides `POSTGRES_DB` (default `test`). */
  withDatabase(database: string): this {
    this.databaseState = database;
    return this.withEnv("POSTGRES_DB", database);
  }

  /** The configured database user (default `test`). */
  get username(): string {
    return this.usernameState;
  }

  /** The configured database password (default `test`). */
  get password(): string {
    return this.passwordState;
  }

  /** The configured database name (default `test`). */
  get databaseName(): string {
    return this.databaseState;
  }

  /** A `postgres://` connection string for the running container's `databaseName`. */
  get connectionString(): string {
    return `postgres://${this.usernameState}:${this.passwordState}@${this.host}:${this.getMappedPort(GUEST_PORT)}/${this.databaseState}`;
  }
}
