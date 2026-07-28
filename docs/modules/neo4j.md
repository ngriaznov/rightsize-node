# Neo4j

A single-node Neo4j Community container, queried over its HTTP Cypher
transaction endpoint — no bolt driver dependency needed, matching this
library's HTTP-first module convention ([ClickHouse](/modules/clickhouse),
[Pinot](/modules/pinot)). The bolt port is still exposed and its URI
available for callers who do want a real driver.

**Default image:** `neo4j:latest`
**Exposed ports:** `7474` (HTTP), `7687` (bolt)
**Wait strategy:** log message `"Started\\."`, 120s startup timeout
**Memory:** `withMemoryLimit(1024)` by default

| Member | Returns |
|---|---|
| `Neo4jContainer.start(image?)` | `Promise<Neo4jContainer>` — boots the container |
| `.withPassword(pw)` | `this` — overrides the password (default `rightsize-test`; the image requires at least 8 characters) |
| `.username` | The fixed admin username (`neo4j` — the image has no env var to change it) |
| `.password` | The configured password |
| `.httpUrl` | The HTTP interface's base URL (Cypher transactions via `POST {httpUrl}/db/neo4j/tx/commit`) |
| `.boltUrl` | The bolt interface's URI, for a real bolt driver |

## Example

```ts
import { Neo4jContainer } from "rightsize/modules";

await using neo4j = await Neo4jContainer.start();
const auth = Buffer.from(`${neo4j.username}:${neo4j.password}`).toString("base64");

const res = await fetch(`${neo4j.httpUrl}/db/neo4j/tx/commit`, {
  method: "POST",
  headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
  body: JSON.stringify({ statements: [{ statement: "CREATE (n:Test {x: 1}) RETURN n.x" }] }),
});
console.log(await res.json());
```

## Backend notes

- **No-arg construction floats to `neo4j:latest`.** Verified against
  `neo4j:5-community`, including every fact on this page.
- **Compatibility check:** the constructor only accepts images whose
  repository is `neo4j` (registry host, tag, and digest stripped). A
  different repository throws `IncompatibleImageError` before any backend
  call; override with
  `DockerImageName.parse(image).asCompatibleSubstituteFor("neo4j")` for a
  verified compatible fork or mirror.
- **The image refuses passwords under 8 characters** — `neo4j`/`neo4j` is
  rejected at boot. This module's default password (`rightsize-test`) is
  already 8+ characters; if you override it with `withPassword`, keep that
  minimum in mind.
- **The 1024MB memory floor is required on microsandbox, not optional.** At
  microsandbox's default ~450MB microVM RAM, Neo4j's own memory-recommendation
  calculator refuses to start at all (`Invalid memory configuration - exceeds
  physical memory`), shutting down cleanly rather than hanging or getting
  OOM-killed. A real boot with no memory cap sits around 430MiB RSS, just
  over that default budget — `withMemoryLimit(1024)` (set by this module by
  default) gives it comfortable room.
