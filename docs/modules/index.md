# Modules

`rightsize/modules` ships twenty-three preconfigured containers — a sensible
default image, an exposed-ports set, a wait strategy checked against a real
boot (not just assumed from the docs), and connection helpers that hand you a
ready-to-use URI rather than making you assemble one from `getMappedPort`
calls yourself.

```ts
import { RedisContainer } from "rightsize/modules";
```

## Catalog

| Module | Default image | Helpers |
|---|---|---|
| [`RedisContainer`](/modules/redis) | `redis:latest` | `uri` |
| [`ValkeyContainer`](/modules/valkey) | `valkey/valkey:latest` | `uri` (`redis://` scheme) |
| [`MemcachedContainer`](/modules/memcached) | `memcached:latest` | `address` |
| [`ArangoContainer`](/modules/arango) | `arangodb:latest` | `endpoint`, `withRootPassword(...)` |
| [`MongoDBContainer`](/modules/mongodb) | `mongo:latest` | `connectionString`, `replicaSetUrl` (single-node replica set, auto-initiated) |
| [`PostgresContainer`](/modules/postgres) | `postgres:latest` | `connectionString`, `username`, `password`, `databaseName`, `withUsername`/`withPassword`/`withDatabase(...)` |
| [`MySQLContainer`](/modules/mysql) | `mysql:latest` | `connectionString`, `username`, `password`, `databaseName`, `withUsername`/`withPassword`/`withDatabase(...)` |
| [`MariaDBContainer`](/modules/mariadb) | `mariadb:latest` | `connectionString`, `username`, `password`, `databaseName`, `withUsername`/`withPassword`/`withDatabase(...)` |
| [`RedpandaContainer`](/modules/redpanda) | `redpandadata/redpanda:latest` | `bootstrapServers`, `schemaRegistryUrl` |
| [`KafkaContainer`](/modules/kafka) | `apache/kafka:latest` | `bootstrapServers` (KRaft single node) |
| [`RabbitMQContainer`](/modules/rabbitmq) | `rabbitmq:management` | `amqpUrl`, `managementUrl`, `username`, `password`, `withUsername`/`withPassword(...)` |
| [`PinotContainer`](/modules/pinot) | `apachepinot/pinot:latest` | `controllerUrl`, `brokerUrl` (QuickStart `-type EMPTY` single-container cluster) |
| [`SpringCloudConfigContainer`](/modules/spring-cloud-config) | `hyness/spring-cloud-config-server:latest` | `uri` |
| [`WireMockContainer`](/modules/wiremock) | `wiremock/wiremock:latest` | `baseUrl`, `adminUrl` |
| [`KeycloakContainer`](/modules/keycloak) | `quay.io/keycloak/keycloak:latest` | `authServerUrl`, `adminUsername`, `adminPassword`, `withAdminUsername`/`withAdminPassword(...)` |
| [`ClickHouseContainer`](/modules/clickhouse) | `clickhouse/clickhouse-server:latest` | `httpUrl`, `username`, `password`, `databaseName`, `withUsername`/`withPassword`/`withDatabase(...)` |
| [`Neo4jContainer`](/modules/neo4j) | `neo4j:latest` | `httpUrl`, `boltUrl`, `username`, `password`, `withPassword(...)` |
| [`FlociContainer`](/modules/floci) | `floci/floci:latest` / `floci/floci-az:latest` / `floci/floci-gcp:latest` | `FlociContainer.aws()`/`.azure()`/`.gcp()`, `endpointUrl` |
| [`FlinkContainer`](/modules/flink) | `flink:latest` | `restUrl`, `withTaskManager()` — **Docker only¹** |
| [`MinIOContainer`](/modules/minio) | `minio/minio:latest` | `endpointUrl`, `rootUser`, `rootPassword`, `withRootUser`/`withRootPassword(...)` |
| [`CassandraContainer`](/modules/cassandra) | `cassandra:latest` | `contactPoint`, `cqlPort`, `localDatacenter` |
| [`ElasticsearchContainer`](/modules/elasticsearch) | none — an explicit image is required² | `restUrl` |
| [`QdrantContainer`](/modules/qdrant) | `qdrant/qdrant:latest` | `restUrl` |

Every module page includes: the default image and how to override it, the
field defaults, every helper, a runnable example, and any backend-specific
notes worth knowing before you run it.

¹ `withTaskManager()` throws `UnsupportedByBackendError` on microsandbox — the
`flink` image carries no `nc`/busybox for the network-link tunnel (see
[Networking](/guide/networking)), so a bare JobManager still runs on
microsandbox, but the two-container topology needs
`RIGHTSIZE_BACKEND=docker`. Full detail on the [Flink page](/modules/flink).

² Elastic publishes no floating tag — `elasticsearch:latest`, `:9`, and `:8`
are all 404 on Docker Hub, only full version tags exist (verified against
`elasticsearch:9.4.4`). Both the constructor and `start()` require an
explicit image. Full detail on the
[Elasticsearch page](/modules/elasticsearch).

Some modules raise their container's memory ceiling above microsandbox's
default microVM RAM (`withMemoryLimit`, baked in — nothing you set yourself):
Spring Cloud Config, Keycloak, Neo4j, and Flink (1024 MB each), Cassandra and
Elasticsearch (2560 MB each), and Pinot's four-JVM QuickStart cluster
(4096 MB, non-negotiable — see its module page for the memory-ladder
evidence).

**No module pins a version.** Every no-arg constructor floats to the image's
own `:latest` (RabbitMQ's `management` tag is the one exception — plain
`rabbitmq:latest` ships without the management plugin this module depends
on), so the running version tracks upstream rather than this library's
release cycle. Each module page keeps the facts (readiness signal, memory
floor, timings) measured against the pinned version this module used to
float from, and says which version produced them — floating to `latest`
means the actual running version will drift from that verified one.
Redis, Valkey, Postgres, and Memcached previously defaulted to Alpine
variants; their `latest` floats onto the Debian-based image instead —
functionally equivalent, larger to pull. Elasticsearch is the only module
with no floating tag to fall back to at all — see below.

## Image compatibility

Every module here accepts a `DockerImageName` in place of a plain image
string, and checks the repository it's given (registry host, tag, and
digest stripped) against the repository it declares — Postgres expects
`postgres`, Qdrant expects `qdrant/qdrant`, Keycloak expects
`keycloak/keycloak` (its `quay.io` registry host is stripped the same way),
and Floci's three factories each check their own provider's repository. A
mismatched repository throws `IncompatibleImageError` before any backend
call, naming what was supplied and what was expected:

```ts
import { QdrantContainer } from "rightsize/modules";
import { DockerImageName } from "rightsize";

// A verified compatible fork or mirror under a different repository name:
await using qdrant = await QdrantContainer.start(
  DockerImageName.parse("mycorp/qdrant-hardened:1.0").asCompatibleSubstituteFor("qdrant/qdrant"),
);
```

An explicitly supplied image is always used verbatim — this check only ever
validates it, it never rewrites a tag or substitutes an image. The same
escape hatch Testcontainers itself uses (`asCompatibleSubstituteFor`).

## Don't see what you need?

Every module is a thin subclass of `GenericContainer` — if there's no
preconfigured module for your image, use `GenericContainer` directly with
your own `withEnv`/`withExposedPorts`/`waitingFor` calls. See the
[Quickstart](/guide/quickstart#driving-any-image-directly) for the shape.
