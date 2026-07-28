# Redpanda

A single-node Redpanda broker (Kafka API-compatible) with its schema registry
enabled.

**Default image:** `redpandadata/redpanda:latest`
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

- **No-arg construction floats to `redpandadata/redpanda:latest`.** Verified
  against `redpandadata/redpanda:v24.2.4`. This module previously pinned a
  versioned tag instead of floating, reasoning that `docker.redpanda.com`
  rate-limits anonymous pulls and a versioned tag made a one-time image seed
  (`docker save ... | msb load`, ahead of microsandbox runs) reproducible —
  that rate limit is a pull-frequency property, not a tag one, and applies to
  `:latest` exactly the same as any other tag; seed the image into the cache
  once regardless of which reference you use.
- **Compatibility check:** the constructor only accepts images whose
  repository is `redpandadata/redpanda` (registry host, tag, and digest
  stripped). A different repository throws `IncompatibleImageError` before
  any backend call; override with
  `DockerImageName.parse(image).asCompatibleSubstituteFor("redpandadata/redpanda")`
  for a verified compatible fork or mirror.
- The broker's advertised listener needs the mapped host port, which is only
  known once ports are allocated — this module rewrites its startup command
  (`customizeSpec`) to advertise the real mapped port for the external
  listener and the fixed network alias for the internal one, so a client
  connecting from the host and a sibling container connecting over `Network`
  both get a listener that actually matches how they're reaching the broker.
  No action needed from you; this is the same mechanism
  [Kafka](/modules/kafka) uses for its single advertised listener.
