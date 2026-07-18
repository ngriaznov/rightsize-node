import type {
  SandboxBackend,
  SandboxHandle,
  NetworkLink,
  FollowHandle,
  ReaperKillCommand,
} from "../core/backend.js";
import type { ContainerSpec, ExecResult } from "../core/model.js";

/**
 * A minimal in-memory `SandboxBackend` for module unit tests: it never
 * spawns a real process, so it proves builder-to-`ContainerSpec` plumbing
 * (env, ports, command, memory limit) and accessor shapes without a runtime.
 * Real round-trips against a live container are the module's `.it.test.ts`
 * counterpart, gated behind `RIGHTSIZE_IT=1`.
 */
export class FakeModuleBackend implements SandboxBackend {
  readonly name: string = "fake-module-backend";
  readonly supportsNativeNetworks = true;
  readonly capabilities = { hardwareIsolated: true, checkpoint: false, checkpointRestartsWorkload: false };
  private idSeq = 0;
  lastSpec: ContainerSpec | undefined;
  /** Test seam: scripts exec() responses for modules whose containerIsStarted hook polls via exec (e.g. Mongo's rs.initiate). */
  execImpl: ((cmd: ReadonlyArray<string>) => Promise<ExecResult>) | undefined;

  async create(spec: ContainerSpec): Promise<SandboxHandle> {
    this.idSeq += 1;
    this.lastSpec = spec;
    return { id: `fake-${this.idSeq}`, spec };
  }

  async start(_handle: SandboxHandle): Promise<void> {}
  async stop(_handle: SandboxHandle): Promise<void> {}
  async remove(_handle: SandboxHandle): Promise<void> {}
  async createCheckpoint(_handle: SandboxHandle, _ref: string): Promise<void> {}
  async removeCheckpoint(_ref: string): Promise<void> {}
  async hasCheckpoint(_ref: string): Promise<boolean> {
    return false;
  }
  async exportCheckpoint(_ref: string, _destFile: string): Promise<void> {}
  async importCheckpoint(_srcFile: string, _ref: string): Promise<string> {
    return "";
  }
  async removeByName(_name: string): Promise<void> {}
  async findRunning(_spec: ContainerSpec): Promise<SandboxHandle | undefined> {
    return undefined;
  }
  async reaperKillCommand(): Promise<ReaperKillCommand> {
    return { stop: [], remove: [], removeNetwork: [] };
  }

  async exec(_handle: SandboxHandle, cmd: ReadonlyArray<string>): Promise<ExecResult> {
    if (this.execImpl !== undefined) {
      return this.execImpl(cmd);
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async logs(_handle: SandboxHandle): Promise<string> {
    return "";
  }

  async followLogs(): Promise<FollowHandle> {
    return { close: async () => {} };
  }

  async ensureNetwork(_networkId: string): Promise<void> {}
  async removeNetwork(_networkId: string): Promise<void> {}

  async installNetworkLinks(_handle: SandboxHandle, _links: ReadonlyArray<NetworkLink>): Promise<void> {}

  async copyToContainer(_handle: SandboxHandle, _hostPath: string, _containerPath: string): Promise<void> {}
  async copyFromContainer(_handle: SandboxHandle, _containerPath: string, _hostPath: string): Promise<void> {}

  async close(): Promise<void> {}

  cleanupSync(_id: string): void {}
}

/** Always-ready wait strategy: module builder/spec unit tests don't boot a real workload. */
export function instantReadyWait(): import("../core/wait.js").WaitStrategy {
  return {
    waitUntilReady: async () => {},
    withStartupTimeout(): import("../core/wait.js").WaitStrategy {
      return this;
    },
  };
}
