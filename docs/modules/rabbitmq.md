# RabbitMQ

A single-node RabbitMQ container with the management plugin enabled. Defaults
to the image's own `guest`/`guest` credentials.

**Default image:** `rabbitmq:4-management-alpine`
**Exposed ports:** `5672` (AMQP), `15672` (management HTTP API)
**Wait strategy:** log message `".*Server startup complete.*"`

| Member | Returns |
|---|---|
| `RabbitMQContainer.start(image?)` | `Promise<RabbitMQContainer>` — boots the container |
| `.withUsername(name)` | `this` — overrides `RABBITMQ_DEFAULT_USER` (default `guest`) |
| `.withPassword(pw)` | `this` — overrides `RABBITMQ_DEFAULT_PASS` (default `guest`) |
| `.username` / `.password` | The configured credentials |
| `.amqpUrl` | An `amqp://user:pass@host:port` connection URL |
| `.managementUrl` | The management HTTP API's base URL |

## Example

```ts
import { RabbitMQContainer } from "rightsize/modules";
import amqplib from "amqplib";

await using rabbit = await RabbitMQContainer.start();
const conn = await amqplib.connect(rabbit.amqpUrl);
const channel = await conn.createChannel();
// RabbitMQ 4.x rejects transient non-exclusive queues — declare durable or exclusive.
await channel.assertQueue("q", { durable: true });
await channel.sendToQueue("q", Buffer.from("hello"));
await conn.close();
```

## Backend notes

**RabbitMQ 4.x rejects declaring a transient (non-durable), non-exclusive
queue** — a behavior change from 3.x. Declare durable or exclusive queues, as
in the example above; a transient shared queue now errors at declare time,
independent of which backend you're running on.
