# MySQL

A single-node MySQL container. Defaults to a `test`/`test`/`test`
user/password/database trio (plus a `test` root password) so
`connectionString` is usable with zero configuration.

**Default image:** `mysql:8.4`
**Exposed port:** `3306`
**Wait strategy:** an anchored log-message regex — see below

| Member | Returns |
|---|---|
| `MySQLContainer.start(image?)` | `Promise<MySQLContainer>` — boots the container |
| `.withUsername(name)` | `this` — overrides `MYSQL_USER` (default `test`) |
| `.withPassword(pw)` | `this` — overrides `MYSQL_PASSWORD` (default `test`) |
| `.withDatabase(name)` | `this` — overrides `MYSQL_DATABASE` (default `test`) |
| `.username` / `.password` / `.databaseName` | The configured values |
| `.connectionString` | A `mysql://user:pass@host:port/db` connection string |

## Example

```ts
import { MySQLContainer } from "rightsize/modules";
import mysql from "mysql2/promise";

await using mysqlContainer = await MySQLContainer.start();
const conn = await mysql.createConnection(mysqlContainer.connectionString);
await conn.query("CREATE TABLE t (x INT)");
await conn.query("INSERT INTO t VALUES (1)");
console.log((await conn.query("SELECT * FROM t"))[0]);
await conn.end();
```

## Backend notes

**Why the wait regex is anchored, not a naive substring match.** MySQL's
entrypoint boots `mysqld` twice — once as a throwaway "temp server" to run
init scripts, then for real — and both boots, plus the X Plugin's own
startup line, all contain the substring `"ready for connections"`. Worse,
the temp server's X Plugin binds port `33060`, whose digits start with
`3306`, so an unanchored `"port: 3306"` pattern would false-match it too.
This module's wait pattern is anchored on the real server's exact line shape
(`port: 3306` followed by a non-digit or end-of-line), captured and verified
against a real boot rather than guessed — see the module's source comment
for the captured log excerpt if you're writing a similar wait for your own
image.
