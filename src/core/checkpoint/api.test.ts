import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert } from "../../../test/harness.js";
import { Checkpoints } from "./api.js";
import { writeCheckpointRegistryAtomic, readCheckpointRegistry, checkpointRegistryPath } from "./registry.js";
import type { CheckpointRegistryEntry } from "./registry.js";
import { registerBackend, Backends, _providersSnapshotForTests, _resetRegistryForTests } from "../backends.js";
import type { BackendProvider, SandboxBackend, SandboxHandle, BackendCapabilities, NetworkLink, ReaperKillCommand, FollowHandle } from "../backend.js";
import type { ContainerSpec, ExecResult } from "../model.js";
import { InvalidCheckpointNameError } from "../errors.js";

/** A minimal `SandboxBackend` whose checkpoint artifacts are an in-memory `Set<string>` a test can seed/inspect directly, so `find`/`remove`'s probe and best-effort-removal behavior can be asserted without a real backend. */
class FakeArtifactBackend implements SandboxBackend {
  readonly supportsNativeNetworks = true;
  readonly capabilities: BackendCapabilities = { hardwareIsolated: false, checkpoint: true, checkpointRestartsWorkload: false };
  readonly artifacts = new Set<string>();
  readonly hasCheckpointCalls: string[] = [];
  readonly removeCheckpointCalls: string[] = [];
  hasCheckpointError: Error | undefined;

  constructor(readonly name: string) {}

