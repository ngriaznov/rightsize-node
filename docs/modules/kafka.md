# Kafka

A single-node Kafka broker running in KRaft mode (no ZooKeeper).

**Default image:** `apache/kafka:latest`
**Exposed port:** `9092`
**Wait strategy:** log message `".*Kafka Server started.*"`

| Member | Returns |
|---|---|
| `KafkaContainer.start(image?)` | `Promise<KafkaContainer>` — boots the container |
| `.bootstrapServers` | A `PLAINTEXT://host:port` bootstrap-servers address |

## Example

```ts
import { KafkaContainer } from "rightsize/modules";
import { Kafka } from "kafkajs";

await using kafka = await KafkaContainer.start();
const client = new Kafka({ brokers: [kafka.bootstrapServers.replace("PLAINTEXT://", "")] });
const producer = client.producer();
await producer.connect();
await producer.send({ topic: "t", messages: [{ value: "hello" }] });
await producer.disconnect();
```

## Backend notes

- **No-arg construction floats to `apache/kafka:latest`.** Verified against
  `apache/kafka:4.0.0`, including the heap-override fact below.
- **Compatibility check:** the constructor only accepts images whose
  repository is `apache/kafka` (registry host, tag, and digest stripped). A
  different repository throws `IncompatibleImageError` before any backend
  call; override with
  `DockerImageName.parse(image).asCompatibleSubstituteFor("apache/kafka")`
  for a verified compatible fork or mirror.
- **The advertised listener is rewritten to carry the mapped host port**,
  known only once ports are allocated — the same `customizeSpec` mechanism
  [Redpanda](/modules/redpanda) uses, applied here to Kafka's single
  advertised listener.
- **The image's default JVM heap (1GB) is lowered to 256MB** by this module.
  The apache/kafka image's default heap exceeds microsandbox's default
  microVM RAM and aborts the JVM outright; a single-node KRaft dev broker
  runs comfortably in 256MB, and the override is harmless on Docker (which
  isn't memory-constrained the same way here).
