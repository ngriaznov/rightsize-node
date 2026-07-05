import { describe, it, assert } from "../../test/harness.js";
import { DockerBackendProvider } from "./provider.js";

describe("DockerBackendProvider", () => {
  it("name and priority are pinned", () => {
    const provider = new DockerBackendProvider();
    assert.equal(provider.name, "docker");
    assert.equal(provider.priority, 10);
  });

  it("unsupportedReason names the daemon socket", () => {
    const provider = new DockerBackendProvider();
    assert.ok(provider.unsupportedReason().toLowerCase().includes("docker"));
  });

  it("isSupported is synchronous — never returns a Promise", () => {
    const provider = new DockerBackendProvider();
    const result = provider.isSupported();
    assert.equal(typeof result, "boolean");
  });
});
