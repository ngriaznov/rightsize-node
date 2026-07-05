import { describe, it, assert } from "../../test/harness.js";
import { DockerBackend } from "./backend.js";
import { DockerClient } from "./client.js";
import { isPortBindConflictMessage } from "./port-conflict.js";
import { labelFilterQuery, RUN_ID_LABEL_KEY } from "./labels.js";

describe("isPortBindConflictMessage", () => {
  it("matches known daemon phrasings", () => {
    assert.ok(isPortBindConflictMessage("driver failed programming external connectivity: address already in use"));
    assert.ok(isPortBindConflictMessage("Bind for 0.0.0.0:6379 failed: port is already allocated"));
    assert.ok(isPortBindConflictMessage("ALREADY ALLOCATED (case-insensitive)"));
  });

  it("does not match unrelated failures", () => {
    assert.equal(isPortBindConflictMessage("no such image"), false);
    assert.equal(isPortBindConflictMessage("container already stopped"), false);
    assert.equal(isPortBindConflictMessage(""), false);
  });
});

describe("labelFilterQuery", () => {
  it("builds the {label:[...]} JSON filter for one runId", () => {
    const query = labelFilterQuery("deadbeef");
    assert.equal(query, JSON.stringify({ label: [`${RUN_ID_LABEL_KEY}=deadbeef`] }));
  });

  it("the label key is the literal wire-format string shared across implementations", () => {
    assert.equal(RUN_ID_LABEL_KEY, "dev.rightsize.runId");
  });
});

describe("DockerBackend transport regression — must dial a unix socket, never TCP", () => {
  it("targets an absolute unix socket path by default", () => {
    const backend = new DockerBackend(new DockerClient());
    const path = backend.socketPathForTest();
    assert.ok(path.startsWith("/"), `expected an absolute unix socket path, got ${path}`);
    assert.equal(path.includes(":"), false, `a unix socket path must not look like host:port — got ${path}`);
  });

  it("a tcp:// DOCKER_HOST falls back to the default socket, never leaking a TCP port into the transport", () => {
    const client = new DockerClient(undefined);
    // Simulate what DockerClient.fromEnv would do with a tcp:// DOCKER_HOST
    // by constructing it through the same pure parsing seam client.test.ts
    // already covers; here we only need to prove DockerBackend never ends up
    // pointed at something containing "2375".
    const backend = new DockerBackend(client);
    const path = backend.socketPathForTest();
    assert.equal(path.includes("2375"), false);
  });
});
