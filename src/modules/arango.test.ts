import { describe, it, assert } from "../../test/harness.js";
import { ArangoContainer } from "./arango.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";

describe("ArangoContainer", () => {
  it("defaults to no-auth mode and exposes port 8529", async () => {
    const backend = new FakeModuleBackend();
    const arango = new ArangoContainer().withBackend(backend).waitingFor(instantReadyWait());
    await arango.start();
    try {
      assert.equal(backend.lastSpec?.image, "arangodb:3.11");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [8529]);
      assert.deepEqual(backend.lastSpec?.env, [["ARANGO_NO_AUTH", "1"]]);
    } finally {
      await arango.stop();
    }
  });

  it("builds an http endpoint from host and mapped port", async () => {
    const backend = new FakeModuleBackend();
    const arango = new ArangoContainer().withBackend(backend).waitingFor(instantReadyWait());
    await arango.start();
    try {
      const mapped = arango.getMappedPort(8529);
      assert.equal(arango.endpoint, `http://127.0.0.1:${mapped}`);
    } finally {
      await arango.stop();
    }
  });

  it("withRootPassword swaps ARANGO_NO_AUTH for ARANGO_ROOT_PASSWORD", async () => {
    const backend = new FakeModuleBackend();
    const arango = new ArangoContainer()
      .withBackend(backend)
      .waitingFor(instantReadyWait())
      .withRootPassword("secret123");
    await arango.start();
    try {
      assert.deepEqual(backend.lastSpec?.env, [["ARANGO_ROOT_PASSWORD", "secret123"]]);
    } finally {
      await arango.stop();
    }
  });
});
