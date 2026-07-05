import { describe, it, assert } from "../../test/harness.js";
import { GenericContainer } from "./generic-container.js";
import { Network } from "./network.js";
import type { WaitStrategy } from "./wait.js";
import { PortBindConflictError } from "./errors.js";
import { FreePorts } from "./free-ports.js";
import type { SandboxBackend, SandboxHandle, NetworkLink } from "./backend.js";
import type { ExecResult } from "./model.js";
import { _runAllForTests as runAllRegisteredCleanupsForTest } from "./cleanup.js";

interface FakeBackendOptions {
  startFailuresBeforeSuccess?: number;
  startFailureIsPortConflict?: boolean;
  failInstallNetworkLinks?: boolean;
  failNonConflictOnAttempt?: number;
}

interface FakeCall {
  readonly op: "create" | "start" | "stop" | "remove" | "installNetworkLinks" | "ensureNetwork";
  readonly handleId?: string;
}

class FakeBackend implements SandboxBackend {
  readonly name = "fake";
  readonly supportsNativeNetworks = true;
  readonly calls: FakeCall[] = [];
  readonly createdHandles: SandboxHandle[] = [];
  readonly cleanupSyncCalls: string[] = [];
  private startAttempts = 0;
  private idSeq = 0;

  constructor(private readonly opts: FakeBackendOptions = {}) {}

  async create(spec: import("./model.js").ContainerSpec): Promise<SandboxHandle> {
    this.idSeq += 1;
    const handle: SandboxHandle = { id: `fake-${this.idSeq}`, spec };
    this.createdHandles.push(handle);
    this.calls.push({ op: "create", handleId: handle.id });
    return handle;
  }

  async start(handle: SandboxHandle): Promise<void> {
    this.calls.push({ op: "start", handleId: handle.id });
    this.startAttempts += 1;
    const failuresBeforeSuccess = this.opts.startFailuresBeforeSuccess ?? 0;
    if (this.opts.failNonConflictOnAttempt === this.startAttempts) {
      throw new Error("boom: unrelated start failure");
    }
    if (this.startAttempts <= failuresBeforeSuccess) {
      if (this.opts.startFailureIsPortConflict ?? true) {
        throw new PortBindConflictError("address already in use");
      }
      throw new Error("boom: unrelated start failure");
    }
  }

  async stop(handle: SandboxHandle): Promise<void> {
    this.calls.push({ op: "stop", handleId: handle.id });
  }

  async remove(handle: SandboxHandle): Promise<void> {
    this.calls.push({ op: "remove", handleId: handle.id });
  }

  async exec(_handle: SandboxHandle, _cmd: ReadonlyArray<string>): Promise<ExecResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async logs(_handle: SandboxHandle): Promise<string> {
    return "";
  }

  async followLogs(): Promise<import("./backend.js").FollowHandle> {
    return { close: async () => {} };
  }

  async ensureNetwork(_networkId: string): Promise<void> {
    this.calls.push({ op: "ensureNetwork" });
  }

  async removeNetwork(_networkId: string): Promise<void> {}

  async installNetworkLinks(handle: SandboxHandle, _links: ReadonlyArray<NetworkLink>): Promise<void> {
    this.calls.push({ op: "installNetworkLinks", handleId: handle.id });
    if (this.opts.failInstallNetworkLinks ?? false) {
      throw new Error("boom: installNetworkLinks failed");
    }
  }

  async close(): Promise<void> {}

  cleanupSync(id: string): void {
    this.cleanupSyncCalls.push(id);
  }
}

function failingWaitStrategy(): WaitStrategy {
  return {
    waitUntilReady: async () => {
      throw new Error("boom: wait strategy failed");
    },
    withStartupTimeout(): WaitStrategy {
      return this;
    },
  };
}

// The fake backend never actually binds a listening socket on the "mapped"
// ports it invents, so the real Wait.forListeningPort() default would probe
// a closed port and time out for every test here. These unit tests exercise
// GenericContainer's own orchestration, not a real wait strategy, so they
// opt into an instant-ready stand-in instead.
function instantReady(): WaitStrategy {
  return {
    waitUntilReady: async () => {},
    withStartupTimeout(): WaitStrategy {
      return this;
    },
  };
}