  async create(spec: ContainerSpec): Promise<SandboxHandle> {
    return { id: "fake-artifact-1", spec };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async remove(): Promise<void> {}
  async createCheckpoint(_handle: SandboxHandle, ref: string): Promise<void> {
    this.artifacts.add(ref);
  }
  async removeCheckpoint(ref: string): Promise<void> {
    this.removeCheckpointCalls.push(ref);
    this.artifacts.delete(ref);
  }
  async hasCheckpoint(ref: string): Promise<boolean> {
    this.hasCheckpointCalls.push(ref);
    if (this.hasCheckpointError !== undefined) {
      throw this.hasCheckpointError;
    }
    return this.artifacts.has(ref);
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
  async followLogs(): Promise<FollowHandle> {
    return { close: async (): Promise<void> => {} };
  }
  async ensureNetwork(): Promise<void> {}
  async removeNetwork(): Promise<void> {}
  async installNetworkLinks(_handle: SandboxHandle, _links: ReadonlyArray<NetworkLink>): Promise<void> {}
  async copyToContainer(): Promise<void> {}
  async copyFromContainer(): Promise<void> {}
  async close(): Promise<void> {}
  cleanupSync(): void {}
}

/**
 * Registers `backend` as the ONLY resolvable provider under
 * `RIGHTSIZE_BACKEND=<backend.name>`, runs `fn`, then restores the provider
 * registry, env var, and `Backends.active()` memoization. Clears the
 * registry down to nothing before registering `backend` (rather than just
 * appending, the way `generic-container.checkpoint.test.ts`'s reaper-ledger
 * tests do) — this file registers a FRESH same-named fake provider per test,
 * and `resolve()` matches by name on the FIRST hit in registration order, so
 * appending without clearing would let an earlier test's leftover
 * same-named provider silently win here instead of this call's own.
 */
async function withActiveBackend(backend: FakeArtifactBackend, fn: () => Promise<void>): Promise<void> {
  const savedProviders = _providersSnapshotForTests();
  const savedBackendEnv = process.env["RIGHTSIZE_BACKEND"];
  _resetRegistryForTests();
  const provider: BackendProvider = {
    name: backend.name,
    priority: 10,
    isSupported: () => true,
    unsupportedReason: () => "n/a",
    create: () => backend,
  };
  registerBackend(provider);
  process.env["RIGHTSIZE_BACKEND"] = backend.name;
  Backends._resetActiveForTests();
  try {
    await fn();
  } finally {
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
  }
}

async function withTempCacheDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-checkpoints-api-test-"));
  const saved = process.env["RIGHTSIZE_CACHE_DIR"];
  process.env["RIGHTSIZE_CACHE_DIR"] = dir;
  try {
    await fn(dir);
  } finally {
    if (saved === undefined) {
      delete process.env["RIGHTSIZE_CACHE_DIR"];
    } else {
      process.env["RIGHTSIZE_CACHE_DIR"] = saved;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function baseEntry(overrides: Partial<CheckpointRegistryEntry> = {}): CheckpointRegistryEntry {
  return {
    name: "seeded-db",
    ref: "rightsize/checkpoint:seeded-db",
    backend: "fake-active",
    createdIso: "2026-01-01T00:00:00.000Z",
    spec: { env: { A: "1" }, command: ["sleep", "60"], exposedPorts: [80], memoryLimitMb: 256 },
    ...overrides,
  };
}

describe("Checkpoints.find", () => {
  it("resolves undefined when no registry entry exists for the name", async () => {
    await withTempCacheDir(async () => {
      await withActiveBackend(new FakeArtifactBackend("fake-active"), async () => {
        const found = await Checkpoints.find("never-checkpointed");
        assert.equal(found, undefined);
      });
    });
  });

  it("resolves undefined and deletes the file for a corrupt registry entry", async () => {
    await withTempCacheDir(async (dir) => {
      await withActiveBackend(new FakeArtifactBackend("fake-active"), async () => {
        await fs.mkdir(path.dirname(checkpointRegistryPath(dir, "broken")), { recursive: true });
        await fs.writeFile(checkpointRegistryPath(dir, "broken"), "{not json");

        const found = await Checkpoints.find("broken");
        assert.equal(found, undefined);

        const read = await readCheckpointRegistry(dir, "broken");
        assert.equal(read.kind, "missing", "expected the corrupt file to have been removed");
      });
    });
  });

  it("probes the active backend and returns the Checkpoint when the entry's backend matches and the artifact exists", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      await withActiveBackend(backend, async () => {
        const entry = baseEntry();
        backend.artifacts.add(entry.ref);
        await writeCheckpointRegistryAtomic(dir, entry.name, entry);

        const found = await Checkpoints.find(entry.name);
        assert.ok(found !== undefined);
        assert.equal(found?.ref, entry.ref);
        assert.equal(found?.backend, entry.backend);
        assert.deepEqual(found?.spec.env, [["A", "1"]]);
        assert.deepEqual(found?.spec.command, ["sleep", "60"]);
        assert.equal(found?.spec.ports[0]?.guestPort, 80);
        assert.equal(found?.spec.memoryLimitMb, 256);
        assert.deepEqual(backend.hasCheckpointCalls, [entry.ref]);
      });
    });
  });

  it("resolves undefined and deletes the registry entry when the artifact is gone (stale)", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      await withActiveBackend(backend, async () => {
        const entry = baseEntry();
        // Deliberately never added to backend.artifacts: simulates the
        // artifact having been removed outside this library.
        await writeCheckpointRegistryAtomic(dir, entry.name, entry);

        const found = await Checkpoints.find(entry.name);
        assert.equal(found, undefined);

        const read = await readCheckpointRegistry(dir, entry.name);
        assert.equal(read.kind, "missing", "expected the stale entry to have been removed");
      });
    });
  });

  it("returns the entry UNPROBED when its recorded backend differs from the active one", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      await withActiveBackend(backend, async () => {
        // Recorded under a different backend name than the active one —
        // the artifact set intentionally never mentions this ref, so a
        // probe (if one were wrongly made) would report false.
        const entry = baseEntry({ backend: "fake-other" });
        await writeCheckpointRegistryAtomic(dir, entry.name, entry);

        const found = await Checkpoints.find(entry.name);
        assert.ok(found !== undefined, "expected the entry to be returned even though it can't be probed");
        assert.equal(found?.backend, "fake-other");
        assert.equal(found?.ref, entry.ref);
        assert.deepEqual(backend.hasCheckpointCalls, [], "expected hasCheckpoint to never be called for a different-backend entry");
      });
    });
  });

  it("propagates a probe failure instead of treating it as absent", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      backend.hasCheckpointError = new Error("daemon unreachable");
      await withActiveBackend(backend, async () => {
        const entry = baseEntry();
        await writeCheckpointRegistryAtomic(dir, entry.name, entry);

        let thrown: unknown;
        try {
          await Checkpoints.find(entry.name);
        } catch (err) {
          thrown = err;
        }
        assert.ok(thrown instanceof Error, `expected the probe failure to propagate, got: ${String(thrown)}`);
        assert.match((thrown as Error).message, /daemon unreachable/);

        const read = await readCheckpointRegistry(dir, entry.name);
        assert.equal(read.kind, "found", "expected the entry to be left untouched after a probe failure");
      });
    });
  });

  it("rejects a traversal name with InvalidCheckpointNameError before touching any file", async () => {
    await withTempCacheDir(async (dir) => {
      let thrown: unknown;
      try {
        await Checkpoints.find("../secret");
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof InvalidCheckpointNameError, `expected InvalidCheckpointNameError, got: ${String(thrown)}`);
      const checkpointsDirExists = await fs
        .stat(path.join(dir, "checkpoints"))
        .then(() => true)
        .catch(() => false);
      assert.equal(checkpointsDirExists, false, "expected find() to reject before ever touching the checkpoints directory");
    });
  });
});

