# MariaDB

A single-node MariaDB container, mirroring [MySQL](/modules/mysql)'s builder
shape. MariaDB speaks the MySQL wire protocol, so `connectionString` uses the
same `mysql://` scheme and any MySQL client works against it unmodified.

**Default image:** `mariadb:11.4`
**Exposed port:** `3306`
**Wait strategy:** an anchored log-message regex, following MySQL's precedent

| Member | Returns |
|---|---|
| `MariaDBContainer.start(image?)` | `Promise<MariaDBContainer>` — boots the container |
| `.withUsername(name)` | `this` — overrides `MARIADB_USER` (default `test`) |
| `.withPassword(pw)` | `this` — overrides `MARIADB_PASSWORD` (default `test`) |
| `.withDatabase(name)` | `this` — overrides `MARIADB_DATABASE` (default `test`) |
| `.username` / `.password` / `.databaseName` | The configured values |
| `.connectionString` | A `mysql://user:pass@host:port/db` connection string (MariaDB speaks the MySQL wire protocol) |

## Example

```ts
import { MariaDBContainer } from "rightsize/modules";
import mysql from "mysql2/promise";

await using mariadb = await MariaDBContainer.start();
const conn = await mysql.createConnection(mariadb.connectionString);
await conn.query("CREATE TABLE t (x INT)");
await conn.query("INSERT INTO t VALUES (1)");
console.log((await conn.query("SELECT * FROM t"))[0]);
await conn.end();
```

## Backend notes

Like MySQL, MariaDB's entrypoint boots the server twice (a throwaway "temp
server" for init scripts, then for real), and this module's wait regex is
anchored on the real server's line shape for the same reason MySQL's is —
see [the MySQL module page](/modules/mysql#backend-notes) for the full
explanation. No memory-limit override is needed; MariaDB's default footprint
fits microsandbox's default microVM RAM comfortably.
