import { describe, it, assert } from "../../test/harness.js";
import { FlociContainer } from "./floci.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";

describe("FlociContainer", () => {
  it("aws() picks floci/floci:1.5.30 and port 4566", async () => {
    const backend = new FakeModuleBackend();
    const floci = FlociContainer.aws().withBackend(backend).waitingFor(instantReadyWait());
    await floci.start();
    try {
      assert.equal(backend.lastSpec?.image, "floci/floci:1.5.30");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [4566]);
    } finally {
      await floci.stop();
    }
  });

  it("azure() picks floci/floci-az:0.8.0 and port 4577", async () => {
    const backend = new FakeModuleBackend();
    const floci = FlociContainer.azure().withBackend(backend).waitingFor(instantReadyWait());
    await floci.start();
    try {
      assert.equal(backend.lastSpec?.image, "floci/floci-az:0.8.0");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [4577]);
    } finally {
      await floci.stop();
    }
  });

  it("gcp() picks floci/floci-gcp:0.4.0 and port 4588", async () => {
    const backend = new FakeModuleBackend();
    const floci = FlociContainer.gcp().withBackend(backend).waitingFor(instantReadyWait());
    await floci.start();
    try {
      assert.equal(backend.lastSpec?.image, "floci/floci-gcp:0.4.0");
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
});
