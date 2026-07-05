import { describe, it, assert, beforeEach } from "../../test/harness.js";
import type { BackendProvider, SandboxBackend, SandboxHandle, NetworkLink } from "./backend.js";
import { registerBackend, resolve, Backends, _resetRegistryForTests } from "./backends.js";

// A sentinel thrown from create() proves resolution reached this exact
// provider without needing a real backend implementation.
class Reached extends Error {
  constructor(readonly providerName: string) {
    super(`reached:${providerName}`);
  }
}

function fakeBackend(name: string): SandboxBackend {
  const notImplemented = (): never => {
    throw new Error(`${name}: not implemented in this fake`);
  };
  return {
    name,
    supportsNativeNetworks: false,
    create: (): Promise<SandboxHandle> => notImplemented(),
    start: (): Promise<void> => notImplemented(),
    stop: (): Promise<void> => notImplemented(),
    remove: (): Promise<void> => notImplemented(),
    exec: (): Promise<import("./model.js").ExecResult> => notImplemented(),
    logs: (): Promise<string> => notImplemented(),
    followLogs: (): Promise<import("./backend.js").FollowHandle> => notImplemented(),
    ensureNetwork: (): Promise<void> => notImplemented(),
    removeNetwork: (): Promise<void> => notImplemented(),
    installNetworkLinks: (_h: SandboxHandle, _l: ReadonlyArray<NetworkLink>): Promise<void> => notImplemented(),
    close: (): Promise<void> => notImplemented(),
    cleanupSync: (): void => notImplemented(),
  };
}

// assert.throws only checks a message string; resolution needs to assert
// WHICH provider's create() ran, so catch and inspect the sentinel directly.
function assertReaches(fn: () => unknown, providerName: string): void {
  try {
    fn();
    assert.ok(false, `expected create() to be reached for '${providerName}'`);
  } catch (err) {
    assert.ok(err instanceof Reached, "expected a Reached sentinel");
    assert.equal((err as Reached).providerName, providerName);
  }
}

function fakeProvider(opts: { name: string; priority: number; supported: boolean; reason?: string }): BackendProvider {
  return {
    name: opts.name,
    priority: opts.priority,
    isSupported: () => opts.supported,
    unsupportedReason: () => opts.reason ?? `${opts.name} is not supported`,
    create: () => {
      throw new Reached(opts.name);
    },
  };
}

describe("resolve (pure function)", () => {
  it("picks the highest-priority supported provider when nothing is requested", () => {
    const low = fakeProvider({ name: "docker", priority: 10, supported: true });
    const high = fakeProvider({ name: "microsandbox", priority: 20, supported: true });
    assertReaches(() => resolve([low, high], undefined), "microsandbox");
  });

  it("skips unsupported providers even if higher priority", () => {
    const low = fakeProvider({ name: "docker", priority: 10, supported: true });
    const high = fakeProvider({ name: "microsandbox", priority: 20, supported: false });
    assertReaches(() => resolve([low, high], undefined), "docker");
  });

  it("RIGHTSIZE_BACKEND override wins even at lower priority", () => {
    const low = fakeProvider({ name: "docker", priority: 10, supported: true });
    const high = fakeProvider({ name: "microsandbox", priority: 20, supported: true });
    assertReaches(() => resolve([low, high], "docker"), "docker");
  });

  it("no supported provider lists every provider's unsupportedReason", () => {
    const a = fakeProvider({ name: "microsandbox", priority: 20, supported: false, reason: "no /dev/kvm" });
    const b = fakeProvider({ name: "docker", priority: 10, supported: false, reason: "no docker socket" });
    try {
      resolve([a, b], undefined);
      assert.ok(false, "expected resolve to throw");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match((err as Error).message, /no \/dev\/kvm/);
      assert.match((err as Error).message, /no docker socket/);
    }
  });

  it("unknown requested name lists the known provider names", () => {
    const a = fakeProvider({ name: "microsandbox", priority: 20, supported: true });
    const b = fakeProvider({ name: "docker", priority: 10, supported: true });
    try {
      resolve([a, b], "nonexistent");
      assert.ok(false, "expected resolve to throw");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match((err as Error).message, /nonexistent/);
      assert.match((err as Error).message, /microsandbox/);
      assert.match((err as Error).message, /docker/);
    }
  });

  it("empty registry names both backend subpath imports", () => {
    try {
      resolve([], undefined);
      assert.ok(false, "expected resolve to throw");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match((err as Error).message, /rightsize\/backend-msb/);
      assert.match((err as Error).message, /rightsize\/backend-docker/);
    }
  });

  it("requested-but-unsupported names its own unsupportedReason", () => {
    const a = fakeProvider({ name: "microsandbox", priority: 20, supported: false, reason: "no /dev/kvm on this host" });
    try {
      resolve([a], "microsandbox");
      assert.ok(false, "expected resolve to throw");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match((err as Error).message, /microsandbox/);
      assert.match((err as Error).message, /no \/dev\/kvm on this host/);
    }
  });

  it("requested-name match is case-insensitive (upper and mixed case)", () => {
    const a = fakeProvider({ name: "docker", priority: 10, supported: true });
    assertReaches(() => resolve([a], "DOCKER"), "docker");
    assertReaches(() => resolve([a], "DoCkEr"), "docker");
  });
});

