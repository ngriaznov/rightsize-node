import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";

const GUEST_PORT = 3306;

/**
 * A single-node MariaDB container. Defaults to a `test`/`test`/`test`
 * user/password/database trio (plus `MARIADB_ROOT_PASSWORD=test`), mirroring
 * `MySQLContainer`'s builder shape; call `withUsername`/`withPassword`/
 * `withDatabase` before `start()` to override any of them. MariaDB speaks
 * the MySQL wire protocol, so `connectionString` uses the same `mysql://`
 * scheme and any MySQL client (e.g. `mysql2`) works against it unmodified.
 *
 * ### Readiness — empirically pinned, following MySQL's precedent exactly
 *
 * Like MySQL 8.4, the official entrypoint boots mariadbd TWICE (a throwaway
 * "temp server" for init scripts, then for real). The wait anchors on the
 * real server's `Version:` line, which carries `port: 3306` and the
 * `mariadb.org binary distribution` marker together, on the same line. The
 * temp-server boot prints the same line shape but with `port: 0` (no port
 * bound yet), so it can never false-match. Captured verbatim from a real
 * `docker run mariadb:11.4` boot with this module's env:
 *
 * ```
 * ...
 * [Note] mariadbd: ready for connections.
 * Version: '11.4.12-MariaDB-ubu2404'  socket: '...'  port: 0  mariadb.org binary distribution
 * ...(init scripts run, temp server shuts down)...
 * [Note] Server socket created on IP: '0.0.0.0', port: '3306'.
 * [Note] Server socket created on IP: '::', port: '3306'.
 * [Note] mariadbd: ready for connections.
 * Version: '11.4.12-MariaDB-ubu2404'  socket: '...'  port: 3306  mariadb.org binary distribution
 * ```
 *
 * `.*port: 3306.*mariadb\.org binary distribution.*` with `times=1` matches
 * only the last line above — the temp server's equivalent line has `port: 0`
 * instead of `port: 3306`, so it never satisfies the pattern.
 */
export class MariaDBContainer extends GenericContainer {
  private usernameState = "test";
  private passwordState = "test";
  private databaseState = "test";

  constructor(image = "mariadb:11.4") {
    super(image);
    this.withExposedPorts(GUEST_PORT)
      .withEnv("MARIADB_USER", this.usernameState)
      .withEnv("MARIADB_PASSWORD", this.passwordState)
      .withEnv("MARIADB_DATABASE", this.databaseState)
      .withEnv("MARIADB_ROOT_PASSWORD", "test")
      // Anchored on the real server's line (see the class doc for the
      // captured log excerpt).
      .waitingFor(Wait.forLogMessage(".*port: 3306.*mariadb\\.org binary distribution.*", 1));
    // No withMemoryLimit override, matching the MySQL precedent: MariaDB's
    // InnoDB default footprint fits msb's default microVM RAM comfortably.
  }

  static override async start(image = "mariadb:11.4"): Promise<MariaDBContainer> {
    return (await new MariaDBContainer(image).start()) as MariaDBContainer;
  }

  /** Overrides `MARIADB_USER` (default `test`). */
  withUsername(username: string): this {
    this.usernameState = username;
    return this.withEnv("MARIADB_USER", username);
  }

  /** Overrides `MARIADB_PASSWORD` (default `test`). */
  withPassword(password: string): this {
    this.passwordState = password;
    return this.withEnv("MARIADB_PASSWORD", password);
  }

  /** Overrides `MARIADB_DATABASE` (default `test`). */
  withDatabase(database: string): this {
    this.databaseState = database;
    return this.withEnv("MARIADB_DATABASE", database);
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

  /** A `mysql://` connection string (MariaDB speaks the MySQL wire protocol) for the running container's `databaseName`. */
  get connectionString(): string {
    return `mysql://${this.usernameState}:${this.passwordState}@${this.host}:${this.getMappedPort(GUEST_PORT)}/${this.databaseState}`;
  }
}