describe("GenericContainer — U1 port allocate/create/wait/map", () => {
  it("allocates host ports, creates the correct spec, maps ports, and transitions isRunning", async () => {
    const backend = new FakeBackend();
    const container = new GenericContainer("redis:8.6-alpine")
      .withBackend(backend)
      .withEnv("FOO", "bar")
      .withExposedPorts(6379)
      .waitingFor(instantReady());

    assert.equal(container.isRunning, false);
    await container.start();
    assert.equal(container.isRunning, true);

    const spec = backend.createdHandles[0]?.spec;
    assert.ok(spec !== undefined);
    assert.equal(spec?.image, "redis:8.6-alpine");
    assert.deepEqual(spec?.env, [["FOO", "bar"]]);
    assert.equal(spec?.ports.length, 1);
    assert.ok((spec?.ports[0]?.hostPort ?? 0) > 0);
    assert.equal(spec?.ports[0]?.guestPort, 6379);

    const mapped = container.getMappedPort(6379);
    assert.equal(mapped, spec?.ports[0]?.hostPort);

    await container.stop();
    assert.equal(container.isRunning, false);
  });
});

describe("GenericContainer — U2 network links to running siblings", () => {
  it("links a new member to an already-running sibling, never to itself", async () => {
    const backend = new FakeBackend();
    const net = Network.newNetwork();

    const first = new GenericContainer("redis:8.6-alpine")
      .withBackend(backend)
      .withExposedPorts(6379)
      .withNetwork(net)
      .withNetworkAliases("redis")
      .waitingFor(instantReady());
    await first.start();

    const second = new GenericContainer("consumer:latest")
      .withBackend(backend)
      .withNetwork(net)
      .withNetworkAliases("consumer")
      .waitingFor(instantReady());
    await second.start();

    const secondHandleId = backend.createdHandles[1]?.id;
    const linkCall = backend.calls.find((c) => c.op === "installNetworkLinks" && c.handleId === secondHandleId);
    assert.ok(linkCall !== undefined);

    assert.equal(net.resolve("redis", 6379), "redis:6379");

    await first.stop();
    await second.stop();
  });

  it("a single container on a network installs no links but is registered for a later joiner", async () => {
    const backend = new FakeBackend();
    const net = Network.newNetwork();
    const solo = new GenericContainer("alpine:3.19")
      .withBackend(backend)
      .withExposedPorts(80)
      .withNetwork(net)
      .withNetworkAliases("solo")
      .waitingFor(instantReady());
    await solo.start();

    // No siblings existed when solo started, so nothing to resolve yet, but
    // a second container joining now should see solo as a running sibling.
    const second = new GenericContainer("alpine:3.19")
      .withBackend(backend)
      .withNetwork(net)
      .withNetworkAliases("second")
      .waitingFor(instantReady());
    await second.start();
    assert.equal(net.resolve("solo", 80), "solo:80");

    await solo.stop();
    await second.stop();
  });
});

describe("GenericContainer — U3 exec/mapped-port require running", () => {
  it("exec throws on a not-running container", async () => {
    const container = new GenericContainer("alpine:3.19").withBackend(new FakeBackend());
    await assert.rejects(() => container.exec("echo", "hi"));
  });

  it("getMappedPort throws on a not-running container", () => {
    const container = new GenericContainer("alpine:3.19").withBackend(new FakeBackend()).withExposedPorts(80).waitingFor(instantReady());
    assert.throws(() => container.getMappedPort(80));
  });
});

describe("GenericContainer — U4 port release + reissue", () => {
  it("a stopped container's ports return to FreePorts and can be reissued", async () => {
    const backend = new FakeBackend();
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady());
    await container.start();
    const port = container.getMappedPort(80);
    assert.ok(FreePorts.issuedView().has(port));

    await container.stop();
    assert.ok(!FreePorts.issuedView().has(port));
  });

  it("the retry loop frees every failed attempt's ports", async () => {
    const backend = new FakeBackend({ startFailuresBeforeSuccess: 2 });
    const before = FreePorts.issuedView().size;
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady());
    await container.start();
    // Only the final successful attempt's port should still be issued.
    assert.equal(FreePorts.issuedView().size, before + 1);
    await container.stop();
    assert.equal(FreePorts.issuedView().size, before);
  });

  it("the await using dispose path releases ports too", async () => {
    const backend = new FakeBackend();
    const before = FreePorts.issuedView().size;
    {
      await using container = await new GenericContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady()).start();
      assert.ok(FreePorts.issuedView().size > before);
      void container;
    }
    assert.equal(FreePorts.issuedView().size, before);
  });
});

