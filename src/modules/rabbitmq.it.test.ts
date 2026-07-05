import amqp from "amqplib";
import "../backend-msb/index.js";
import "../backend-docker/index.js";
import { describe, itIntegration, assert } from "../../test/harness.js";
import { RabbitMQContainer } from "./rabbitmq.js";

/**
 * Real AMQP round-trip via `amqplib` (a dev-only test dependency, never
 * shipped in `dependencies`). The queue is declared **durable**, not
 * transient: RabbitMQ 4.x rejects declaring a transient (non-durable),
 * non-exclusive queue, a behavior change from 3.x that would otherwise make
 * this exact round-trip fail at `assertQueue` time.
 */
describe("RabbitMQ module", () => {
  itIntegration("durable-queue publish/consume round-trip over amqpUrl", async () => {
    const rabbit = await RabbitMQContainer.start();
    try {
      const connection = await amqp.connect(rabbit.amqpUrl);
      try {
        const channel = await connection.createChannel();
        try {
          const queue = "rightsize-it-queue";
          await channel.assertQueue(queue, { durable: true });
          channel.sendToQueue(queue, Buffer.from("hello-rabbitmq"));

          const received = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timed out waiting for a message")), 20_000);
            channel
              .consume(
                queue,
                (msg) => {
                  if (msg !== null) {
                    clearTimeout(timer);
                    channel.ack(msg);
                    resolve(msg.content.toString("utf8"));
                  }
                },
                { noAck: false },
              )
              .catch(reject);
          });
          assert.equal(received, "hello-rabbitmq");
        } finally {
          await channel.close();
        }
      } finally {
        await connection.close();
      }
    } finally {
      await rabbit.stop();
    }
  });
});
