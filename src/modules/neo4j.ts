import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";

const HTTP_PORT = 7474;
const BOLT_PORT = 7687;
const DEFAULT_PASSWORD = "rightsize-test";

/**
 * A single-node Neo4j Community container, queried over its HTTP Cypher
 * transaction endpoint (`/db/neo4j/tx/commit`) — no bolt driver dependency
 * needed, matching this library's HTTP-first module convention
 * (`ClickHouseContainer`, `PinotContainer`). The bolt port (7687) is still
 * exposed and its URI available via `boltUrl` for callers who do want a
 * real driver.
 *
 * Defaults to a `neo4j`/`rightsize-test` username/password pair (the image
 * refuses passwords under 8 characters — `neo4j`/`neo4j` is rejected at
 * boot) so `httpUrl` plus basic auth is usable with zero configuration;
 * call `withPassword` before `start()` to override it. The username is
 * fixed by the image at `neo4j` — there is no env var to change it.
 *
 * ### Readiness — `Started.` is the exact log line, verified against a real boot
 *
 * Captured verbatim from `neo4j:5-community`:
 *
 * ```
 * ... INFO  Bolt enabled on 0.0.0.0:7687.
 * ... INFO  HTTP enabled on 0.0.0.0:7474.
 * ... INFO  Remote interface available at http://localhost:7474/
 * ... INFO  Started.
 * ```
 *
 * `Started.` is logged only after both connectors are already listening, so
 * it's both accurate and simpler than a two-port HTTP/bolt race. The dot in
 * the regex is deliberately ESCAPED (`Started\\.`) — an unescaped dot would
 * also match the literal character it's meant to require, but escaping is
 * the correct contract for a real regex engine (`.` otherwise matches any
 * character, not just itself).
 *
 * ### Memory — measured, needed the ladder
 *
 * At msb's default ~450MB microVM RAM, the server logs `Invalid memory
 * configuration - exceeds physical memory` and shuts itself down cleanly
 * (`Stopped.`) rather than hanging or getting OOM-killed — Neo4j's own
 * memory-recommendation calculator sizes the page cache and heap off total
 * visible RAM and refuses to start if the sums don't fit. A real boot with
 * no memory cap sits at ~430MiB RSS, just over that default budget.
 * `withMemoryLimit(1024)` is this module's default (verified: boots clean,
 * the HTTP Cypher endpoint answers well within the startup timeout).
 */
export class Neo4jContainer extends GenericContainer {
  private passwordState = DEFAULT_PASSWORD;

  constructor(image = "neo4j:5-community") {
    super(image);
    this.withExposedPorts(HTTP_PORT, BOLT_PORT)
      .withEnv("NEO4J_AUTH", `neo4j/${this.passwordState}`)
      .withMemoryLimit(1024)
      .waitingFor(Wait.forLogMessage(".*Started\\..*", 1).withStartupTimeout(120_000));
  }

  static override async start(image = "neo4j:5-community"): Promise<Neo4jContainer> {
    return (await new Neo4jContainer(image).start()) as Neo4jContainer;
  }

  /** Overrides `NEO4J_AUTH`'s password half (default `rightsize-test`; the image requires at least 8 characters). */
  withPassword(password: string): this {
    this.passwordState = password;
    return this.withEnv("NEO4J_AUTH", `neo4j/${password}`);
  }

  /** The fixed admin username (`neo4j` — the image has no env var to change it). */
  get username(): string {
    return "neo4j";
  }

  /** The configured admin password (default `rightsize-test`). */
  get password(): string {
    return this.passwordState;
  }

  /** The HTTP interface's base URL (Cypher transactions via `POST {httpUrl}/db/neo4j/tx/commit`). */
  get httpUrl(): string {
    return `http://${this.host}:${this.getMappedPort(HTTP_PORT)}`;
  }

  /** The bolt interface's URI, for callers using a real bolt driver instead of the HTTP helpers. */
  get boltUrl(): string {
    return `bolt://${this.host}:${this.getMappedPort(BOLT_PORT)}`;
  }
}
