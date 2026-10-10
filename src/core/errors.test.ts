import { describe, it, assert } from "../../test/harness.js";
import {
  UnsupportedByBackendError,
  PortBindConflictError,
  ContainerLaunchError,
  BackendError,
  ProvisionError,
  ReuseWithNetworkError,
  IsolationRequiredError,
  IncompatibleImageError,
  RootDiskConflictError,
  TmpfsRootExceedsMemoryError,
  NetworkDisabledConflictError,
  TmpfsRootCheckpointError,
  CheckpointWorkloadCommandMissingError,
  CheckpointHostFileMissingError,
  CheckpointMissingCopiedFilesError,
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
    diskLimitMb: undefined,
    tmpfsRootMb: undefined,
    networkDisabled: false,
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

describe("IncompatibleImageError", () => {
  it("is an Error with the right name, names both repositories, and gives the asCompatibleSubstituteFor remedy", () => {
    const err = new IncompatibleImageError("mysql", "postgres");
    assert.ok(err instanceof Error);
    assert.equal(err.name, "IncompatibleImageError");
    assert.equal(err.suppliedRepository, "mysql");
    assert.equal(err.expectedRepository, "postgres");
    assert.match(err.message, /'mysql'/);
    assert.match(err.message, /'postgres'/);
    assert.match(err.message, /asCompatibleSubstituteFor\("postgres"\)/);
  });
});

describe("RootDiskConflictError", () => {
  it("is an Error with the right name and names both builder calls in its message", () => {
    const err = new RootDiskConflictError();
    assert.ok(err instanceof Error);
    assert.equal(err.name, "RootDiskConflictError");
    assert.match(err.message, /withDiskLimit\(\)/);
    assert.match(err.message, /withTmpfsRoot\(\)/);
  });
});

describe("TmpfsRootExceedsMemoryError", () => {
  it("is an Error with the right name, carries both values, and names both builder calls in its message", () => {
    const err = new TmpfsRootExceedsMemoryError(1024, 512);
    assert.ok(err instanceof Error);
    assert.equal(err.name, "TmpfsRootExceedsMemoryError");
    assert.equal(err.tmpfsMb, 1024);
    assert.equal(err.memoryMb, 512);
    assert.match(err.message, /withTmpfsRoot\(1024\)/);
    assert.match(err.message, /withMemoryLimit\(512\)/);
  });
});

describe("NetworkDisabledConflictError", () => {
  it("is an Error with the right name and names both builder calls in its message", () => {
    const err = new NetworkDisabledConflictError();
    assert.ok(err instanceof Error);
    assert.equal(err.name, "NetworkDisabledConflictError");
    assert.match(err.message, /withNetworkDisabled\(\)/);
    assert.match(err.message, /withNetwork\(\)/);
  });
});

describe("TmpfsRootCheckpointError", () => {
  it("is an Error with the right name and names withTmpfsRoot in its message", () => {
    const err = new TmpfsRootCheckpointError();
    assert.ok(err instanceof Error);
    assert.equal(err.name, "TmpfsRootCheckpointError");
    assert.match(err.message, /withTmpfsRoot/);
  });
});

describe("CheckpointWorkloadCommandMissingError", () => {
  it("is an Error with the right name, carries the ref, and names it in the message", () => {
    const err = new CheckpointWorkloadCommandMissingError("/cache/checkpoints/rz-source-1/snap_deadbeef");
    assert.ok(err instanceof Error);
    assert.equal(err.name, "CheckpointWorkloadCommandMissingError");
    assert.equal(err.ref, "/cache/checkpoints/rz-source-1/snap_deadbeef");
    assert.match(err.message, /rz-source-1\/snap_deadbeef/);
    assert.match(err.message, /predates workload-cmdline capture/);
  });
});

describe("CheckpointHostFileMissingError", () => {
  it("is an Error with the right name, carries both paths, and says copied files are not part of a checkpoint", () => {
    const err = new CheckpointHostFileMissingError("/etc/app/a.conf", "/tmp/gone/a.conf");
    assert.ok(err instanceof Error);
    assert.equal(err.name, "CheckpointHostFileMissingError");
    assert.equal(err.guestPath, "/etc/app/a.conf");
    assert.equal(err.hostPath, "/tmp/gone/a.conf");
    assert.equal(
      err.message,
      "checkpoint() can't keep the copied file at /etc/app/a.conf: its host file /tmp/gone/a.conf no longer exists. " +
        "Copied files are not part of a checkpoint; on microsandbox, checkpoint() mounts them again from their " +
        "host files when it reboots the container.",
    );
  });
});

describe("CheckpointMissingCopiedFilesError", () => {
  const output =
    "error: invalid config: restore requires destination bindings for: mount /etc/app/b.conf; provide a destination mount for each path or explicitly allow missing resources";

  it("is an Error with the right name and carries the sandbox, the ref and msb's output", () => {
    const err = new CheckpointMissingCopiedFilesError("rz-abc12345-3", "/cache/checkpoints/rz-src-1/snap_deadbeef", output);
    assert.ok(err instanceof Error);
    assert.equal(err.name, "CheckpointMissingCopiedFilesError");
    assert.equal(err.sandbox, "rz-abc12345-3");
    assert.equal(err.ref, "/cache/checkpoints/rz-src-1/snap_deadbeef");
    assert.equal(err.output, output);
  });

  it("names the sandbox and the ref, says copied files are not part of a checkpoint, and points at withCopyFileToContainer on the container started from it", () => {
    const err = new CheckpointMissingCopiedFilesError("rz-abc12345-3", "/cache/checkpoints/rz-src-1/snap_deadbeef", output);
    assert.match(err.message, /rz-abc12345-3/);
    assert.match(err.message, /\/cache\/checkpoints\/rz-src-1\/snap_deadbeef/);
    assert.match(err.message, /copied files are not part of a checkpoint/);
    assert.match(err.message, /fromCheckpoint\(cp\)\.withCopyFileToContainer\(/);
    assert.match(err.message, /same guest paths/);
  });

  it("includes msb's output, which lists the missing guest paths", () => {
    const err = new CheckpointMissingCopiedFilesError("rz-abc12345-3", "/snap", output);
    assert.ok(err.message.endsWith(output));
    assert.match(err.message, /mount \/etc\/app\/b\.conf/);
  });

  it("claims nothing was removed: a plain fromCheckpoint().start() has no removed sandbox to mention", () => {
    const err = new CheckpointMissingCopiedFilesError("rz-abc12345-3", "/snap", output);
    assert.ok(!/was removed|removed after|re-booting/i.test(err.message));
  });

  it("avoids the phrases start()'s port-conflict retry matches on, so a start() that throws it is never retried", () => {
    const err = new CheckpointMissingCopiedFilesError("rz-abc12345-3", "/snap", output);
    const lower = err.message.toLowerCase();
    assert.ok(!lower.includes("address already in use"));
    assert.ok(!lower.includes("already allocated"));
  });
});

describe("BackendError", () => {
  it("keeps the error it wraps as its cause, and has none when constructed without one", () => {
    const inner = new CheckpointHostFileMissingError("/g", "/h");
    const wrapped = new BackendError("outer", inner);
    assert.equal(wrapped.cause, inner);
    assert.equal(new BackendError("plain").cause, undefined);
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

  it("defaults diskLimitMb, tmpfsRootMb, and networkDisabled to their unset values", () => {
    const spec = makeSpec();
    assert.equal(spec.diskLimitMb, undefined);
    assert.equal(spec.tmpfsRootMb, undefined);
    assert.equal(spec.networkDisabled, false);
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