describe("GenericContainer — U5 cleanup-on-start-failure across the whole seam", () => {
  it("installNetworkLinks failure: stop+remove ran, no ports leak", async () => {
    const backend = new FakeBackend({ failInstallNetworkLinks: true });
    const before = FreePorts.issuedView().size;
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady());

    await assert.rejects(() => container.start());

    assert.equal(FreePorts.issuedView().size, before);
    assert.ok(backend.calls.some((c) => c.op === "stop"));
    assert.ok(backend.calls.some((c) => c.op === "remove"));
    assert.equal(container.isRunning, false);
  });

  it("wait-strategy failure: stop+remove ran, no ports leak, teardown completes before start() rejects", async () => {
    const backend = new FakeBackend();
    const before = FreePorts.issuedView().size;
    const container = new GenericContainer("alpine:3.19")
      .withBackend(backend)
      .withExposedPorts(80)
      .waitingFor(failingWaitStrategy());

    await assert.rejects(() => container.start());

    assert.equal(FreePorts.issuedView().size, before);
    assert.ok(backend.calls.some((c) => c.op === "stop"));
    assert.ok(backend.calls.some((c) => c.op === "remove"));
    assert.equal(container.isRunning, false);
  });
});

describe("GenericContainer — U6 port-bind-conflict retry", () => {
  it("retries with fresh ports on a typed PortBindConflictError, then succeeds", async () => {
    const backend = new FakeBackend({ startFailuresBeforeSuccess: 2, startFailureIsPortConflict: true });
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady());
    await container.start();
    assert.equal(container.isRunning, true);
    const startCalls = backend.calls.filter((c) => c.op === "start");
    assert.equal(startCalls.length, 3);
    await container.stop();
  });

  it("does not retry a non-conflict start error", async () => {
    const backend = new FakeBackend({ startFailuresBeforeSuccess: 1, startFailureIsPortConflict: false });
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady());
    await assert.rejects(() => container.start());
    const startCalls = backend.calls.filter((c) => c.op === "start");
    assert.equal(startCalls.length, 1);
  });

  it("classifies a string-message conflict (address already in use) via the cause chain", async () => {
    const backend = new FakeBackend();
    // Override start() behavior via a wrapping error with a plain message
    // instead of the typed class, to exercise the string-fallback path.
    const originalStart = backend.start.bind(backend);
    let calls = 0;
    backend.start = async (handle) => {
      calls += 1;
      if (calls === 1) {
        throw new Error("Bind for 0.0.0.0:1234 failed: port is already allocated");
      }
      return originalStart(handle);
    };
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady());
    await container.start();
    assert.equal(calls, 2);
    await container.stop();
  });
});

describe("GenericContainer — U7 stop idempotent", () => {
  it("stop before start is a no-op calling no backend method", async () => {
    const backend = new FakeBackend();
    const container = new GenericContainer("alpine:3.19").withBackend(backend);
    await container.stop();
    assert.equal(backend.calls.length, 0);
  });

  it("after start, backend.stop is called exactly once even across a double stop", async () => {
    const backend = new FakeBackend();
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady());
    await container.start();
    await container.stop();
    await container.stop();
    const stopCalls = backend.calls.filter((c) => c.op === "stop");
    assert.equal(stopCalls.length, 1);
  });
});

