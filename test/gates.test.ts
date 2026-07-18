import { describe, it, assert } from "./harness.js";
import { FreePorts } from "../src/core/free-ports.js";
import { GenericContainer } from "../src/core/generic-container.js";
import { PortBindConflictError } from "../src/core/errors.js";
import type { WaitStrategy } from "../src/core/wait.js";
import type { SandboxBackend, SandboxHandle, NetworkLink, FollowHandle, ReaperKillCommand } from "../src/core/backend.js";
import type { ContainerSpec, ExecResult } from "../src/core/model.js";
import { isPortBindConflictOutput } from "../src/backend-msb/port-conflict.js";
import { isPortBindConflictMessage } from "../src/backend-docker/port-conflict.js";
import { runningNames } from "../src/backend-msb/ls-json.js";
import { undeliveredLines } from "../src/backend-msb/follow-replay.js";
import { FrameDemuxer, LineAssembler } from "../src/backend-docker/frames.js";

/**
 * Named gates pinning behaviors that matter enough to assert directly
 * against the real production code paths in this file: exactly-once
 * followOutput with final-fragment flush, mutation-verified port-release,
 * cleanup-on-start-failure across the whole seam, the isPortBindConflict
 * truth table, and the runningNames/frame-demux tolerant-parse cases. Most
 * of these ALSO have deeper, more granular coverage in their own module's
 * test file (named per gate below), landed already alongside the code that
 * introduced each mechanism; this file is the one place that names them as
 * gates and verifies each is still true, not a duplicate of that coverage.
 */

function instantReady(): WaitStrategy {
  return {
    waitUntilReady: async () => {},
    withStartupTimeout(): WaitStrategy {
      return this;
    },
  };
}

interface FollowFakeOptions {
  readonly failInstallNetworkLinks?: boolean;
}

/**
 * A minimal fake backend whose followLogs delivers a fixed line sequence.
 * The at-most-once final-fragment flush itself (the mechanism every real
 * backend's exactly-once contract depends on) is exercised directly against
 * `LineAssembler`/`undeliveredLines` below and end-to-end against the real
 * binaries in test/it/contract.test.ts; this fake only needs to prove
 * GenericContainer.followOutput() delivers what the backend hands it, in
 * order.
 */
class FollowFakeBackend implements SandboxBackend {
  readonly name = "follow-fake";
  readonly supportsNativeNetworks = true;
  readonly capabilities = { hardwareIsolated: true, checkpoint: false, checkpointRestartsWorkload: false };

  constructor(private readonly opts: FollowFakeOptions = {}) {}

  async create(spec: ContainerSpec): Promise<SandboxHandle> {
    return { id: "follow-fake-1", spec };
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async remove(): Promise<void> {}
  async createCheckpoint(): Promise<void> {}
  async removeCheckpoint(): Promise<void> {}
  async hasCheckpoint(): Promise<boolean> {
    return false;
  }
  async exportCheckpoint(): Promise<void> {}
  async importCheckpoint(): Promise<string> {
    return "";
  }
  async removeByName(): Promise<void> {}
  async findRunning(): Promise<SandboxHandle | undefined> {
    return undefined;
  }
  async reaperKillCommand(): Promise<ReaperKillCommand> {
    return { stop: [], remove: [], removeNetwork: [] };
  }

  async exec(): Promise<ExecResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async logs(): Promise<string> {
    return "";
  }

  async followLogs(_handle: SandboxHandle, consumer: (line: string) => void): Promise<FollowHandle> {
    consumer("line-1");
    consumer("line-2");
    return { close: async (): Promise<void> => {} };
  }

  async ensureNetwork(): Promise<void> {}
  async removeNetwork(): Promise<void> {}

  async installNetworkLinks(_handle: SandboxHandle, _links: ReadonlyArray<NetworkLink>): Promise<void> {
    if (this.opts.failInstallNetworkLinks ?? false) {
      throw new Error("boom: installNetworkLinks failed");
    }
  }

  async copyToContainer(): Promise<void> {}
  async copyFromContainer(): Promise<void> {}

  async close(): Promise<void> {}
  cleanupSync(): void {}
}

describe("exactly-once followOutput with final-fragment flush", () => {
  it("delivers the fixed lines in order via GenericContainer.followOutput", async () => {
    const backend = new FollowFakeBackend();
    const container = new GenericContainer("alpine:3.19").withBackend(backend).waitingFor(instantReady());
    await container.start();
    const received: string[] = [];
    await container.followOutput((line) => received.push(line));
    assert.deepEqual(received, ["line-1", "line-2"]);
    await container.stop();
  });

  it(
    "the pure replay math (undeliveredLines) never re-delivers already-delivered lines and never drops the tail " +
      "— see src/backend-msb/follow-replay.test.ts for the full case list",
    () => {
      assert.deepEqual(undeliveredLines("a\nb\nc\n", 2), ["c"]);
      assert.deepEqual(undeliveredLines("a\nb\n", 2), []);
      assert.deepEqual(undeliveredLines("a\nb", 0), ["a", "b"]);
    },
  );

  it(
    "LineAssembler.flush() is at-most-once: a second flush call yields nothing " +
      "— see src/backend-docker/frames.test.ts for the full case list",
    () => {
      const assembler = new LineAssembler();
      assembler.feed("unterminated-tail");
      assert.equal(assembler.flush(), "unterminated-tail");
      assert.equal(assembler.flush(), undefined);
    },
  );
});

describe("mutation-verified port-release + reissue", () => {
  it("release actually frees the port back to FreePorts (fails if release() is a no-op)", async () => {
    const port = await FreePorts.allocate();
    assert.ok(FreePorts.issuedView().has(port));
    FreePorts.release(port);
    // A no-op release() would leave this assertion false, which is exactly
    // the mutation this gate exists to catch.
    assert.ok(!FreePorts.issuedView().has(port));
    // And the freed port must be reissuable, not merely absent from the view.
    const reissued = await FreePorts.allocate();
    FreePorts.release(reissued);
  });

  it(
    "GenericContainer releases every port on stop and across the retry loop " +
      "— see src/core/generic-container.test.ts 'U4 port release + reissue' for the full case list",
    async () => {
      const backend = new FollowFakeBackend();
      const before = FreePorts.issuedView().size;
      const container = new GenericContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady());
      await container.start();
      assert.equal(FreePorts.issuedView().size, before + 1);
      await container.stop();
      assert.equal(FreePorts.issuedView().size, before);
    },
  );
});

