# MinIO

A single-node MinIO container — an S3-compatible object store, started with
an explicit `server /data --console-address :9001` command (the image's
default ENTRYPOINT alone does not serve).

**Default image:** `minio/minio:RELEASE.2025-09-07T16-13-09Z`
**Exposed ports:** `9000` (S3 API, what the helpers here use), `9001`
(web console — published only, no helper wraps it)
**Wait strategy:** `Wait.forHttp("/minio/health/live").forPort(9000)`

| Member | Returns |
|---|---|
| `MinIOContainer.start(image?)` | `Promise<MinIOContainer>` — boots the container |
| `.withRootUser(user)` | `this` — overrides `MINIO_ROOT_USER` (default `testuser`) |
| `.withRootPassword(pw)` | `this` — overrides `MINIO_ROOT_PASSWORD` (default `testpassword`) |
| `.rootUser` / `.rootPassword` | The configured values |
| `.endpointUrl` | The S3 API's base URL |

## Example

```ts
import { MinIOContainer } from "rightsize/modules";

await using minio = await MinIOContainer.start();

// The image ships `mc` (MinIO's own client) — no S3 SDK needed.
const mcHost = `MC_HOST_local=http://${minio.rootUser}:${minio.rootPassword}@127.0.0.1:9000`;
await minio.exec("sh", "-c", `${mcHost} mc mb local/example`);
await minio.exec("sh", "-c", `printf 'hello' > /srv/key && ${mcHost} mc cp /srv/key local/example/key`);
const result = await minio.exec("sh", "-c", `${mcHost} mc cat local/example/key`);
console.log(result.stdout); // "hello"
```

## Backend notes

- **Credentials default to `testuser`/`testpassword`, not this library's
  usual `test`/`test` pair.** MinIO rejects a root password shorter than 8
  characters, so `test` (4 characters) doesn't work here — this module's
  defaults differ from [ClickHouse](/modules/clickhouse)'s for exactly that
  reason. A password passed to `withRootPassword` must be 8+ characters too.
- **The command is required.** Unlike most modules here, MinIO's image needs
  an explicit `server /data --console-address :9001` command — running the
  image with no command override does not start the server at all.
- **No memory-limit override is set.** The round-trip that verified this
  module ran at 1024 MB, but whether MinIO actually needs more than
  microsandbox's default microVM sizing wasn't isolated from the rest of
  that round-trip's overhead — this page will be updated once that's
  measured on its own.
- **Round-trip proof avoids an S3 SDK entirely.** The image ships `mc`
  (MinIO's own client) — the integration test `exec`s straight into the
  running container (`mc mb`, `mc cp`, `mc cat`) rather than adding an S3
  client dependency to this repo. It uses `mc cp` on a file written into the
  guest rather than piping bytes into `mc pipe` over stdin: an exec'd
  `mc pipe` under this backend either dumps its goroutines and exits
  non-zero or hangs outright, both observed directly, while `mc cp` needs no
  stdin and round-trips reliably. The test also confirms `/minio/health/live`
  answers 200 and that an unauthenticated request to the API is denied
  (`AccessDenied`), proving auth is actually in force.
