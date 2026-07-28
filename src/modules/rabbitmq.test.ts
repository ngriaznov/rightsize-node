import { describe, it, assert } from "../../test/harness.js";
import { RabbitMQContainer } from "./rabbitmq.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";
import { DockerImageName } from "../core/docker-image-name.js";
import { IncompatibleImageError } from "../core/errors.js";

describe("RabbitMQContainer", () => {
  it("exposes AMQP (5672) and management (15672) ports with guest/guest defaults", async () => {
    const backend = new FakeModuleBackend();
    const rabbit = new RabbitMQContainer().withBackend(backend).waitingFor(instantReadyWait());
    await rabbit.start();
    try {
      assert.equal(backend.lastSpec?.image, "rabbitmq:management");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [5672, 15672]);
      assert.equal(rabbit.username, "guest");
      assert.equal(rabbit.password, "guest");
    } finally {
      await rabbit.stop();
    }
  });

  it("withUsername/withPassword override the defaults and set RABBITMQ_DEFAULT_USER/PASS", async () => {
    const backend = new FakeModuleBackend();
    const rabbit = new RabbitMQContainer()
      .withBackend(backend)
      .waitingFor(instantReadyWait())
      .withUsername("alice")
      .withPassword("s3cret");
    await rabbit.start();
    try {
      assert.equal(rabbit.username, "alice");
      assert.equal(rabbit.password, "s3cret");
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("RABBITMQ_DEFAULT_USER"), "alice");
      assert.equal(env.get("RABBITMQ_DEFAULT_PASS"), "s3cret");
    } finally {
      await rabbit.stop();
    }
  });

  it("builds amqpUrl and managementUrl from credentials, host, and each mapped port", async () => {
    const backend = new FakeModuleBackend();
    const rabbit = new RabbitMQContainer().withBackend(backend).waitingFor(instantReadyWait());
    await rabbit.start();
    try {
      const amqpMapped = rabbit.getMappedPort(5672);
      const mgmtMapped = rabbit.getMappedPort(15672);
      assert.equal(rabbit.amqpUrl, `amqp://guest:guest@127.0.0.1:${amqpMapped}`);
      assert.equal(rabbit.managementUrl, `http://127.0.0.1:${mgmtMapped}`);
    } finally {
      await rabbit.stop();
    }
  });

  it("accepts a custom image tag via the constructor", async () => {
    const backend = new FakeModuleBackend();
    const rabbit = new RabbitMQContainer("rabbitmq:4.1-management-alpine").withBackend(backend).waitingFor(instantReadyWait());
    await rabbit.start();
    try {
      assert.equal(backend.lastSpec?.image, "rabbitmq:4.1-management-alpine");
    } finally {
      await rabbit.stop();
    }
  });

  it("accepts a DockerImageName instance whose repository matches", async () => {
    const backend = new FakeModuleBackend();
    const image = DockerImageName.parse("rabbitmq:4.1-management-alpine");
    const rabbit = new RabbitMQContainer(image).withBackend(backend).waitingFor(instantReadyWait());
    await rabbit.start();
    try {
      assert.equal(backend.lastSpec?.image, "rabbitmq:4.1-management-alpine");
    } finally {
      await rabbit.stop();
    }
  });

  it("throws IncompatibleImageError before start() for a mismatched repository", () => {
    try {
      new RabbitMQContainer("redis:latest");
      assert.ok(false, "expected the constructor to throw");
    } catch (err) {
      assert.ok(err instanceof IncompatibleImageError);
      assert.equal((err as IncompatibleImageError).suppliedRepository, "redis");
      assert.equal((err as IncompatibleImageError).expectedRepository, "rabbitmq");
    }
  });

  it("accepts a mismatched image explicitly marked asCompatibleSubstituteFor('rabbitmq')", async () => {
    const backend = new FakeModuleBackend();
    const substitute = DockerImageName.parse("mycorp/rabbitmq-hardened:4-management").asCompatibleSubstituteFor(
      "rabbitmq",
    );
    const rabbit = new RabbitMQContainer(substitute).withBackend(backend).waitingFor(instantReadyWait());
    await rabbit.start();
    try {
      assert.equal(backend.lastSpec?.image, "mycorp/rabbitmq-hardened:4-management");
    } finally {
      await rabbit.stop();
    }
  });
});
