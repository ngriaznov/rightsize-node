# Kafka

A single-node Kafka broker running in KRaft mode (no ZooKeeper).

**Default image:** `apache/kafka:4.0.0`
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

- **The advertised listener is rewritten to carry the mapped host port**,
  known only once ports are allocated — the same `customizeSpec` mechanism
  [Redpanda](/modules/redpanda) uses, applied here to Kafka's single
  advertised listener.
- **The image's default JVM heap (1GB) is lowered to 256MB** by this module.
  The apache/kafka image's default heap exceeds microsandbox's default
  microVM RAM and aborts the JVM outright; a single-node KRaft dev broker
  runs comfortably in 256MB, and the override is harmless on Docker (which
  isn't memory-constrained the same way here).
