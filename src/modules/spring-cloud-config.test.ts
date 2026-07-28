import { describe, it, assert } from "../../test/harness.js";
import { SpringCloudConfigContainer } from "./spring-cloud-config.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";
import { DockerImageName } from "../core/docker-image-name.js";
import { IncompatibleImageError } from "../core/errors.js";

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

  it("accepts a DockerImageName instance whose repository matches", async () => {
    const backend = new FakeModuleBackend();
    const image = DockerImageName.parse("hyness/spring-cloud-config-server:3.1.0");
    const server = new SpringCloudConfigContainer(image).withBackend(backend).waitingFor(instantReadyWait());
    await server.start();
    try {
      assert.equal(backend.lastSpec?.image, "hyness/spring-cloud-config-server:3.1.0");
    } finally {
      await server.stop();
    }
  });

  it("throws IncompatibleImageError before start() for a mismatched repository", () => {
    try {
      new SpringCloudConfigContainer("wiremock/wiremock:latest");
      assert.ok(false, "expected the constructor to throw");
    } catch (err) {
      assert.ok(err instanceof IncompatibleImageError);
      assert.equal((err as IncompatibleImageError).suppliedRepository, "wiremock/wiremock");
      assert.equal((err as IncompatibleImageError).expectedRepository, "hyness/spring-cloud-config-server");
    }
  });

  it("accepts a mismatched image explicitly marked asCompatibleSubstituteFor('hyness/spring-cloud-config-server')", async () => {
    const backend = new FakeModuleBackend();
    const substitute = DockerImageName.parse("mycorp/spring-cloud-config-hardened:3.1").asCompatibleSubstituteFor(
      "hyness/spring-cloud-config-server",
    );
    const server = new SpringCloudConfigContainer(substitute).withBackend(backend).waitingFor(instantReadyWait());
    await server.start();
    try {
      assert.equal(backend.lastSpec?.image, "mycorp/spring-cloud-config-hardened:3.1");
    } finally {
      await server.stop();
    }
  });
});
