import { describe, it, assert } from "../../test/harness.js";
import { PinotContainer } from "./pinot.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";

describe("PinotContainer", () => {
  it("exposes the controller (9000) and broker (8000) ports and runs QuickStart -type EMPTY", async () => {
    const backend = new FakeModuleBackend();
    const pinot = new PinotContainer().withBackend(backend).waitingFor(instantReadyWait());
    await pinot.start();
    try {
      assert.equal(backend.lastSpec?.image, "apachepinot/pinot:1.5.1");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [9000, 8000]);
      assert.deepEqual(backend.lastSpec?.command, ["QuickStart", "-type", "EMPTY"]);
    } finally {
      await pinot.stop();
    }
  });

  it("defaults to a 4096MB memory limit (the image bakes -Xmx4G)", async () => {
    const backend = new FakeModuleBackend();
    const pinot = new PinotContainer().withBackend(backend).waitingFor(instantReadyWait());
    await pinot.start();
    try {
      assert.equal(backend.lastSpec?.memoryLimitMb, 4096);
    } finally {
      await pinot.stop();
    }
  });

  it("builds controllerUrl and brokerUrl from host and their respective mapped ports", async () => {
    const backend = new FakeModuleBackend();
    const pinot = new PinotContainer().withBackend(backend).waitingFor(instantReadyWait());
    await pinot.start();
    try {
      const controllerMapped = pinot.getMappedPort(9000);
      const brokerMapped = pinot.getMappedPort(8000);
      assert.equal(pinot.controllerUrl, `http://127.0.0.1:${controllerMapped}`);
      assert.equal(pinot.brokerUrl, `http://127.0.0.1:${brokerMapped}`);
    } finally {
      await pinot.stop();
    }
  });

  it("accepts a custom image tag via the constructor", async () => {
    const backend = new FakeModuleBackend();
    const pinot = new PinotContainer("apachepinot/pinot:1.5.1-extra").withBackend(backend).waitingFor(instantReadyWait());
    await pinot.start();
    try {
      assert.equal(backend.lastSpec?.image, "apachepinot/pinot:1.5.1-extra");
    } finally {
      await pinot.stop();
    }
  });
});
