# PostgreSQL

A single-node PostgreSQL container. Defaults to a `test`/`test`/`test`
user/password/database trio so `connectionString` is usable with zero
configuration.

**Default image:** `postgres:18-alpine`
**Exposed port:** `5432`
**Wait strategy:** log message `"database system is ready to accept connections"`, **twice**

| Member | Returns |
|---|---|
| `PostgresContainer.start(image?)` | `Promise<PostgresContainer>` — boots the container |
| `.withUsername(name)` | `this` — overrides `POSTGRES_USER` (default `test`) |
| `.withPassword(pw)` | `this` — overrides `POSTGRES_PASSWORD` (default `test`) |
| `.withDatabase(name)` | `this` — overrides `POSTGRES_DB` (default `test`) |
| `.username` / `.password` / `.databaseName` | The configured values |
| `.connectionString` | A `postgres://user:pass@host:port/db` connection string |

## Example

```ts
import { PostgresContainer } from "rightsize/modules";
import pg from "pg";

await using postgres = await PostgresContainer.start();
const client = new pg.Client({ connectionString: postgres.connectionString });
await client.connect();
await client.query("CREATE TABLE t (x INT)");
await client.query("INSERT INTO t VALUES (1)");
console.log((await client.query("SELECT * FROM t")).rows);
await client.end();
```

## Backend notes

- **Why the wait strategy counts to two, not one.** The official entrypoint
  boots the server once to run init scripts, shuts it down, then starts it
  again for real — printing the readiness line both times. Waiting for the
  first occurrence races that restart: a client can connect to the
  init-time server moments before it's torn down. This module's
  `times: 2` wait is the fix, and the reason `Wait.forLogMessage`'s `times`
  parameter exists at all — see [Wait strategies](/guide/wait-strategies).
- **A microsandbox-only environment-variable fix, harmless on Docker.** The
  official `postgres:*-alpine` image bakes an environment variable
  (`DOCKER_PG_LLVM_DEPS`) containing a literal tab character, which crashes
  microsandbox's VM builder before the guest ever boots. This module clears
  that variable by default — invisible on Docker, required on microsandbox.
  Nothing you need to do.
