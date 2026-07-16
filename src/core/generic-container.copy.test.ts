import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert } from "../../test/harness.js";
import { GenericContainer } from "./generic-container.js";
import { RelativeContainerPathError, BackendError } from "./errors.js";
import type { WaitStrategy } from "./wait.js";
import type { BackendCapabilities, SandboxBackend, SandboxHandle, NetworkLink, ReaperKillCommand } from "./backend.js";
import type { ContainerSpec, ExecResult } from "./model.js";

function instantReady(): WaitStrategy {
  return {
    waitUntilReady: async () => {},
    withStartupTimeout(): WaitStrategy {
      return this;
    },
  };
}

const FAKE_CAPABILITIES: BackendCapabilities = { hardwareIsolated: true, checkpoint: false, checkpointRestartsWorkload: false };

interface FakeCopyBackendOptions {
  /** Scripts exec() — used to drive the mkdir -p pre-step's own success/failure. */
  execImpl?: (cmd: ReadonlyArray<string>) => Promise<ExecResult>;
}

/** A minimal fake backend recording every copy-related call it receives, so a rejected copy can be proven to have reached NONE of them. */
class FakeCopyBackend implements SandboxBackend {
  readonly name = "fake-copy-backend";
  readonly supportsNativeNetworks = true;
  readonly capabilities = FAKE_CAPABILITIES;
  readonly calls: string[] = [];
  readonly copyToContainerCalls: Array<{ hostPath: string; containerPath: string; hostContentAtCallTime: string }> = [];
  readonly copyFromContainerCalls: Array<{ containerPath: string; hostPath: string }> = [];
  private idSeq = 0;

  constructor(private readonly opts: FakeCopyBackendOptions = {}) {}

