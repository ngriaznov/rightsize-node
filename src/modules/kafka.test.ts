import { describe, it, assert } from "../../test/harness.js";
import { KafkaContainer } from "./kafka.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";

describe("KafkaContainer", () => {
  it("exposes port 9092 and sets the KRaft env block including the memory floor", async () => {
    const backend = new FakeModuleBackend();
    const kafka = new KafkaContainer().withBackend(backend).waitingFor(instantReadyWait());
    await kafka.start();
    try {
      assert.equal(backend.lastSpec?.image, "apache/kafka:4.0.0");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [9092]);
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("KAFKA_NODE_ID"), "1");
      assert.equal(env.get("KAFKA_PROCESS_ROLES"), "broker,controller");
      assert.equal(env.get("KAFKA_HEAP_OPTS"), "-Xmx256M -Xms256M");
    } finally {
      await kafka.stop();
    }
  });

  it("customizeSpec appends KAFKA_ADVERTISED_LISTENERS with the mapped host port", async () => {
    const backend = new FakeModuleBackend();
    const kafka = new KafkaContainer().withBackend(backend).waitingFor(instantReadyWait());
    await kafka.start();
    try {
      const mapped = kafka.getMappedPort(9092);
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("KAFKA_ADVERTISED_LISTENERS"), `PLAINTEXT://127.0.0.1:${mapped}`);
    } finally {
      await kafka.stop();
    }
  });

  it("builds bootstrapServers from host and mapped port", async () => {
    const backend = new FakeModuleBackend();
    const kafka = new KafkaContainer().withBackend(backend).waitingFor(instantReadyWait());
    await kafka.start();
    try {
      assert.equal(kafka.bootstrapServers, `PLAINTEXT://127.0.0.1:${kafka.getMappedPort(9092)}`);
    } finally {
      await kafka.stop();
    }
  });

  it("accepts a custom image tag via the constructor", async () => {
    const backend = new FakeModuleBackend();
    const kafka = new KafkaContainer("apache/kafka:4.1.0").withBackend(backend).waitingFor(instantReadyWait());
    await kafka.start();
    try {
      assert.equal(backend.lastSpec?.image, "apache/kafka:4.1.0");
    } finally {
      await kafka.stop();
    }
  });
});
