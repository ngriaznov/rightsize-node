# Modules

`rightsize/modules` ships eighteen preconfigured containers — a sensible
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
| [`RedisContainer`](/modules/redis) | `redis:8.6-alpine` | `uri` |
| [`MemcachedContainer`](/modules/memcached) | `memcached:1.6-alpine` | `address` |
| [`ArangoContainer`](/modules/arango) | `arangodb:3.11` | `endpoint`, `withRootPassword(...)` |
| [`MongoDBContainer`](/modules/mongodb) | `mongo:8.0` | `connectionString`, `replicaSetUrl` (single-node replica set, auto-initiated) |
| [`PostgresContainer`](/modules/postgres) | `postgres:18-alpine` | `connectionString`, `username`, `password`, `databaseName`, `withUsername`/`withPassword`/`withDatabase(...)` |
| [`MySQLContainer`](/modules/mysql) | `mysql:8.4` | `connectionString`, `username`, `password`, `databaseName`, `withUsername`/`withPassword`/`withDatabase(...)` |
| [`MariaDBContainer`](/modules/mariadb) | `mariadb:11.4` | `connectionString`, `username`, `password`, `databaseName`, `withUsername`/`withPassword`/`withDatabase(...)` |
| [`RedpandaContainer`](/modules/redpanda) | `redpandadata/redpanda:v24.2.4` | `bootstrapServers`, `schemaRegistryUrl` |
| [`KafkaContainer`](/modules/kafka) | `apache/kafka:4.0.0` | `bootstrapServers` (KRaft single node) |
| [`RabbitMQContainer`](/modules/rabbitmq) | `rabbitmq:4-management-alpine` | `amqpUrl`, `managementUrl`, `username`, `password`, `withUsername`/`withPassword(...)` |
| [`PinotContainer`](/modules/pinot) | `apachepinot/pinot:1.5.1` | `controllerUrl`, `brokerUrl` (QuickStart `-type EMPTY` single-container cluster) |
| [`SpringCloudConfigContainer`](/modules/spring-cloud-config) | `hyness/spring-cloud-config-server:latest` | `uri` |
| [`WireMockContainer`](/modules/wiremock) | `wiremock/wiremock:3.13.2` | `baseUrl`, `adminUrl` |
| [`KeycloakContainer`](/modules/keycloak) | `quay.io/keycloak/keycloak:26.0` | `authServerUrl`, `adminUsername`, `adminPassword`, `withAdminUsername`/`withAdminPassword(...)` |
| [`ClickHouseContainer`](/modules/clickhouse) | `clickhouse/clickhouse-server:25.8` | `httpUrl`, `username`, `password`, `databaseName`, `withUsername`/`withPassword`/`withDatabase(...)` |
| [`Neo4jContainer`](/modules/neo4j) | `neo4j:5-community` | `httpUrl`, `boltUrl`, `username`, `password`, `withPassword(...)` |
| [`FlociContainer`](/modules/floci) | `floci/floci` / `floci/floci-az` / `floci/floci-gcp` | `FlociContainer.aws()`/`.azure()`/`.gcp()`, `endpointUrl` |
| [`FlinkContainer`](/modules/flink) | `flink:1.20.5` | `restUrl`, `withTaskManager()` — **Docker only¹** |

Every module page includes: the default image and how to override it, the
field defaults, every helper, a runnable example, and any backend-specific
notes worth knowing before you run it.

¹ `withTaskManager()` throws `UnsupportedByBackendError` on microsandbox — the
`flink` image carries no `nc`/busybox for the network-link tunnel (see
[Networking](/guide/networking)), so a bare JobManager still runs on
microsandbox, but the two-container topology needs
`RIGHTSIZE_BACKEND=docker`. Full detail on the [Flink page](/modules/flink).

Some modules raise their container's memory ceiling above microsandbox's
default microVM RAM (`withMemoryLimit`, baked in — nothing you set yourself):
Spring Cloud Config, Keycloak, Neo4j, and Flink (1024 MB each), and Pinot's
four-JVM QuickStart cluster (4096 MB, non-negotiable — see its module page
for the memory-ladder evidence).

## Don't see what you need?

Every module is a thin subclass of `GenericContainer` — if there's no
preconfigured module for your image, use `GenericContainer` directly with
your own `withEnv`/`withExposedPorts`/`waitingFor` calls. See the
[Quickstart](/guide/quickstart#driving-any-image-directly) for the shape.