describe("GenericContainer — registered sync cleanup actually reaches the backend", () => {
  it("start() registers a sync cleanup that calls backend.cleanupSync(handle.id), and stop() unregisters it", async () => {
    const backend = new FakeBackend();
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady());
    await container.start();

    const handleId = backend.createdHandles[0]?.id;
    assert.ok(handleId !== undefined);

    // Simulate the process-exit path directly: run every registered sync
    // cleanup exactly the way cleanup.ts's "exit" handler does, without
    // actually exiting this test process. If start() only registered a
    // no-op placeholder (the pre-fix seam), backend.cleanupSyncCalls would
    // stay empty here even though a container is live.
    runAllRegisteredCleanupsForTest();
    assert.deepEqual(backend.cleanupSyncCalls, [handleId]);

    // A normal stop() unregisters the cleanup, so a later process-exit
    // sweep must not call cleanupSync a second time for an already-torn-
    // down container.
    await container.stop();
    runAllRegisteredCleanupsForTest();
    assert.deepEqual(backend.cleanupSyncCalls, [handleId]);
  });

  it("stop() never registers cleanupSync again for the same container after normal teardown", async () => {
    const backend = new FakeBackend();
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady());
    await container.start();
    await container.stop();
    runAllRegisteredCleanupsForTest();
    assert.deepEqual(backend.cleanupSyncCalls, []);
  });
});

describe("GenericContainer — U8 mapped-port cause disambiguation + memory limit", () => {
  it("after stop: not running", async () => {
    const backend = new FakeBackend();
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady());
    await container.start();
    await container.stop();
    try {
      container.getMappedPort(80);
      assert.ok(false, "expected a throw");
    } catch (err) {
      assert.match((err as Error).message, /not running/);
    }
  });

  it("running + undeclared port: not exposed", async () => {
    const backend = new FakeBackend();
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady());
    await container.start();
    try {
      container.getMappedPort(9999);
      assert.ok(false, "expected a throw");
    } catch (err) {
      assert.match((err as Error).message, /not exposed/);
    } finally {
      await container.stop();
    }
  });

  it("withMemoryLimit reaches spec.memoryLimitMb", async () => {
    const backend = new FakeBackend();
    const container = new GenericContainer("alpine:3.19").withBackend(backend).withMemoryLimit(512).waitingFor(instantReady());
    await container.start();
    assert.equal(backend.createdHandles[0]?.spec.memoryLimitMb, 512);
    await container.stop();
  });

  it("memoryLimitMb defaults to undefined", async () => {
    const backend = new FakeBackend();
    const container = new GenericContainer("alpine:3.19").withBackend(backend);
    await container.start();
    assert.equal(backend.createdHandles[0]?.spec.memoryLimitMb, undefined);
    await container.stop();
  });
});

describe("GenericContainer — U9 async-dispose", () => {
  it("await using calls stop() exactly once at scope exit", async () => {
    const backend = new FakeBackend();
    {
      await using container = await new GenericContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady()).start();
      assert.equal(container.isRunning, true);
    }
    const stopCalls = backend.calls.filter((c) => c.op === "stop");
    assert.equal(stopCalls.length, 1);
  });

  it("dispose swallows teardown errors and never throws out of the using scope", async () => {
    const backend = new FakeBackend();
    backend.stop = async () => {
      throw new Error("boom: stop failed");
    };
    {
      await using container = await new GenericContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady()).start();
      void container;
    }
    // Reaching here proves dispose did not propagate the stop() failure.
    assert.ok(true);
  });
});

describe("GenericContainer — containerIsStarting fires before any boot work", () => {
  class EarlyRejectContainer extends GenericContainer {
    protected override async containerIsStarting(backend: SandboxBackend): Promise<void> {
      if (backend.name === "reject-me") {
        throw new Error("boom: rejected before boot");
      }
    }
  }

  it("sees the resolved backend and can reject before ensureNetwork/create/start run", async () => {
    const backend = new FakeBackend();
    (backend as { name: string }).name = "reject-me";
    const container = new EarlyRejectContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady());

    await assert.rejects(() => container.start());

    // No create/start/ensureNetwork call ever reached the backend: the
    // rejection happened strictly before any boot work, not merely before
    // readiness was confirmed.
    assert.equal(backend.calls.length, 0);
    assert.equal(container.isRunning, false);
  });

  it("does not interfere with a normal start when the hook does not throw", async () => {
    const backend = new FakeBackend();
    const container = new EarlyRejectContainer("alpine:3.19").withBackend(backend).withExposedPorts(80).waitingFor(instantReady());
    await container.start();
    assert.equal(container.isRunning, true);
    await container.stop();
  });
});
