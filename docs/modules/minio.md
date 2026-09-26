# MinIO

A single-node MinIO container — an S3-compatible object store, started with
an explicit `server /data --console-address :9001` command (the image's
default ENTRYPOINT alone does not serve).

**Default image:** `pgsty/minio:latest` (MinIO no longer publishes public
images — see [Backend notes](#backend-notes) below)
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

- **No-arg construction floats to `pgsty/minio:latest`.** MinIO no longer
  publishes public images: Docker Hub's `minio/minio` was removed, and as of
  September 2026 `quay.io/minio/minio`, this module's previous default,
  refuses anonymous pulls (HTTP 401). `pgsty/minio` is Pigsty's community
  build of MinIO from source, published on Docker Hub for linux/amd64 and
  linux/arm64 with upstream's image layout (the same entrypoint and env
  defaults, `mc` bundled). The notes below were verified against
  `minio/minio:RELEASE.2025-09-07T16-13-09Z`; readiness, auth enforcement,
  and the `mc` round-trip were verified again by this module's integration
  test against `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` (what `latest`
  pointed at) on msb 0.7.3. Pin to that release with
  `MinIOContainer.start("pgsty/minio:RELEASE.2026-08-04T00-00-00Z")` instead
  of floating.
- **Compatibility check:** the constructor only accepts images whose
  repository is `minio/minio` (registry host, tag, and digest stripped), so
  both `quay.io/minio/minio:<tag>` and a bare `minio/minio:<tag>` are
  accepted. `pgsty/minio` (any tag or digest) is accepted too: it is this
  module's own default, so the module declares it a substitute for
  `minio/minio` itself, no `asCompatibleSubstituteFor` call needed. A
  different repository throws `IncompatibleImageError` before any backend
  call; override with
  `DockerImageName.parse(image).asCompatibleSubstituteFor("minio/minio")` for
  a verified compatible fork or mirror under some other repository name.
- **Credentials default to `testuser`/`testpassword`, not this library's
  usual `test`/`test` pair.** MinIO rejects a root password shorter than 8
  characters, so `test` (4 characters) doesn't work here — this module's
  defaults differ from [ClickHouse](/modules/clickhouse)'s for exactly that
  reason. A password passed to `withRootPassword` must be 8+ characters too.
- **The command is required.** Unlike most modules here, MinIO's image needs
  an explicit `server /data --console-address :9001` command — running the
  image with no command override does not start the server at all.
- **No memory-limit override is set.** The `minio/minio` round-trip that
  verified this module ran at 1024 MB, but whether MinIO actually needs more
  than microsandbox's default microVM sizing wasn't isolated from the rest
  of that round-trip's overhead — this page will be updated once that's
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
