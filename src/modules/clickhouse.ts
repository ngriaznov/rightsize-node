import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";

const HTTP_PORT = 8123;
const NATIVE_PORT = 9000;

/**
 * A single-node ClickHouse container, ready-checked via `/ping` (returns
 * the literal body `Ok.` on 200 — `Wait.forHttp`'s status-code check is all
 * that's needed here). Exposes both the HTTP interface (8123, what the
 * helpers here use) and the native protocol port (9000) for consumers that
 * want a native-protocol client instead.
 *
 * `CLICKHOUSE_USER`/`CLICKHOUSE_PASSWORD`/`CLICKHOUSE_DB` (verified against
 * the entrypoint's own logging: `create new user 'test' instead 'default'`,
 * `create database 'test'`) replace the image's default `default` user
 * entirely — once set, the unauthenticated `default` user's usual
 * passwordless access is gone, and every query needs the configured
 * credentials.
 */
export class ClickHouseContainer extends GenericContainer {
  private usernameState = "test";
  private passwordState = "test";
  private databaseState = "test";

  constructor(image = "clickhouse/clickhouse-server:25.8") {
    super(image);
    this.withExposedPorts(HTTP_PORT, NATIVE_PORT)
      .withEnv("CLICKHOUSE_USER", this.usernameState)
      .withEnv("CLICKHOUSE_PASSWORD", this.passwordState)
      .withEnv("CLICKHOUSE_DB", this.databaseState)
      .waitingFor(Wait.forHttp("/ping").forPort(HTTP_PORT));
    // No withMemoryLimit override: measured ~524MB resident at rest well
    // under msb's default ~450MB-and-up microVM sizing headroom in
    // practice (verified booting and answering /ping on msb's default).
  }

  static override async start(image = "clickhouse/clickhouse-server:25.8"): Promise<ClickHouseContainer> {
    return (await new ClickHouseContainer(image).start()) as ClickHouseContainer;
  }

  /** Overrides `CLICKHOUSE_USER` (default `test`). */
  withUsername(username: string): this {
    this.usernameState = username;
    return this.withEnv("CLICKHOUSE_USER", username);
  }

  /** Overrides `CLICKHOUSE_PASSWORD` (default `test`). */
  withPassword(password: string): this {
    this.passwordState = password;
    return this.withEnv("CLICKHOUSE_PASSWORD", password);
  }

  /** Overrides `CLICKHOUSE_DB` (default `test`). */
  withDatabase(database: string): this {
    this.databaseState = database;
    return this.withEnv("CLICKHOUSE_DB", database);
  }

  /** The configured user (default `test`). */
  get username(): string {
    return this.usernameState;
  }

  /** The configured password (default `test`). */
  get password(): string {
    return this.passwordState;
  }

  /** The configured database name (default `test`). */
  get databaseName(): string {
    return this.databaseState;
  }

  /** The HTTP interface's base URL for the running container. */
  get httpUrl(): string {
    return `http://${this.host}:${this.getMappedPort(HTTP_PORT)}`;
  }
}
