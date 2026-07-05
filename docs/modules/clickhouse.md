# ClickHouse

A single-node ClickHouse container, ready-checked via `/ping`. Exposes both
the HTTP interface (used by the helpers here) and the native protocol port,
for consumers that want a native-protocol client instead.

**Default image:** `clickhouse/clickhouse-server:25.8`
**Exposed ports:** `8123` (HTTP), `9000` (native protocol)
**Wait strategy:** `Wait.forHttp("/ping").forPort(8123)`

| Member | Returns |
|---|---|
| `ClickHouseContainer.start(image?)` | `Promise<ClickHouseContainer>` — boots the container |
| `.withUsername(name)` | `this` — overrides `CLICKHOUSE_USER` (default `test`) |
| `.withPassword(pw)` | `this` — overrides `CLICKHOUSE_PASSWORD` (default `test`) |
| `.withDatabase(name)` | `this` — overrides `CLICKHOUSE_DB` (default `test`) |
| `.username` / `.password` / `.databaseName` | The configured values |
| `.httpUrl` | The HTTP interface's base URL |

## Example

```ts
import { ClickHouseContainer } from "rightsize/modules";

await using clickhouse = await ClickHouseContainer.start();
const auth = Buffer.from(`${clickhouse.username}:${clickhouse.password}`).toString("base64");
const headers = { Authorization: `Basic ${auth}` };

await fetch(clickhouse.httpUrl, { method: "POST", headers, body: "CREATE TABLE t (x Int32) ENGINE=Memory" });
await fetch(clickhouse.httpUrl, { method: "POST", headers, body: "INSERT INTO t VALUES (1)" });
console.log(await (await fetch(clickhouse.httpUrl, { method: "POST", headers, body: "SELECT * FROM t" })).text());
```

## Backend notes

Once `CLICKHOUSE_USER`/`CLICKHOUSE_PASSWORD`/`CLICKHOUSE_DB` are set (this
module sets all three by default), the image's default unauthenticated
`default` user no longer has its usual passwordless access — every query
needs the configured credentials, as in the example above. No memory-limit
override is needed; ClickHouse's default footprint (measured around 524MB
resident) fits comfortably under microsandbox's default microVM sizing.
