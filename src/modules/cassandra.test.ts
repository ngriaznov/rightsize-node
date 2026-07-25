import { describe, it, assert } from "../../test/harness.js";
import { CassandraContainer } from "./cassandra.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";

describe("CassandraContainer", () => {
  it("exposes 9042, overrides GPG_KEYS, sets the heap env, and raises the memory ceiling to 2560", async () => {
    const backend = new FakeModuleBackend();
    const cassandra = new CassandraContainer().withBackend(backend).waitingFor(instantReadyWait());
    await cassandra.start();
    try {
      assert.equal(backend.lastSpec?.image, "cassandra:5.0.8");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [9042]);
      assert.equal(backend.lastSpec?.memoryLimitMb, 2560);
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("GPG_KEYS"), "");
      assert.equal(env.get("MAX_HEAP_SIZE"), "512M");
      assert.equal(env.get("HEAP_NEWSIZE"), "128M");
    } finally {
      await cassandra.stop();
    }
  });

  it("builds contactPoint/cqlPort from host and the mapped port, and localDatacenter is datacenter1", async () => {
    const backend = new FakeModuleBackend();
    const cassandra = new CassandraContainer().withBackend(backend).waitingFor(instantReadyWait());
    await cassandra.start();
    try {
      const mapped = cassandra.getMappedPort(9042);
      assert.equal(cassandra.contactPoint, `127.0.0.1:${mapped}`);
      assert.equal(cassandra.cqlPort, mapped);
      assert.equal(cassandra.localDatacenter, "datacenter1");
    } finally {
      await cassandra.stop();
    }
  });

  it("accepts a custom image tag via the constructor", async () => {
    const backend = new FakeModuleBackend();
    const cassandra = new CassandraContainer("cassandra:5.0.9").withBackend(backend).waitingFor(instantReadyWait());
    await cassandra.start();
    try {
      assert.equal(backend.lastSpec?.image, "cassandra:5.0.9");
    } finally {
      await cassandra.stop();
    }
  });
});
