import { describe, it, assert } from "../../test/harness.js";
import { GenericContainer } from "./generic-container.js";
import { IsolationRequiredError } from "./errors.js";
import type { WaitStrategy } from "./wait.js";
import type { BackendCapabilities, SandboxBackend, SandboxHandle } from "./backend.js";
import type { ContainerSpec, ExecResult } from "./model.js";

function instantReady(): WaitStrategy {
  return {
    waitUntilReady: async () => {},
    withStartupTimeout(): WaitStrategy {
      return this;
    },
  };
}

/** A minimal fake backend whose `capabilities` are set by the test, recording every call it receives so a rejected start() can be proven to have reached NONE of them. */
class FakeIsolationBackend implements SandboxBackend {
  readonly name: string;
  readonly supportsNativeNetworks = true;
  readonly capabilities: BackendCapabilities;
  readonly calls: string[] = [];
  private idSeq = 0;

  constructor(name: string, capabilities: BackendCapabilities) {
    this.name = name;
    this.capabilities = capabilities;
  }

  async create(spec: ContainerSpec): Promise<SandboxHandle> {
    this.calls.push("create");
    this.idSeq += 1;
    return { id: `fake-${this.idSeq}`, spec };
  }
  async start(): Promise<void> {
    this.calls.push("start");
  }
  async stop(): Promise<void> {
    this.calls.push("stop");
  }
  async remove(): Promise<void> {
    this.calls.push("remove");
  }
  async commitToImage(): Promise<void> {}
  async removeByName(): Promise<void> {}
  async findRunning(): Promise<SandboxHandle | undefined> {
    return undefined;
  }
  async reaperKillCommand() {
    return { stop: [], remove: [], removeNetwork: [] };
  }
  async exec(): Promise<ExecResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  async logs(): Promise<string> {
    return "";
  }
  async followLogs() {
    return { close: async (): Promise<void> => {} };
  }
  async ensureNetwork(): Promise<void> {
    this.calls.push("ensureNetwork");
  }
  async removeNetwork(): Promise<void> {}
  async installNetworkLinks(): Promise<void> {}
  async close(): Promise<void> {}
  cleanupSync(): void {}
}

describe("GenericContainer.withRequireIsolation()", () => {
  it("rejects with IsolationRequiredError before any backend call when the active backend isn't hardware-isolated", async () => {
    const backend = new FakeIsolationBackend("docker", { hardwareIsolated: false, checkpoint: true });
    const container = new GenericContainer("alpine:3.19")
      .withBackend(backend)
      .withRequireIsolation()
      .withExposedPorts(80)
      .waitingFor(instantReady());

    let thrown: unknown;
    try {
      await container.start();
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof IsolationRequiredError, `expected IsolationRequiredError, got: ${String(thrown)}`);
    assert.deepEqual(backend.calls, []);
    assert.equal(container.isRunning, false);
  });

  it("names the active backend and the RIGHTSIZE_BACKEND remedy in the error message", async () => {
    const backend = new FakeIsolationBackend("docker", { hardwareIsolated: false, checkpoint: true });
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withRequireIsolation();

    let thrown: unknown;
    try {
      await container.start();
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown instanceof IsolationRequiredError);
    const message = (thrown as IsolationRequiredError).message;
    assert.match(message, /'docker'/);
    assert.match(message, /RIGHTSIZE_BACKEND/);
    assert.equal((thrown as IsolationRequiredError).backend, "docker");
  });

  it("starts normally against a hardware-isolated backend", async () => {
    const backend = new FakeIsolationBackend("microsandbox", { hardwareIsolated: true, checkpoint: false });
    const container = new GenericContainer("alpine:3.19")
      .withBackend(backend)
      .withRequireIsolation()
      .withExposedPorts(80)
      .waitingFor(instantReady());

    await container.start();

    assert.ok(backend.calls.includes("create"));
    assert.ok(backend.calls.includes("start"));
    assert.equal(container.isRunning, true);

    await container.stop();
  });

  it("without withRequireIsolation(), a non-isolated backend is accepted as before", async () => {
    const backend = new FakeIsolationBackend("docker", { hardwareIsolated: false, checkpoint: true });
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady());

    await container.start();
    assert.equal(container.isRunning, true);

    await container.stop();
  });
});
