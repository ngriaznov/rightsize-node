import { describe, it, assert } from "../../test/harness.js";
import {
  UnsupportedByBackendError,
  PortBindConflictError,
  ContainerLaunchError,
  BackendError,
  ProvisionError,
  ReuseWithNetworkError,
  IsolationRequiredError,
} from "./errors.js";
import type { ContainerSpec, FileMount } from "./model.js";

// Test-only spec builder: exercises the ContainerSpec shape without pulling
// in a real backend. Defaults mirror the builder's own defaults so a caller
// only needs to override what the test cares about.
function makeSpec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: "rz-test-0",
    image: "alpine:3.19",
    env: [],
    command: undefined,
    ports: [],
    mounts: [],
    networkId: undefined,
    aliases: [],
    runId: "deadbeef",
    memoryLimitMb: undefined,
    keepAlive: false,
    checkpointRef: undefined,
    ...overrides,
  };
}

function makeMount(overrides: Partial<FileMount> = {}): FileMount {
  return {
    hostPath: "/tmp/host.txt",
    guestPath: "/guest.txt",
    readOnly: true,
    ...overrides,
  };
}

describe("UnsupportedByBackendError", () => {
  it("renders without a remedy", () => {
    const err = new UnsupportedByBackendError("network links", "microsandbox");
    assert.equal(err.message, "Feature 'network links' is not supported by the 'microsandbox' backend");
    assert.equal(err.name, "UnsupportedByBackendError");
    assert.ok(err instanceof Error);
    assert.equal(err.feature, "network links");
    assert.equal(err.backend, "microsandbox");
    assert.equal(err.remedy, undefined);
  });

  it("appends the remedy with an em-dash", () => {
    const err = new UnsupportedByBackendError("network links", "microsandbox", "run this test with RIGHTSIZE_BACKEND=docker instead");
    assert.equal(
      err.message,
      "Feature 'network links' is not supported by the 'microsandbox' backend — run this test with RIGHTSIZE_BACKEND=docker instead",
    );
  });
});

describe("PortBindConflictError", () => {
  it("is an Error with the right name", () => {
    const err = new PortBindConflictError("address already in use");
    assert.ok(err instanceof Error);
    assert.equal(err.name, "PortBindConflictError");
    assert.equal(err.message, "address already in use");
  });

  it("preserves .cause", () => {
    const cause = new Error("EADDRINUSE");
    const err = new PortBindConflictError("port bind conflict", cause);
    assert.equal(err.cause, cause);
  });

  it("leaves .cause undefined when none is given", () => {
    const err = new PortBindConflictError("port bind conflict");
    assert.equal(err.cause, undefined);
  });
});

describe("ContainerLaunchError / BackendError / ProvisionError", () => {
  it("are Errors with matching .name", () => {
    const launch = new ContainerLaunchError("timed out waiting for readiness");
    assert.ok(launch instanceof Error);
    assert.equal(launch.name, "ContainerLaunchError");

    const backend = new BackendError("daemon returned 500");
    assert.ok(backend instanceof Error);
    assert.equal(backend.name, "BackendError");

    const provision = new ProvisionError("checksum mismatch");
    assert.ok(provision instanceof Error);
    assert.equal(provision.name, "ProvisionError");
  });
});

describe("ReuseWithNetworkError", () => {
  it("is an Error with the right name and names both builder calls in its message", () => {
    const err = new ReuseWithNetworkError();
    assert.ok(err instanceof Error);
    assert.equal(err.name, "ReuseWithNetworkError");
    assert.match(err.message, /withReuse\(\)/);
    assert.match(err.message, /withNetwork\(\)/);
  });
});

describe("IsolationRequiredError", () => {
  it("is an Error with the right name, names the active backend, and gives the RIGHTSIZE_BACKEND remedy", () => {
    const err = new IsolationRequiredError("docker");
    assert.ok(err instanceof Error);
    assert.equal(err.name, "IsolationRequiredError");
    assert.equal(err.backend, "docker");
    assert.match(err.message, /withRequireIsolation\(\)/);
    assert.match(err.message, /'docker'/);
    assert.match(err.message, /RIGHTSIZE_BACKEND=microsandbox/);
  });
});

describe("ContainerSpec test-builder defaults", () => {
  it("defaults memoryLimitMb to undefined", () => {
    const spec = makeSpec();
    assert.equal(spec.memoryLimitMb, undefined);
  });

  it("defaults command to undefined (image default runs)", () => {
    const spec = makeSpec();
    assert.equal(spec.command, undefined);
  });

  it("allows overriding individual fields", () => {
    const spec = makeSpec({ image: "redis:8.6-alpine", memoryLimitMb: 512 });
    assert.equal(spec.image, "redis:8.6-alpine");
    assert.equal(spec.memoryLimitMb, 512);
    assert.equal(spec.name, "rz-test-0");
  });

  it("FileMount test-builder defaults readOnly to true", () => {
    const mount = makeMount();
    assert.equal(mount.readOnly, true);
  });
});