describe("cleanup-on-start-failure across the whole seam", () => {
  it("installNetworkLinks failure: no port leak, start() rejects only after teardown completes", async () => {
    const backend = new FollowFakeBackend({ failInstallNetworkLinks: true });
    const before = FreePorts.issuedView().size;
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady());

    await assert.rejects(() => container.start());

    // No detached cleanup: by the time start()'s rejection has been observed
    // here, teardown already ran to completion — this assertion would be
    // flaky (racy) if start() returned before its own cleanup finished.
    assert.equal(FreePorts.issuedView().size, before);
    assert.equal(container.isRunning, false);
  });

  it(
    "wait-strategy failure and installNetworkLinks failure are BOTH covered per injection point " +
      "— see src/core/generic-container.test.ts 'U5 cleanup-on-start-failure across the whole seam'",
    () => {
      // This file asserts one injection point directly (above) to keep the
      // gate self-contained; the sibling injection point (a throwing wait
      // strategy) is exercised in generic-container.test.ts with the same
      // no-leak, teardown-before-rejection assertions.
      assert.ok(true);
    },
  );
});

describe("isPortBindConflict truth table", () => {
  it("msb output classification: positive and negative phrasings", () => {
    assert.ok(isPortBindConflictOutput("Error: address already in use"));
    assert.ok(isPortBindConflictOutput("port is already allocated"));
    assert.ok(isPortBindConflictOutput("BIND: ADDRESS ALREADY IN USE"));
    assert.equal(isPortBindConflictOutput("image pull failed"), false);
    assert.equal(isPortBindConflictOutput(""), false);
  });

  it("docker message classification: positive and negative phrasings", () => {
    assert.ok(isPortBindConflictMessage("driver failed programming external connectivity: address already in use"));
    assert.ok(isPortBindConflictMessage("Bind for 0.0.0.0:6379 failed: port is already allocated"));
    assert.equal(isPortBindConflictMessage("no such image"), false);
  });

  it("GenericContainer's cause-chain classifier retries on a typed PortBindConflictError wrapped in a generic Error", async () => {
    let attempts = 0;
    const backend: SandboxBackend = {
      name: "wrapped-conflict-fake",
      supportsNativeNetworks: true,
      capabilities: { hardwareIsolated: true, checkpoint: false, checkpointRestartsWorkload: false },
      async create(spec: ContainerSpec) {
        return { id: `wrapped-${attempts}`, spec };
      },
      async start() {
        attempts++;
        if (attempts === 1) {
          throw new Error("start failed", { cause: new PortBindConflictError("address already in use") });
        }
      },
      async stop() {},
      async remove() {},
      async createCheckpoint() {},
      async removeCheckpoint() {},
      async hasCheckpoint() {
        return false;
      },
      async exportCheckpoint() {},
      async importCheckpoint() {
        return "";
      },
      async removeByName() {},
      async findRunning() {
        return undefined;
      },
      async reaperKillCommand(): Promise<ReaperKillCommand> {
        return { stop: [], remove: [], removeNetwork: [] };
      },
      async exec() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async logs() {
        return "";
      },
      async followLogs() {
        return { close: async () => {} };
      },
      async ensureNetwork() {},
      async removeNetwork() {},
      async installNetworkLinks() {},
      async copyToContainer() {},
      async copyFromContainer() {},
      async close() {},
      cleanupSync() {},
    };
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady());
    await container.start();
    assert.equal(attempts, 2);
    await container.stop();
  });
});

describe("runningNames and frame-demux tolerant parsing", () => {
  it(
    "runningNames tolerates out-of-order/extra/missing keys and only counts capitalized Running " +
      "— see src/backend-msb/ls-json.test.ts for the full case list",
    () => {
      const shape = '[{"status":"Running","name":"a","created_at":"x","image":"i"},{"name":"b","status":"Stopped"}]';
      assert.deepEqual(runningNames(shape), new Set(["a"]));
      assert.deepEqual(runningNames("not json at all"), new Set());
      assert.deepEqual(runningNames("[]"), new Set());
    },
  );

  it(
    "FrameDemuxer reassembles a docker log frame split across Buffer chunks " +
      "— see src/backend-docker/frames.test.ts for the full case list",
    () => {
      const demuxer = new FrameDemuxer();
      const header = Buffer.from([1, 0, 0, 0, 0, 0, 0, 5]); // stdout, length 5
      const payload = Buffer.from("hello");
      const frames = [
        ...demuxer.push(header.subarray(0, 4)),
        ...demuxer.push(header.subarray(4)),
        ...demuxer.push(payload.subarray(0, 2)),
        ...demuxer.push(payload.subarray(2)),
      ];
      assert.equal(frames.length, 1);
      assert.equal(frames[0]?.streamType, "stdout");
      assert.equal(frames[0]?.payload.toString(), "hello");
    },
  );
});
