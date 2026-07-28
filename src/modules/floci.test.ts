import { describe, it, assert } from "../../test/harness.js";
import { FlociContainer } from "./floci.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";
import { DockerImageName } from "../core/docker-image-name.js";
import { IncompatibleImageError } from "../core/errors.js";

describe("FlociContainer", () => {
  it("aws() defaults to floci/floci:latest and port 4566", async () => {
    const backend = new FakeModuleBackend();
    const floci = FlociContainer.aws().withBackend(backend).waitingFor(instantReadyWait());
    await floci.start();
    try {
      assert.equal(backend.lastSpec?.image, "floci/floci:latest");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [4566]);
    } finally {
      await floci.stop();
    }
  });

  it("azure() defaults to floci/floci-az:latest and port 4577", async () => {
    const backend = new FakeModuleBackend();
    const floci = FlociContainer.azure().withBackend(backend).waitingFor(instantReadyWait());
    await floci.start();
    try {
      assert.equal(backend.lastSpec?.image, "floci/floci-az:latest");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [4577]);
    } finally {
      await floci.stop();
    }
  });

  it("gcp() defaults to floci/floci-gcp:latest and port 4588", async () => {
    const backend = new FakeModuleBackend();
    const floci = FlociContainer.gcp().withBackend(backend).waitingFor(instantReadyWait());
    await floci.start();
    try {
      assert.equal(backend.lastSpec?.image, "floci/floci-gcp:latest");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [4588]);
    } finally {
      await floci.stop();
    }
  });

  it("builds endpointUrl from host and this variant's mapped port", async () => {
    const backend = new FakeModuleBackend();
    const floci = FlociContainer.aws().withBackend(backend).waitingFor(instantReadyWait());
    await floci.start();
    try {
      const mapped = floci.getMappedPort(4566);
      assert.equal(floci.endpointUrl, `http://127.0.0.1:${mapped}`);
    } finally {
      await floci.stop();
    }
  });

  it("each factory accepts a custom image tag", async () => {
    const backend = new FakeModuleBackend();
    const floci = FlociContainer.aws("floci/floci:1.5.31").withBackend(backend).waitingFor(instantReadyWait());
    await floci.start();
    try {
      assert.equal(backend.lastSpec?.image, "floci/floci:1.5.31");
    } finally {
      await floci.stop();
    }
  });

  it("each factory accepts a DockerImageName instance whose repository matches", async () => {
    const backend = new FakeModuleBackend();
    const image = DockerImageName.parse("floci/floci-az:0.8.1");
    const floci = FlociContainer.azure(image).withBackend(backend).waitingFor(instantReadyWait());
    await floci.start();
    try {
      assert.equal(backend.lastSpec?.image, "floci/floci-az:0.8.1");
    } finally {
      await floci.stop();
    }
  });

  it("aws() throws IncompatibleImageError for an image meant for a different variant", () => {
    try {
      FlociContainer.aws("floci/floci-az:0.8.0");
      assert.ok(false, "expected aws() to throw");
    } catch (err) {
      assert.ok(err instanceof IncompatibleImageError);
      assert.equal((err as IncompatibleImageError).suppliedRepository, "floci/floci-az");
      assert.equal((err as IncompatibleImageError).expectedRepository, "floci/floci");
    }
  });

  it("azure() throws IncompatibleImageError for an image meant for a different variant", () => {
    try {
      FlociContainer.azure("floci/floci-gcp:0.4.0");
      assert.ok(false, "expected azure() to throw");
    } catch (err) {
      assert.ok(err instanceof IncompatibleImageError);
      assert.equal((err as IncompatibleImageError).suppliedRepository, "floci/floci-gcp");
      assert.equal((err as IncompatibleImageError).expectedRepository, "floci/floci-az");
    }
  });

  it("gcp() throws IncompatibleImageError for an image meant for a different variant", () => {
    try {
      FlociContainer.gcp("floci/floci:1.5.30");
      assert.ok(false, "expected gcp() to throw");
    } catch (err) {
      assert.ok(err instanceof IncompatibleImageError);
      assert.equal((err as IncompatibleImageError).suppliedRepository, "floci/floci");
      assert.equal((err as IncompatibleImageError).expectedRepository, "floci/floci-gcp");
    }
  });

  it("aws() accepts a mismatched image explicitly marked asCompatibleSubstituteFor('floci/floci')", async () => {
    const backend = new FakeModuleBackend();
    const substitute = DockerImageName.parse("mycorp/floci-hardened:1.5").asCompatibleSubstituteFor("floci/floci");
    const floci = FlociContainer.aws(substitute).withBackend(backend).waitingFor(instantReadyWait());
    await floci.start();
    try {
      assert.equal(backend.lastSpec?.image, "mycorp/floci-hardened:1.5");
    } finally {
      await floci.stop();
    }
  });
});