describe("registerBackend + Backends.active (impure, real registry)", () => {
  beforeEach(() => {
    _resetRegistryForTests();
    Backends._resetActiveForTests();
    delete process.env["RIGHTSIZE_BACKEND"];
  });

  it("registerBackend makes a provider visible to Backends.active()", () => {
    registerBackend(fakeProvider({ name: "docker", priority: 10, supported: true }));
    assertReaches(() => Backends.active(), "docker");
  });

  it("Backends.active() memoizes across calls", () => {
    let createCalls = 0;
    const provider: BackendProvider = {
      name: "docker",
      priority: 10,
      isSupported: () => true,
      unsupportedReason: () => "n/a",
      create: () => {
        createCalls++;
        return fakeBackend("docker");
      },
    };
    registerBackend(provider);
    const first = Backends.active();
    const second = Backends.active();
    assert.equal(first, second);
    assert.equal(createCalls, 1);
  });

  it("the beforeExit cleanup hook calls close() at most once even if beforeExit fires repeatedly", async () => {
    // beforeExit re-fires whenever the event loop would otherwise go idle.
    // An async close() call schedules more event-loop work, which — without
    // a once-only guard — makes the NEXT idle point trigger this handler
    // again, forever (this hung every `node --test` process that ever
    // resolved a real backend, since the daemon call inside close() always
    // has more microtasks to run). This calls the registered listener
    // directly (not `process.emit("beforeExit", ...)`, which perturbs
    // node:test's own use of the same event) several times in a row, the
    // same way Node would call it on successive idle points.
    let closeCalls = 0;
    const provider: BackendProvider = {
      name: "docker",
      priority: 10,
      isSupported: () => true,
      unsupportedReason: () => "n/a",
      create: () => ({
        ...fakeBackend("docker"),
        close: async () => {
          closeCalls++;
          await new Promise((resolve) => setTimeout(resolve, 1));
        },
      }),
    };
    registerBackend(provider);
    Backends.active();

    const listeners = process.listeners("beforeExit") as Array<() => void>;
    const installedByBackends = listeners[listeners.length - 1];
    assert.ok(installedByBackends !== undefined, "expected Backends.active() to have installed a beforeExit listener");
    if (installedByBackends === undefined) {
      return;
    }
    installedByBackends();
    installedByBackends();
    installedByBackends();
    // Give the first close() call's internal microtask a chance to settle
    // before asserting — proves the guard, not just call-ordering luck.
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(closeCalls, 1);
    process.removeListener("beforeExit", installedByBackends);
  });
});
