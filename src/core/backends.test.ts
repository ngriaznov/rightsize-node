import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert, beforeEach, after } from "../../test/harness.js";
import type { BackendProvider, SandboxBackend, SandboxHandle, NetworkLink } from "./backend.js";
import { registerBackend, resolve, Backends, _resetRegistryForTests, _providersSnapshotForTests } from "./backends.js";

/**
 * Runs `fn` with `RIGHTSIZE_CACHE_DIR`/`RIGHTSIZE_REAPER` set (or cleared)
 * for its duration, restoring whatever was there before on the way out —
 * every `reaperReady()` test needs its own throwaway cache dir so it never
 * touches the real `~/.cache/rightsize` a developer or CI runner has.
 */
async function withReaperEnv(
  opts: { cacheDir: string | undefined; reaperMode: string | undefined },
  fn: () => Promise<void>,
): Promise<void> {
  const savedCacheDir = process.env["RIGHTSIZE_CACHE_DIR"];
  const savedReaperMode = process.env["RIGHTSIZE_REAPER"];
  if (opts.cacheDir === undefined) {
    delete process.env["RIGHTSIZE_CACHE_DIR"];
  } else {
    process.env["RIGHTSIZE_CACHE_DIR"] = opts.cacheDir;
  }
  if (opts.reaperMode === undefined) {
    delete process.env["RIGHTSIZE_REAPER"];
  } else {
    process.env["RIGHTSIZE_REAPER"] = opts.reaperMode;
  }
  try {
    await fn();
  } finally {
    if (savedCacheDir === undefined) {
      delete process.env["RIGHTSIZE_CACHE_DIR"];
    } else {
      process.env["RIGHTSIZE_CACHE_DIR"] = savedCacheDir;
    }
    if (savedReaperMode === undefined) {
      delete process.env["RIGHTSIZE_REAPER"];
    } else {
      process.env["RIGHTSIZE_REAPER"] = savedReaperMode;
    }
  }
}

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
    capabilities: { hardwareIsolated: false, checkpoint: false },
    create: (): Promise<SandboxHandle> => notImplemented(),
    start: (): Promise<void> => notImplemented(),
    stop: (): Promise<void> => notImplemented(),
    remove: (): Promise<void> => notImplemented(),
    commitToImage: (): Promise<void> => notImplemented(),
    removeByName: (): Promise<void> => notImplemented(),
    findRunning: (): Promise<SandboxHandle | undefined> => notImplemented(),
    reaperKillCommand: (): Promise<import("./backend.js").ReaperKillCommand> => notImplemented(),
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
  // Hermetic despite the impurity: everything this suite mutates is global to
  // the process, and single-process runners load every test file into one
  // process — restore the real providers, the memoized backend, and the env
  // var on the way out or later-loaded suites inherit the fakes.
  const savedProviders = _providersSnapshotForTests();
  const savedBackendEnv = process.env["RIGHTSIZE_BACKEND"];

  beforeEach(() => {
    _resetRegistryForTests();
    Backends._resetActiveForTests();
    delete process.env["RIGHTSIZE_BACKEND"];
  });

  after(() => {
    _resetRegistryForTests();
    for (const p of savedProviders) {
      registerBackend(p);
    }
    Backends._resetActiveForTests();
    if (savedBackendEnv === undefined) {
      delete process.env["RIGHTSIZE_BACKEND"];
    } else {
      process.env["RIGHTSIZE_BACKEND"] = savedBackendEnv;
    }
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

  it("after beforeExit's close() settles, this run's ledger record is deleted (addendum item 5's own-run cleanup rule)", async () => {
    const provider: BackendProvider = {
      name: "docker",
      priority: 10,
      isSupported: () => true,
      unsupportedReason: () => "n/a",
      create: () => ({
        ...fakeBackend("docker"),
        removeByName: async () => {},
        reaperKillCommand: async () => ({ stop: [], remove: ["docker", "rm", "-f"], removeNetwork: ["docker", "network", "rm"] }),
        close: async () => {},
      }),
    };
    registerBackend(provider);

    const tmpCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-backends-close-ledger-test-"));
    try {
      await withReaperEnv({ cacheDir: tmpCacheDir, reaperMode: "sweep" }, async () => {
        await Backends.reaperReady();
        const before = await fs.readdir(path.join(tmpCacheDir, "runs"));
        assert.equal(before.filter((f) => f.endsWith(".json")).length, 1, "expected the run record to exist before close()");

        const listeners = process.listeners("beforeExit") as Array<() => void>;
        const installedByBackends = listeners[listeners.length - 1];
        assert.ok(installedByBackends !== undefined, "expected Backends.active() to have installed a beforeExit listener");
        if (installedByBackends === undefined) {
          return;
        }
        installedByBackends();
        // Let the close().then(afterClose) chain settle.
        await new Promise((resolve) => setTimeout(resolve, 20));
        process.removeListener("beforeExit", installedByBackends);

        const after = await fs.readdir(path.join(tmpCacheDir, "runs")).catch(() => []);
        assert.equal(after.filter((f) => f.endsWith(".json")).length, 0, "expected the run record to be deleted after close() settled");
      });
    } finally {
      await fs.rm(tmpCacheDir, { recursive: true, force: true });
    }
  });

  it("RIGHTSIZE_REAPER=off: reaperReady() resolves the same backend active() would, but never calls reaperKillCommand at all", async () => {
    let reaperKillCommandCalls = 0;
    let createCalls = 0;
    const provider: BackendProvider = {
      name: "docker",
      priority: 10,
      isSupported: () => true,
      unsupportedReason: () => "n/a",
      create: () => {
        createCalls += 1;
        return {
          ...fakeBackend("docker"),
          removeByName: async () => {},
          reaperKillCommand: async () => {
            reaperKillCommandCalls += 1;
            return { stop: [], remove: ["docker", "rm", "-f"], removeNetwork: ["docker", "network", "rm"] };
          },
        };
      },
    };
    registerBackend(provider);

    await withReaperEnv({ cacheDir: undefined, reaperMode: "off" }, async () => {
      await Backends.reaperReady();
      await Backends.reaperReady();
      assert.equal(Backends.active(), Backends.active()); // still memoized to one instance
      assert.equal(createCalls, 1, "expected only one backend instance to ever have been created");
      assert.equal(reaperKillCommandCalls, 0, "RIGHTSIZE_REAPER=off must skip reaperKillCommand entirely");
    });
  });

  it("RIGHTSIZE_REAPER=sweep: reaperReady() writes the run record and initializes exactly once across repeated calls", async () => {
    let reaperKillCommandCalls = 0;
    const provider: BackendProvider = {
      name: "docker",
      priority: 10,
      isSupported: () => true,
      unsupportedReason: () => "n/a",
      create: () => ({
        ...fakeBackend("docker"),
        removeByName: async () => {},
        reaperKillCommand: async () => {
          reaperKillCommandCalls += 1;
          return { stop: [], remove: ["docker", "rm", "-f"], removeNetwork: ["docker", "network", "rm"] };
        },
      }),
    };
    registerBackend(provider);

    const tmpCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-backends-reaper-test-"));
    try {
      await withReaperEnv({ cacheDir: tmpCacheDir, reaperMode: "sweep" }, async () => {
        await Promise.all([Backends.reaperReady(), Backends.reaperReady()]);
        await Backends.reaperReady();
        assert.equal(reaperKillCommandCalls, 1);
        const runsDirEntries = await fs.readdir(path.join(tmpCacheDir, "runs"));
        assert.equal(runsDirEntries.filter((f) => f.endsWith(".json")).length, 1);
      });
    } finally {
      await fs.rm(tmpCacheDir, { recursive: true, force: true });
    }
  });
});
