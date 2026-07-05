import { describe, it, assert } from "../../test/harness.js";
import { SpringCloudConfigContainer } from "./spring-cloud-config.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";

describe("SpringCloudConfigContainer", () => {
  it("exposes port 8888 and defaults to a 1024MB memory limit", async () => {
    const backend = new FakeModuleBackend();
    const server = new SpringCloudConfigContainer().withBackend(backend).waitingFor(instantReadyWait());
    await server.start();
    try {
      assert.equal(backend.lastSpec?.image, "hyness/spring-cloud-config-server:latest");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [8888]);
      assert.equal(backend.lastSpec?.memoryLimitMb, 1024);
    } finally {
      await server.stop();
    }
  });

  it("builds a uri from host and mapped port", async () => {
    const backend = new FakeModuleBackend();
    const server = new SpringCloudConfigContainer().withBackend(backend).waitingFor(instantReadyWait());
    await server.start();
    try {
      assert.equal(server.uri, `http://127.0.0.1:${server.getMappedPort(8888)}`);
    } finally {
      await server.stop();
    }
  });

  it("accepts a custom image tag via the constructor", async () => {
    const backend = new FakeModuleBackend();
    const server = new SpringCloudConfigContainer("hyness/spring-cloud-config-server:3.1.0")
      .withBackend(backend)
      .waitingFor(instantReadyWait());
    await server.start();
    try {
      assert.equal(backend.lastSpec?.image, "hyness/spring-cloud-config-server:3.1.0");
    } finally {
      await server.stop();
    }
  });
});