describe("Checkpoints.list", () => {
  it("resolves an empty array when nothing has ever been checkpointed with a name", async () => {
    await withTempCacheDir(async () => {
      const found = await Checkpoints.list();
      assert.deepEqual(found, []);
    });
  });

  it("lists every valid entry and skips corrupt ones, without probing any backend", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      await withActiveBackend(backend, async () => {
        const one = baseEntry({ name: "one", ref: "rightsize/checkpoint:one" });
        const two = baseEntry({ name: "two", ref: "rightsize/checkpoint:two", backend: "fake-other" });
        await writeCheckpointRegistryAtomic(dir, one.name, one);
        await writeCheckpointRegistryAtomic(dir, two.name, two);
        await fs.mkdir(path.dirname(checkpointRegistryPath(dir, "broken")), { recursive: true });
        await fs.writeFile(checkpointRegistryPath(dir, "broken"), "{not json");
        // Deliberately never added to backend.artifacts — list() must never
        // notice either way, since it never probes.

        const listed = await Checkpoints.list();
        const names = listed.map((c) => c.ref).sort();
        assert.deepEqual(names, ["rightsize/checkpoint:one", "rightsize/checkpoint:two"]);
        assert.deepEqual(backend.hasCheckpointCalls, [], "expected list() to never call hasCheckpoint");

        // The corrupt file is left in place (only find/remove clean it up).
        const stillThere = await fs
          .stat(checkpointRegistryPath(dir, "broken"))
          .then(() => true)
          .catch(() => false);
        assert.equal(stillThere, true, "expected list() to skip the corrupt entry without deleting it");
      });
    });
  });
});

describe("Checkpoints.remove", () => {
  it("resolves false when no registry entry exists for the name", async () => {
    await withTempCacheDir(async () => {
      const found = await Checkpoints.remove("never-checkpointed");
      assert.equal(found, false);
    });
  });

  it("resolves true and deletes the file for a corrupt registry entry", async () => {
    await withTempCacheDir(async (dir) => {
      await fs.mkdir(path.dirname(checkpointRegistryPath(dir, "broken")), { recursive: true });
      await fs.writeFile(checkpointRegistryPath(dir, "broken"), "{not json");

      const removed = await Checkpoints.remove("broken");
      assert.equal(removed, true);
      const read = await readCheckpointRegistry(dir, "broken");
      assert.equal(read.kind, "missing");
    });
  });

  it("removes the backend artifact and the registry file when the entry's backend matches the active one", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      await withActiveBackend(backend, async () => {
        const entry = baseEntry();
        backend.artifacts.add(entry.ref);
        await writeCheckpointRegistryAtomic(dir, entry.name, entry);

        const removed = await Checkpoints.remove(entry.name);
        assert.equal(removed, true);
        assert.deepEqual(backend.removeCheckpointCalls, [entry.ref]);
        assert.equal(backend.artifacts.has(entry.ref), false);

        const read = await readCheckpointRegistry(dir, entry.name);
        assert.equal(read.kind, "missing");
      });
    });
  });

  it("deletes only the registry file, never touching the artifact, when the entry's backend differs from the active one", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      await withActiveBackend(backend, async () => {
        const entry = baseEntry({ backend: "fake-other" });
        await writeCheckpointRegistryAtomic(dir, entry.name, entry);

        const removed = await Checkpoints.remove(entry.name);
        assert.equal(removed, true);
        assert.deepEqual(backend.removeCheckpointCalls, [], "expected removeCheckpoint to never be called against the wrong backend");

        const read = await readCheckpointRegistry(dir, entry.name);
        assert.equal(read.kind, "missing");
      });
    });
  });

  it("is idempotent: a second remove() on the same name reports false", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      await withActiveBackend(backend, async () => {
        const entry = baseEntry();
        backend.artifacts.add(entry.ref);
        await writeCheckpointRegistryAtomic(dir, entry.name, entry);

        assert.equal(await Checkpoints.remove(entry.name), true);
        assert.equal(await Checkpoints.remove(entry.name), false);
      });
    });
  });

  it("rejects a traversal name with InvalidCheckpointNameError before touching any file", async () => {
    await withTempCacheDir(async (dir) => {
      let thrown: unknown;
      try {
        await Checkpoints.remove("../secret");
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof InvalidCheckpointNameError, `expected InvalidCheckpointNameError, got: ${String(thrown)}`);
      const checkpointsDirExists = await fs
        .stat(path.join(dir, "checkpoints"))
        .then(() => true)
        .catch(() => false);
      assert.equal(checkpointsDirExists, false, "expected remove() to reject before ever touching the checkpoints directory");
    });
  });
});
