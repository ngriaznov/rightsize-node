/**
 * `rightsize/modules` — eighteen preconfigured containers.
 *
 * Each module is a `GenericContainer` subclass with sensible defaults (image
 * tag, exposed ports, wait strategy, and any memory floor its image needs)
 * plus typed connection helpers, so `await using redis = await RedisContainer.start()`
 * is immediately usable without hand-assembling a `GenericContainer`. Every
 * builder method from the base class (`withEnv`, `withExposedPorts`,
 * `waitingFor`, …) remains available on every module.
 *
 * @packageDocumentation
 */
export { RedisContainer } from "./redis.js";
export { MemcachedContainer, MemcachedRespondsStrategy } from "./memcached.js";
export { ArangoContainer } from "./arango.js";
export { MongoDBContainer } from "./mongodb.js";
export { RedpandaContainer } from "./redpanda.js";
export { KafkaContainer } from "./kafka.js";
export { SpringCloudConfigContainer } from "./spring-cloud-config.js";
export { PostgresContainer } from "./postgres.js";
export { MySQLContainer } from "./mysql.js";
export { PinotContainer } from "./pinot.js";
export { RabbitMQContainer } from "./rabbitmq.js";
export { MariaDBContainer } from "./mariadb.js";
export { FlinkContainer } from "./flink.js";
export { WireMockContainer } from "./wiremock.js";
export { KeycloakContainer } from "./keycloak.js";
export { ClickHouseContainer } from "./clickhouse.js";
export { Neo4jContainer } from "./neo4j.js";
export { FlociContainer } from "./floci.js";
