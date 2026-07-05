import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";

const GUEST_PORT = 3306;

/**
 * A single-node MySQL container. Defaults to a `test`/`test`/`test`
 * user/password/database trio (plus `MYSQL_ROOT_PASSWORD=test`) so
 * `connectionString` is usable with zero configuration; call
 * `withUsername`/`withPassword`/`withDatabase` before `start()` to override
 * any of them.
 *
 * ### Readiness — empirically pinned, not guessed
 *
 * The official entrypoint boots mysqld TWICE: once as a throwaway "temp
 * server" to run init scripts, then for real. Both prints, plus the X
 * Plugin's own "ready for connections" line, contain the substring `ready
 * for connections`, and naively counting occurrences is a trap: the temp
 * server's X Plugin binds `port: 33060` — whose digits start with `3306`,
 * so an unanchored `port: 3306` regex false-matches it too. Captured
 * verbatim from a real `docker run mysql:8.4` boot with this module's env
 * (`MYSQL_USER=test`, `MYSQL_DATABASE=test`, `MYSQL_ROOT_PASSWORD=test`):
 *
 * ```
 * ...
 * [System] [MY-011323] [Server] X Plugin ready for connections. Socket: /var/run/mysqld/mysqlx.sock
 * [System] [MY-010931] [Server] /usr/sbin/mysqld: ready for connections. Version: '8.4.10'  socket: '/var/run/mysqld/mysqld.sock'  port: 0  MySQL Community Server - GPL.
 * ...(init scripts run, temp server shuts down)...
 * [System] [MY-011323] [Server] X Plugin ready for connections. Bind-address: '::' port: 33060, socket: /var/run/mysqld/mysqlx.sock
 * [System] [MY-010931] [Server] /usr/sbin/mysqld: ready for connections. Version: '8.4.10'  socket: '/var/run/mysqld/mysqld.sock'  port: 3306  MySQL Community Server - GPL.
 * ```
 *
 * Four lines contain `ready for connections`; only the last is the real
 * server bound to 3306. The temp server prints `port: 0` (no port yet) and
 * the X Plugin lines print `33060`, whose `3306` prefix would satisfy an
 * unanchored match — so `times=N` counting is fragile here (N would have to
 * track exactly which of the 4 lines are "real", and a naive `times=2`
 * fires on the temp server's own X-Plugin + mysqld pair, one full boot
 * early). Instead this pins a regex anchored on the real server's `port:
 * 3306` with a trailing non-digit-or-end boundary, so it cannot match
 * `33060`, and `times=1` is then unambiguous (that exact line appears once,
 * only after the real server is up).
 */
export class MySQLContainer extends GenericContainer {
  private usernameState = "test";
  private passwordState = "test";
  private databaseState = "test";

  constructor(image = "mysql:8.4") {
    super(image);
    this.withExposedPorts(GUEST_PORT)
      .withEnv("MYSQL_USER", this.usernameState)
      .withEnv("MYSQL_PASSWORD", this.passwordState)
      .withEnv("MYSQL_DATABASE", this.databaseState)
      .withEnv("MYSQL_ROOT_PASSWORD", "test")
      // Anchored on the real server's line (see the class doc for the
      // captured log excerpt and why an unanchored "port: 3306" or a naive
      // times=2 both misfire on the temp-server boot).
      .waitingFor(Wait.forLogMessage(".*mysqld: ready for connections.*port: 3306($|[^0-9]).*", 1));
    // No withMemoryLimit override: boots clean on msb's default ~450M
    // microVM RAM well under 60s — unlike SpringCloudConfig's Paketo JVM
    // image, MySQL 8.4's InnoDB default footprint fits the default, so no
    // module-level memory floor is warranted here.
  }

  static override async start(image = "mysql:8.4"): Promise<MySQLContainer> {
    return (await new MySQLContainer(image).start()) as MySQLContainer;
  }

  /** Overrides `MYSQL_USER` (default `test`). */
  withUsername(username: string): this {
    this.usernameState = username;
    return this.withEnv("MYSQL_USER", username);
  }

  /** Overrides `MYSQL_PASSWORD` (default `test`). */
  withPassword(password: string): this {
    this.passwordState = password;
    return this.withEnv("MYSQL_PASSWORD", password);
  }

  /** Overrides `MYSQL_DATABASE` (default `test`). */
  withDatabase(database: string): this {
    this.databaseState = database;
    return this.withEnv("MYSQL_DATABASE", database);
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

  /** A `mysql://` connection string for the running container's `databaseName`. */
  get connectionString(): string {
    return `mysql://${this.usernameState}:${this.passwordState}@${this.host}:${this.getMappedPort(GUEST_PORT)}/${this.databaseState}`;
  }
}
