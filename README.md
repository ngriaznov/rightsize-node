# rightsize

[![CI](https://github.com/ngriaznov/rightsize-node/actions/workflows/ci.yml/badge.svg)](https://github.com/ngriaznov/rightsize-node/actions/workflows/ci.yml)

**Testcontainers-style integration testing on microVMs. No Docker required.**

rightsize runs your integration-test containers as hardware-isolated
[microsandbox](https://github.com/superradcompany/microsandbox) microVMs —
one microVM per container — behind a strict-mode ESM TypeScript API whose
flagship lifecycle is TC39 explicit resource management. The runtime
self-provisions on first use (no install step), and a hand-rolled Docker
backend covers the platforms microVMs can't reach.

```ts runnable
import "rightsize/backend-msb";
import "rightsize/backend-docker";
import { RedisContainer } from "rightsize/modules";

async function main(): Promise<void> {
  await using redis = await RedisContainer.start(); // boots a real microVM
  console.log("redis is up at", redis.uri); // redis://127.0.0.1:<mapped port>
  // ... your test ...
}

await main();
```

`await using` is the whole story: `redis` is disposed automatically at the
end of its scope — stopped, removed, its port freed — ordered and awaited,
the same way a `try`/`finally` would, with none of the boilerplate.

## Why microVMs

| | Docker + Testcontainers | rightsize |
|---|---|---|
| Isolation | shared kernel (containers) | **hardware-level (microVM per container)** |
| Runtime install | Docker Desktop / daemon required | **none — self-provisions on first use** |
| Licensing | Docker Desktop licensing in orgs | Apache-2.0 all the way down |
| Lifecycle | manual `try`/`finally` | **`await using` explicit resource management** |
| Docker client | a general-purpose SDK over a shared HTTP stack | **hand-rolled, unix-socket-only — can't be misrouted onto TCP** |

The lifecycle and Docker-client rows above aren't incidental implementation
choices — see [Lifecycle](https://ngriaznov.github.io/rightsize-node/guide/lifecycle)
and [Backends](https://ngriaznov.github.io/rightsize-node/guide/backends)
for why each one is the way it is. (If you've used Testcontainers, the
builder shape — `withEnv`, `withExposedPorts`, `waitingFor`, `getMappedPort`
— will feel familiar; the lifecycle is where this library departs from it
most.)

## Quickstart

```sh
npm install --save-dev rightsize
```

Importing a backend subpath registers it as a side effect — import whichever
one(s) you want considered, and `rightsize` picks the best supported one
automatically (or `RIGHTSIZE_BACKEND` forces a specific one):

```ts
import "rightsize/backend-msb";
import "rightsize/backend-docker";
```

Drive any image directly with `GenericContainer`, or use one of eighteen
preconfigured modules:

```ts
import { GenericContainer, Wait } from "rightsize";

await using arango = await new GenericContainer("arangodb:3.11")
  .withEnv("ARANGO_NO_AUTH", "1")
  .withExposedPorts(8529)
  .waitingFor(Wait.forHttp("/_api/version").forPort(8529))
  .start();

const port = arango.getMappedPort(8529); // published on 127.0.0.1
```

Full guide: [Quickstart](https://ngriaznov.github.io/rightsize-node/guide/quickstart).

## Modules

Preconfigured containers with sensible waits and connection helpers. Each is
a `GenericContainer` subclass, so the fluent builders (`withEnv`,
`withExposedPorts`, `waitingFor`, …) are available on every one.

| Module | Helpers |
|---|---|
| `RedisContainer` | `uri` |
| `MemcachedContainer` | `address` |
| `ArangoContainer` | `endpoint`; `withRootPassword(...)` to enable auth (default: no-auth) |
| `MongoDBContainer` | `connectionString`, `replicaSetUrl` (alias) — single-node replica set, auto-initiated |
| `PostgresContainer` | `connectionString`, `username`, `password`, `databaseName`; `withUsername`/`withPassword`/`withDatabase(...)` |
| `MySQLContainer` | `connectionString`, `username`, `password`, `databaseName`; `withUsername`/`withPassword`/`withDatabase(...)` |
| `MariaDBContainer` | `connectionString`, `username`, `password`, `databaseName`; `withUsername`/`withPassword`/`withDatabase(...)` |
| `RedpandaContainer` | `bootstrapServers`, `schemaRegistryUrl` |
| `KafkaContainer` | `bootstrapServers` — KRaft single node |
| `RabbitMQContainer` | `amqpUrl`, `managementUrl`, `username`, `password`; `withUsername`/`withPassword(...)` — management plugin enabled |
| `PinotContainer` | `controllerUrl`, `brokerUrl` — single-container QuickStart cluster |
| `SpringCloudConfigContainer` | `uri` |
| `WireMockContainer` | `baseUrl`, `adminUrl` — stub via the `/__admin` API |
| `KeycloakContainer` | `authServerUrl`, `adminUsername`, `adminPassword`; `withAdminUsername`/`withAdminPassword(...)` |
| `ClickHouseContainer` | `httpUrl`, `username`, `password`, `databaseName`; `withUsername`/`withPassword`/`withDatabase(...)` |
| `Neo4jContainer` | `httpUrl`, `boltUrl`, `username`, `password`; `withPassword(...)` — HTTP Cypher endpoint (username fixed at `neo4j`) |
| `FlociContainer` | `FlociContainer.aws()`/`.azure()`/`.gcp()` factories, `endpointUrl` — [floci.io](https://floci.io) cloud emulators (unsigned REST, no SDK needed) |
| `FlinkContainer` | `restUrl`; `withTaskManager()` for a full session cluster — **Docker only**¹ |

Some modules raise a memory floor for their image (`withMemoryLimit`):
heavyweight JVM images — Spring Cloud Config, Keycloak, Neo4j, Flink
(1024 MB) — and Pinot's multi-JVM QuickStart cluster (4096 MB) — need more
than the microVM default. That's baked into the module; you don't set it.
Every module's page under [`docs/modules/`](https://ngriaznov.github.io/rightsize-node/modules/)
documents its exact image tag, wait strategy, and the measured reasoning
behind these choices.

¹ `withTaskManager()` throws `UnsupportedByBackendError` on microsandbox (the
Flink image carries no `nc`/busybox for network-link emulation — see
[Networking](https://ngriaznov.github.io/rightsize-node/guide/networking));
a bare JobManager still runs on microsandbox. Run TaskManager topologies
under `RIGHTSIZE_BACKEND=docker`.

## Backends

rightsize picks a backend automatically; override with
`RIGHTSIZE_BACKEND=microsandbox|docker`.

| Platform | Backend used |
|---|---|
| macOS (Apple Silicon) | microsandbox (microVMs) |
| Linux x86_64 / arm64 with `/dev/kvm` | microsandbox (microVMs) |
| Windows x86_64 / arm64 (WHP enabled) | microsandbox (microVMs)¹ |
| Intel Mac | Docker (auto-fallback) |
| Windows without WHP | Docker (auto-fallback) |
| Linux without KVM | Docker (auto-fallback) |

¹ Verified in CI on `windows-2025` hosted runners, where Windows Hypervisor
Platform is enabled by default. If WHP isn't enabled on your machine, run
`msb doctor --fix` in an elevated terminal (may require a reboot) or use
`RIGHTSIZE_BACKEND=docker`.

Both backends satisfy one behavioral contract, verified by a shared test
suite — the code you write runs unchanged on either. A few edges are
backend-specific rather than behavioral divergences:

- **Network-alias tunnels on microsandbox have real limits** versus Docker's
  native bridge networking — see
  [Networking](https://ngriaznov.github.io/rightsize-node/guide/networking).
- **Read-only file mounts aren't enforced in-guest on microsandbox 0.6.6.**
  `withCopyFileToContainer`'s read-only flag is honored by Docker; on
  microsandbox the guest currently gets a writable mount regardless. Don't
  rely on guest-side write protection under `RIGHTSIZE_BACKEND=microsandbox`.
- **`followOutput` delivers the same ordered, no-duplicate log stream on
  both backends**, but on microsandbox the final tail can arrive shortly
  after the sandbox reports stopped, rather than exactly at stream EOF
  (`msb logs -f` doesn't close on sandbox stop in 0.6.6, so the backend
  replays the not-yet-delivered tail once stop is confirmed).

## How it works

- **Self-provisioning runtime.** A pinned `msb` release (binary + libkrunfw)
  is downloaded once, SHA-256-verified against the release manifest, and
  installed atomically under `~/.cache/rightsize/` (`%LOCALAPPDATA%\rightsize`
  on Windows) — the binary lands last, so a crashed install is detected and
  repaired, never half-trusted. A cross-process file lock keeps parallel
  processes from racing.
- **Attached-mode supervision.** Each container is a held child process
  supervising its microVM; the image's ENTRYPOINT runs exactly as it would
  under Docker.
- **Pre-allocated ports.** Host ports are chosen before boot, so brokers
  like Redpanda/Kafka get their advertised listeners baked in — no restart
  dance. A backend binds the ports it's given; it never allocates its own.
- **Two-tier cleanup, no async `Drop`.** The happy path is `await using` or
  an explicit, awaited `stop()`. The fallback — a process that exits before
  either runs — falls back to a synchronous, blocking teardown registered
  per container (Node's `"exit"` handler can't `await`), with a run-id-scoped
  orphan reaper at backend startup as the backstop for a hard `SIGKILL` that
  bypasses even that.
- **One interface, two backends.** `SandboxBackend` is a small interface;
  the shared contract suite is the referee, with the Docker backend doubling
  as the correctness oracle for the microVM backend.

Full detail: [How It Works](https://ngriaznov.github.io/rightsize-node/guide/how-it-works).

## Configuration

| Env var | Effect |
|---|---|
| `RIGHTSIZE_BACKEND` | Force `microsandbox` or `docker` |
| `MSB_PATH` | Use a pre-installed `msb` binary; skip downloads |
| `RIGHTSIZE_CACHE_DIR` | Relocate the runtime cache (default `~/.cache/rightsize`; `%LOCALAPPDATA%\rightsize` on Windows) |
| `RIGHTSIZE_MSB_SKIP_DOWNLOAD` | `true` = fail instead of downloading (air-gapped CI) |

## Runtime support

| Runtime | Minimum |
|---|---|
| Node.js | `>=22.11` (the 22.x "Jod" LTS line) |
| Bun | `>=1.1` |

Authored in TypeScript using `await using`; `tsc` emits ES2022 plus the
downlevelled explicit-resource-management helpers, so the shipped
`dist/**.js` runs unmodified on both runtimes with no flags.

## Examples

Three self-contained, runnable examples live under
[`examples/`](https://github.com/ngriaznov/rightsize-node/tree/main/examples).
Each builds the library once, then runs directly against the compiled
`dist/` — no separate example-specific setup beyond `npm install`.

| Example | What it shows | Run |
|---|---|---|
| [`redis-quickstart.ts`](https://github.com/ngriaznov/rightsize-node/blob/main/examples/redis-quickstart.ts) | The `await using` lifecycle — the library's signature | `npm run example:redis` |
| [`network-alias.ts`](https://github.com/ngriaznov/rightsize-node/blob/main/examples/network-alias.ts) | Two containers on one `Network`, reachable by alias | `npm run example:network` |
| [`redis.test.ts`](https://github.com/ngriaznov/rightsize-node/blob/main/examples/redis.test.ts) | A `node:test` suite using a module container, gated behind `RIGHTSIZE_IT=1` the same way this repo's own integration tests are | `npm run example:test` |

Run all three back to back with `npm run examples:run`. Every example picks
a backend automatically; force one explicitly the same way you would for
any `rightsize` program:

```bash
RIGHTSIZE_BACKEND=docker npm run example:redis
RIGHTSIZE_BACKEND=microsandbox npm run example:redis
```

`redis.test.ts` skips its container-backed assertions unless `RIGHTSIZE_IT=1`
is set, so `npm run example:test` is safe to run on a machine with no
container runtime — pass the flag to actually exercise it:
`RIGHTSIZE_IT=1 npm run example:test`.

## Documentation

Full documentation (guide, backends, module reference) is at
**[ngriaznov.github.io/rightsize-node](https://ngriaznov.github.io/rightsize-node/)**,
built from [`docs/`](docs) by VitePress.

## Development

```bash
npm install                                                # installs dependencies
npm run build                                              # compiles src/ to dist/
npm run typecheck                                          # tsc --noEmit
npm test                                                    # unit suite, both runtimes
npm run coverage:core                                       # core coverage, 80% line floor
RIGHTSIZE_BACKEND=microsandbox npm run test:node:it         # needs Apple Silicon or Linux+KVM
RIGHTSIZE_BACKEND=docker npm run test:node:it               # needs a reachable Docker daemon
npm run docs:build                                          # static docs site
npm run docs:verify                                         # typechecks every doc/README sample
```

CI runs the matrix on Linux (KVM), macOS (Apple Silicon), and a Docker-only
job, both Node and Bun.

See [`CONTRIBUTING.md`](https://github.com/ngriaznov/rightsize-node/blob/main/.github/CONTRIBUTING.md)
for what each `tsconfig*.json` is for, the full npm script reference, and
integration-test conventions.

## License

[Apache-2.0](LICENSE)
