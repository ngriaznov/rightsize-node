import { describe, it, assert } from "../../test/harness.js";
import { WireMockContainer } from "./wiremock.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";

describe("WireMockContainer", () => {
  it("exposes port 8080", async () => {
    const backend = new FakeModuleBackend();
    const wiremock = new WireMockContainer().withBackend(backend).waitingFor(instantReadyWait());
    await wiremock.start();
    try {
      assert.equal(backend.lastSpec?.image, "wiremock/wiremock:3.13.2");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [8080]);
    } finally {
      await wiremock.stop();
    }
  });

  it("builds baseUrl and adminUrl from host and the mapped port", async () => {
    const backend = new FakeModuleBackend();
    const wiremock = new WireMockContainer().withBackend(backend).waitingFor(instantReadyWait());
    await wiremock.start();
    try {
      const mapped = wiremock.getMappedPort(8080);
      assert.equal(wiremock.baseUrl, `http://127.0.0.1:${mapped}`);
      assert.equal(wiremock.adminUrl, `http://127.0.0.1:${mapped}/__admin`);
    } finally {
      await wiremock.stop();
    }
  });

  it("accepts a custom image tag via the constructor", async () => {
    const backend = new FakeModuleBackend();
    const wiremock = new WireMockContainer("wiremock/wiremock:3.13.2-alpine").withBackend(backend).waitingFor(instantReadyWait());
    await wiremock.start();
    try {
      assert.equal(backend.lastSpec?.image, "wiremock/wiremock:3.13.2-alpine");
    } finally {
      await wiremock.stop();
    }
  });
});
