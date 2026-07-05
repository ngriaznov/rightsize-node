import { describe, it, assert } from "../../test/harness.js";
import { RedpandaContainer } from "./redpanda.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";

describe("RedpandaContainer", () => {
  it("exposes 9092/9093/8081 and pins a versioned image tag", async () => {
    const backend = new FakeModuleBackend();
    const rp = new RedpandaContainer().withBackend(backend).waitingFor(instantReadyWait());
    await rp.start();
    try {
      assert.equal(backend.lastSpec?.image, "redpandadata/redpanda:v24.2.4");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [9092, 9093, 8081]);
    } finally {
      await rp.stop();
    }
  });

  it("customizeSpec rewrites command with the mapped EXTERNAL port and the fixed INTERNAL alias", async () => {
    const backend = new FakeModuleBackend();
    const rp = new RedpandaContainer().withBackend(backend).waitingFor(instantReadyWait());
    await rp.start();
    try {
      const mappedExternal = rp.getMappedPort(9092);
      const command = backend.lastSpec?.command ?? [];
      const joined = command.join(" ");
      assert.match(joined, /--advertise-kafka-addr/);
      assert.ok(
        joined.includes(`EXTERNAL://127.0.0.1:${mappedExternal}`),
        `expected EXTERNAL advertised addr to carry the mapped port ${mappedExternal}, got: ${joined}`,
      );
      assert.ok(joined.includes("INTERNAL://redpanda:9093"), `expected the fixed INTERNAL alias, got: ${joined}`);
      assert.ok(joined.includes("--schema-registry-addr 0.0.0.0:8081"));
    } finally {
      await rp.stop();
    }
  });

  it("builds bootstrapServers and schemaRegistryUrl from host and mapped ports", async () => {
    const backend = new FakeModuleBackend();
    const rp = new RedpandaContainer().withBackend(backend).waitingFor(instantReadyWait());
    await rp.start();
    try {
      assert.equal(rp.bootstrapServers, `PLAINTEXT://127.0.0.1:${rp.getMappedPort(9092)}`);
      assert.equal(rp.schemaRegistryUrl, `http://127.0.0.1:${rp.getMappedPort(8081)}`);
    } finally {
      await rp.stop();
    }
  });
});
