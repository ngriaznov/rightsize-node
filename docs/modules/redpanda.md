# Redpanda

A single-node Redpanda broker (Kafka API-compatible) with its schema registry
enabled. Pinned to a versioned tag rather than `:latest` — the upstream
registry rate-limits anonymous pulls, and a versioned tag keeps a
one-time image seed (`docker save ... | msb load`, ahead of microsandbox
runs) reproducible.

**Default image:** `docker.redpanda.com/redpandadata/redpanda:v24.2.4`
**Exposed ports:** `9092` (external Kafka API), `9093` (internal, for
sibling containers on the same `Network`), `8081` (schema registry)
**Wait strategy:** log message `".*Successfully started Redpanda.*"`

| Member | Returns |
|---|---|
| `RedpandaContainer.start(image?)` | `Promise<RedpandaContainer>` — boots the container |
| `.bootstrapServers` | A `PLAINTEXT://host:port` bootstrap-servers address (external listener) |
| `.schemaRegistryUrl` | The schema registry's base URL |

## Example

```ts
import { RedpandaContainer } from "rightsize/modules";
import { Kafka } from "kafkajs";

await using redpanda = await RedpandaContainer.start();
const kafka = new Kafka({ brokers: [redpanda.bootstrapServers.replace("PLAINTEXT://", "")] });
const producer = kafka.producer();
await producer.connect();
await producer.send({ topic: "t", messages: [{ value: "hello" }] });
await producer.disconnect();
```

## Backend notes

The broker's advertised listener needs the mapped host port, which is only
known once ports are allocated — this module rewrites its startup command
(`customizeSpec`) to advertise the real mapped port for the external
listener and the fixed network alias for the internal one, so a client
connecting from the host and a sibling container connecting over `Network`
both get a listener that actually matches how they're reaching the broker.
No action needed from you; this is the same mechanism [Kafka](/modules/kafka)
uses for its single advertised listener.
