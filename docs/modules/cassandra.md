# Cassandra

A single-node Cassandra container.

**Default image:** `cassandra:latest`
**Exposed port:** `9042`
**Wait strategy:** `Wait.forLogMessage(".*Starting listening for CQL clients.*", 1)`, 300s startup timeout
**Memory:** `withMemoryLimit(2560)`, alongside a heap sized down with
`MAX_HEAP_SIZE=512M`/`HEAP_NEWSIZE=128M`

| Member | Returns |
|---|---|
| `CassandraContainer.start(image?)` | `Promise<CassandraContainer>` — boots the container |
| `.contactPoint` | `host:port` — the shape most CQL drivers want for a contact point |
| `.cqlPort` | The mapped CQL native-transport port |
| `.localDatacenter` | This single node's local datacenter name (`datacenter1`) |

## Example

```ts
import { CassandraContainer } from "rightsize/modules";

await using cassandra = await CassandraContainer.start();

// The image ships `cqlsh` — no Cassandra driver needed for this round-trip.
await cassandra.exec(
  "cqlsh",
  "-e",
  "CREATE KEYSPACE example WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};" +
    "CREATE TABLE example.t (id int PRIMARY KEY, x text);" +
    "INSERT INTO example.t (id, x) VALUES (1, 'hello');",
);
const result = await cassandra.exec("cqlsh", "-e", "SELECT x FROM example.t WHERE id = 1;");
console.log(result.stdout); // contains "hello"
```

## Backend notes

- **No-arg construction floats to `cassandra:latest`.** Verified against
  `cassandra:5.0.8`, including every fact on this page. The `GPG_KEYS`
  override below stays unconditional under the floating default too — a
  no-op against a build that never baked the problem tab, required against
  one that does.
- **Compatibility check:** the constructor only accepts images whose
  repository is `cassandra` (registry host, tag, and digest stripped). A
  different repository throws `IncompatibleImageError` before any backend
  call; override with
  `DockerImageName.parse(image).asCompatibleSubstituteFor("cassandra")` for a
  verified compatible fork or mirror.
- **`GPG_KEYS` must be overridden — this is the difference between booting
  and aborting.** `cassandra:5.0.8`'s baked-in `GPG_KEYS` build arg contains
  a literal TAB character, and msb 0.6.6 panics on any image whose baked env
  contains one, before the guest even boots:

  ```
  sandbox process exited (signal: 6 (SIGABRT)) before agent relay became available
  ```

  with `msb logs --source system` showing:

  ```
  panicked at msb_krun_vmm-0.1.25/src/builder.rs:1154: ... Err value: InvalidAscii
  ```

  `GPG_KEYS` is consumed only at image-build time (verifying the signing
  keys baked into that layer), so overriding it to an empty, tab-free string
  has no effect on the running container — this module sets it unconditionally.
- **Heap is sized down on purpose.** `MAX_HEAP_SIZE=512M`/`HEAP_NEWSIZE=128M`
  keep the JVM small; `2560` MB is the verified memory ceiling at that heap
  size.
- **300s startup timeout is generous on purpose.** The CQL native-transport
  log line was observed at 58s on a quiet local machine; Cassandra is
  heavier than either [Keycloak](/modules/keycloak) or [MySQL](/modules/mysql),
  both of which carry a 180s timeout in this library.
- **Round-trip proof avoids a Cassandra driver entirely.** The image ships
  `cqlsh` — the integration test `exec`s straight into the running container
  (`cqlsh -e "..."`) rather than adding a driver dependency to this repo.
