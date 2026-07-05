import { Kafka } from "kafkajs";
import "../backend-msb/index.js";
import "../backend-docker/index.js";
import { describe, itIntegration, assert } from "../../test/harness.js";
import { RedpandaContainer } from "./redpanda.js";
import { KafkaContainer } from "./kafka.js";

/**
 * Live produce/consume gates for the broker modules, run against whichever
 * backend `RIGHTSIZE_BACKEND` selects. `kafkajs` is a dev-only test
 * dependency (never shipped in the runtime `dependencies`) — hand-rolling
 * the Kafka wire protocol's metadata/produce/fetch requests just to prove
 * these two modules boot correctly would be a large amount of protocol code
 * for no behavior this library actually implements.
 */

async function roundTrip(bootstrapServers: string): Promise<string | undefined> {
  const brokers = [bootstrapServers.replace(/^PLAINTEXT:\/\//, "")];
  const kafka = new Kafka({ clientId: "rightsize-it", brokers, retry: { retries: 3 } });
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({ topics: [{ topic: "t1", numPartitions: 1, replicationFactor: 1 }] });
  } finally {
    await admin.disconnect();
  }

  const producer = kafka.producer();
  await producer.connect();
  try {
    await producer.send({ topic: "t1", messages: [{ key: "k", value: "v" }] });
  } finally {
    await producer.disconnect();
  }

  const consumer = kafka.consumer({ groupId: "g1" });
  await consumer.connect();
  try {
    await consumer.subscribe({ topic: "t1", fromBeginning: true });
    return await new Promise<string | undefined>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a message")), 20_000);
      consumer
        .run({
          eachMessage: async ({ message }) => {
            clearTimeout(timer);
            resolve(message.value?.toString("utf8"));
          },
        })
        .catch(reject);
    });
  } finally {
    await consumer.disconnect();
  }
}

describe("broker modules", () => {
  itIntegration("Redpanda: produce/consume round-trip over bootstrapServers", async () => {
    const rp = await RedpandaContainer.start();
    try {
      const value = await roundTrip(rp.bootstrapServers);
      assert.equal(value, "v");
    } finally {
      await rp.stop();
    }
  });

  itIntegration("Kafka: produce/consume round-trip over bootstrapServers", async () => {
    const kafkaContainer = await KafkaContainer.start();
    try {
      const value = await roundTrip(kafkaContainer.bootstrapServers);
      assert.equal(value, "v");
    } finally {
      await kafkaContainer.stop();
    }
  });
});