  async create(spec: ContainerSpec): Promise<SandboxHandle> {
    this.idSeq += 1;
    return { id: `fake-${this.idSeq}`, spec };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async remove(): Promise<void> {}
  async createCheckpoint(): Promise<void> {}
  async removeCheckpoint(): Promise<void> {}
  async hasCheckpoint(): Promise<boolean> {
    return false;
  }
  async removeByName(): Promise<void> {}
  async findRunning(): Promise<SandboxHandle | undefined> {
    return undefined;
  }
  async reaperKillCommand(): Promise<ReaperKillCommand> {
    return { stop: [], remove: [], removeNetwork: [] };
  }
  async exec(_handle: SandboxHandle, cmd: ReadonlyArray<string>): Promise<ExecResult> {
    this.calls.push(`exec:${cmd.join(" ")}`);
    if (this.opts.execImpl !== undefined) {
      return this.opts.execImpl(cmd);
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  async logs(): Promise<string> {
    return "";
  }
  async followLogs() {
    return { close: async (): Promise<void> => {} };
  }
  async ensureNetwork(): Promise<void> {}
  async removeNetwork(): Promise<void> {}
  async installNetworkLinks(_handle: SandboxHandle, _links: ReadonlyArray<NetworkLink>): Promise<void> {}
  async copyToContainer(_handle: SandboxHandle, hostPath: string, containerPath: string): Promise<void> {
    this.calls.push(`copyToContainer:${hostPath}:${containerPath}`);
    // Read the host file's content HERE, at call time — the content variant's
    // temp file is removed in a `finally` immediately after this method
    // returns, so a test reading `hostPath` after the fact would always find
    // it already gone.
    const hostContentAtCallTime = await fs.readFile(hostPath, "utf8").catch(() => "<unreadable>");
    this.copyToContainerCalls.push({ hostPath, containerPath, hostContentAtCallTime });
  }
  async copyFromContainer(_handle: SandboxHandle, containerPath: string, hostPath: string): Promise<void> {
    this.calls.push(`copyFromContainer:${containerPath}:${hostPath}`);
    this.copyFromContainerCalls.push({ containerPath, hostPath });
  }
  async close(): Promise<void> {}
  cleanupSync(): void {}
}

describe("GenericContainer.copyFileToContainer()", () => {
  it("not-running: throws a state error before any backend call", async () => {
    const backend = new FakeCopyBackend();
    const container = new GenericContainer("alpine:3.19").withBackend(backend);

    let thrown: unknown;
    try {
      await container.copyFileToContainer("/host/f.txt", "/guest/f.txt");
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof Error);
    assert.match((thrown as Error).message, /not running/);
    assert.deepEqual(backend.calls, [], "no backend call must have been made on a container that never started");
  });

  it("relative containerPath: throws RelativeContainerPathError before any backend call", async () => {
    const backend = new FakeCopyBackend();
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withCommand("sleep", "60").waitingFor(instantReady());
    await container.start();
    backend.calls.length = 0;

    let thrown: unknown;
    try {
      await container.copyFileToContainer("/host/f.txt", "relative/f.txt");
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof RelativeContainerPathError, `expected RelativeContainerPathError, got: ${String(thrown)}`);
    assert.equal((thrown as RelativeContainerPathError).containerPath, "relative/f.txt");
    assert.deepEqual(backend.calls, [], "no backend call (not even the mkdir -p exec) must have been made for a rejected path");

    await container.stop();
  });

  it("runs exec mkdir -p on the destination's parent before delegating to the backend's copyToContainer", async () => {
    const backend = new FakeCopyBackend();
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withCommand("sleep", "60").waitingFor(instantReady());
    await container.start();
    backend.calls.length = 0;

    await container.copyFileToContainer("/host/data.txt", "/deeply/nested/guest/data.txt");

    assert.deepEqual(backend.calls, [
      "exec:mkdir -p /deeply/nested/guest",
      "copyToContainer:/host/data.txt:/deeply/nested/guest/data.txt",
    ]);

    await container.stop();
  });

  it("a failing mkdir -p surfaces its stderr in a BackendError, and copyToContainer is never called", async () => {
    const backend = new FakeCopyBackend({
      execImpl: async () => ({ exitCode: 1, stdout: "", stderr: "mkdir: cannot create directory: read-only file system" }),
    });
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withCommand("sleep", "60").waitingFor(instantReady());
    await container.start();

    let thrown: unknown;
    try {
      await container.copyFileToContainer("/host/data.txt", "/guest/data.txt");
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof BackendError, `expected BackendError, got: ${String(thrown)}`);
    assert.match((thrown as Error).message, /read-only file system/);
    assert.equal(backend.copyToContainerCalls.length, 0, "copyToContainer must never run once mkdir -p failed");

    await container.stop();
  });
});

describe("GenericContainer.copyContentToContainer()", () => {
  it("writes content to a private temp file, copies it in, and removes it afterward regardless of outcome", async () => {
    const backend = new FakeCopyBackend();
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withCommand("sleep", "60").waitingFor(instantReady());
    await container.start();

    await container.copyContentToContainer("hello from a string", "/guest/greeting.txt");

    assert.equal(backend.copyToContainerCalls.length, 1);
    const call = backend.copyToContainerCalls[0];
    // Captured INSIDE the backend's own copyToContainer, before the content
    // variant's `finally` block ever runs — proves the backend actually saw
    // the exact content while the temp file still existed.
    assert.equal(call?.hostContentAtCallTime, "hello from a string", "expected the backend to have received the exact content");

    const tempPath = call?.hostPath as string;
    let stillExists = true;
    try {
      await fs.access(tempPath);
    } catch {
      stillExists = false;
    }
    assert.equal(stillExists, false, "expected the temp file to have been removed after the copy");

    await container.stop();
  });

  it("removes its temp file even when the underlying copy fails", async () => {
    class FailingCopyBackend extends FakeCopyBackend {
      lastAttemptedHostPath: string | undefined;
      override async copyToContainer(handle: SandboxHandle, hostPath: string, containerPath: string): Promise<void> {
        this.lastAttemptedHostPath = hostPath;
        throw new BackendError("simulated copy failure");
      }
    }
    const backend = new FailingCopyBackend();
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withCommand("sleep", "60").waitingFor(instantReady());
    await container.start();

    let thrown: unknown;
    try {
      await container.copyContentToContainer(new Uint8Array([1, 2, 3]), "/guest/bytes.bin");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof BackendError, `expected BackendError, got: ${String(thrown)}`);

    const tempPath = backend.lastAttemptedHostPath;
    assert.ok(tempPath !== undefined, "expected the backend to have been reached with a temp host path");
    let stillExists = true;
    try {
      await fs.access(tempPath as string);
    } catch {
      stillExists = false;
    }
    assert.equal(stillExists, false, "expected the temp file to have been removed even though the copy itself failed");

    await container.stop();
  });

  it("accepts Uint8Array content", async () => {
    const backend = new FakeCopyBackend();
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withCommand("sleep", "60").waitingFor(instantReady());
    await container.start();

    await container.copyContentToContainer(new Uint8Array([104, 105]), "/guest/hi.bin"); // "hi"

    assert.equal(backend.copyToContainerCalls.length, 1);

    await container.stop();
  });
});

describe("GenericContainer.copyFileFromContainer()", () => {
  it("not-running: throws a state error before any backend call", async () => {
    const backend = new FakeCopyBackend();
    const container = new GenericContainer("alpine:3.19").withBackend(backend);

    let thrown: unknown;
    try {
      await container.copyFileFromContainer("/guest/f.txt", "/host/f.txt");
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof Error);
    assert.match((thrown as Error).message, /not running/);
    assert.deepEqual(backend.calls, []);
  });

  it("relative containerPath: throws RelativeContainerPathError before any backend call", async () => {
    const backend = new FakeCopyBackend();
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withCommand("sleep", "60").waitingFor(instantReady());
    await container.start();
    backend.calls.length = 0;

    let thrown: unknown;
    try {
      await container.copyFileFromContainer("relative/f.txt", "/host/f.txt");
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof RelativeContainerPathError);
    assert.deepEqual(backend.calls, []);

    await container.stop();
  });

  it("creates the host destination's parent directory before delegating to the backend's copyFromContainer", async () => {
    const backend = new FakeCopyBackend();
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withCommand("sleep", "60").waitingFor(instantReady());
    await container.start();

    const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-copy-out-test-"));
    const hostPath = path.join(hostDir, "nested", "sub", "out.txt");

    await container.copyFileFromContainer("/guest/out.txt", hostPath);

    const parentStat = await fs.stat(path.dirname(hostPath));
    assert.ok(parentStat.isDirectory(), "expected the host parent directory to have been created");
    assert.deepEqual(backend.copyFromContainerCalls, [{ containerPath: "/guest/out.txt", hostPath }]);

    await fs.rm(hostDir, { recursive: true, force: true });
    await container.stop();
  });
});
