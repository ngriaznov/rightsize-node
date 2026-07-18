import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert } from "../../../test/harness.js";
import { Checkpoints } from "./api.js";
import {
  writeCheckpointRegistryAtomic,
  readCheckpointRegistry,
  checkpointRegistryPath,
  listCheckpointNames,
  fromCheckpointRegistryEntry,
} from "./registry.js";
import type { CheckpointRegistryEntry } from "./registry.js";
import { TarCli, runTar } from "./tar-cli.js";
import { registerBackend, Backends, _providersSnapshotForTests, _resetRegistryForTests } from "../backends.js";
import type { BackendProvider, SandboxBackend, SandboxHandle, BackendCapabilities, NetworkLink, ReaperKillCommand, FollowHandle } from "../backend.js";
import type { ContainerSpec, ExecResult, Checkpoint } from "../model.js";
import {
  InvalidCheckpointNameError,
  MalformedCheckpointArchiveError,
  CheckpointArtifactMissingError,
  CheckpointBackendMismatchError,
} from "../errors.js";

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
  readonly exportCheckpointCalls: Array<{ ref: string; destFile: string }> = [];
  readonly importCheckpointCalls: Array<{ srcFile: string; ref: string }> = [];
  /** Every artifact's content as read back by `importCheckpoint`, in call order — the export/import round trip's byte-identity check. */
  readonly importedArtifactContents: string[] = [];
  /** Test seam: the effective ref `importCheckpoint` returns — defaults to the ref it was given, override to simulate msb's digest-remapping. */
  importEffectiveRef: ((ref: string) => string) | undefined;
  /** Test seam: when set, the next `exportCheckpoint` call rejects with this instead of writing a payload — proves temp-dir cleanup on a failed export. */
  failNextExportCheckpoint: Error | undefined;

  async exportCheckpoint(ref: string, destFile: string): Promise<void> {
    this.exportCheckpointCalls.push({ ref, destFile });
    if (this.failNextExportCheckpoint !== undefined) {
      const err = this.failNextExportCheckpoint;
      this.failNextExportCheckpoint = undefined;
      throw err;
    }
    // A recognizable payload: the export round-trip test asserts these bytes
    // survive the archive tar/untar cycle byte-for-byte.
    await fs.writeFile(destFile, `fake-artifact:${ref}`);
  }
  async importCheckpoint(srcFile: string, ref: string): Promise<string> {
    this.importCheckpointCalls.push({ srcFile, ref });
    this.importedArtifactContents.push(await fs.readFile(srcFile, "utf8"));
    const effectiveRef = this.importEffectiveRef?.(ref) ?? ref;
    this.artifacts.add(effectiveRef);
    return effectiveRef;
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

/**
 * Points `os.tmpdir()` at a private, empty directory for the duration of
 * `fn` (Node reads `TMPDIR`/`TEMP`/`TMP` live on every call — never cached
 * at startup), then restores the prior env and removes it. `exportTo`'s
 * staging directory lives under the REAL `os.tmpdir()` with a
 * `rightsize-checkpoint-export-*` prefix shared by every OTHER test file
 * exercising the same production code concurrently (each `node --test`/
 * `bun test` file is its own process) — diffing the real system tmpdir
 * would race their staging directories against this test's own before/after
 * snapshot.
 */
async function withIsolatedTmpDir<T>(fn: (isolatedDir: string) => Promise<T>): Promise<T> {
  const isolatedDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-checkpoint-api-tmpdir-isolation-"));
  const saved = { TMPDIR: process.env["TMPDIR"], TEMP: process.env["TEMP"], TMP: process.env["TMP"] };
  process.env["TMPDIR"] = isolatedDir;
  process.env["TEMP"] = isolatedDir;
  process.env["TMP"] = isolatedDir;
  try {
    return await fn(isolatedDir);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(isolatedDir, { recursive: true, force: true });
  }
}

/** Builds a raw two-member tar at `archivePath` from whatever `checkpoint.json`/`artifact` content a malformed-archive test wants — `undefined` omits that member entirely (the "archive missing checkpoint.json" case). */
async function buildRawArchive(archivePath: string, checkpointJsonText: string | undefined, artifactContent: string | undefined): Promise<void> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-archive-fixture-"));
  try {
    const members: string[] = [];
    if (checkpointJsonText !== undefined) {
      await fs.writeFile(path.join(workDir, "checkpoint.json"), checkpointJsonText);
      members.push("checkpoint.json");
    }
    if (artifactContent !== undefined) {
      await fs.writeFile(path.join(workDir, "artifact"), artifactContent);
      members.push("artifact");
    }
    const result = await runTar(TarCli.create(path.basename(archivePath), workDir, members), 30_000, path.dirname(archivePath));
    if (result.exitCode !== 0) {
      throw new Error(`test fixture: tar failed to build '${archivePath}': ${result.stderr}`);
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/** A well-formed `checkpoint.json` payload, named `seeded-db` under backend `fake-active` unless overridden — the base case every malformed-archive test mutates one field of. */
function archiveJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    rightsizeArchive: 1,
    name: "seeded-db",
    ref: "rightsize/checkpoint:seeded-db",
    backend: "fake-active",
    createdIso: "2026-01-01T00:00:00.000Z",
    spec: { env: { A: "1" }, command: ["sleep", "60"], exposedPorts: [80], memoryLimitMb: 256 },
    ...overrides,
  });
}

describe("Checkpoints.exportTo / importFrom — archive round trip", () => {
  it("round-trips the artifact's bytes and the metadata, propagating the effective ref into the returned Checkpoint and the registry entry", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      await withActiveBackend(backend, async () => {
        const entry = baseEntry();
        backend.artifacts.add(entry.ref);
        await writeCheckpointRegistryAtomic(dir, entry.name, entry);

        const cp: Checkpoint = { ref: entry.ref, backend: entry.backend, spec: fromCheckpointRegistryEntry(entry) };
        const archivePath = path.join(dir, "archive.tar");
        await Checkpoints.exportTo(cp, archivePath);

        assert.deepEqual(backend.exportCheckpointCalls.map((c) => c.ref), [entry.ref]);

        // Simulate msb-style digest remapping on import — the effective ref
        // must propagate all the way through, never the archive's own ref.
        backend.importEffectiveRef = () => "fake-effective-ref";
        const imported = await Checkpoints.importFrom(archivePath);

        assert.equal(imported.ref, "fake-effective-ref");
        assert.equal(imported.backend, entry.backend);
        assert.deepEqual(imported.spec.env, [["A", "1"]]);
        assert.deepEqual(imported.spec.command, ["sleep", "60"]);
        assert.equal(imported.spec.ports[0]?.guestPort, 80);
        assert.equal(imported.spec.memoryLimitMb, 256);

        assert.deepEqual(backend.importedArtifactContents, [`fake-artifact:${entry.ref}`], "expected the exported payload bytes to survive the archive round trip unchanged");

        const registryAfter = await readCheckpointRegistry(dir, entry.name);
        assert.equal(registryAfter.kind, "found");
        if (registryAfter.kind === "found") {
          assert.equal(registryAfter.entry.ref, "fake-effective-ref");
          assert.equal(registryAfter.entry.createdIso, entry.createdIso, "expected the original creation time to be preserved through the archive");
        }
      });
    });
  });

  it("a nameless (ephemeral) checkpoint exports with name: null and imports with no registry write", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      await withActiveBackend(backend, async () => {
        // Never written to the registry — an ephemeral checkpoint().
        const ref = "rightsize/checkpoint:ephemeral";
        backend.artifacts.add(ref);
        const cp: Checkpoint = { ref, backend: "fake-active", spec: fromCheckpointRegistryEntry(baseEntry({ ref, name: "unused" })) };

        const archivePath = path.join(dir, "ephemeral.tar");
        await Checkpoints.exportTo(cp, archivePath);

        const imported = await Checkpoints.importFrom(archivePath);
        assert.equal(imported.ref, ref);

        const names = await listCheckpointNames(dir);
        assert.deepEqual(names, [], "expected a nameless archive to write no registry entry at all");
      });
    });
  });

  it("export throws CheckpointBackendMismatchError before any backend call when cp.backend differs from the active backend", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      await withActiveBackend(backend, async () => {
        const cp: Checkpoint = { ref: "some-ref", backend: "fake-other", spec: fromCheckpointRegistryEntry(baseEntry()) };
        let thrown: unknown;
        try {
          await Checkpoints.exportTo(cp, path.join(dir, "mismatch.tar"));
        } catch (err) {
          thrown = err;
        }
        assert.ok(thrown instanceof CheckpointBackendMismatchError, `expected CheckpointBackendMismatchError, got: ${String(thrown)}`);
        assert.deepEqual(backend.hasCheckpointCalls, [], "expected no hasCheckpoint probe before the mismatch was detected");
        assert.deepEqual(backend.exportCheckpointCalls, []);
      });
    });
  });

  it("export throws CheckpointArtifactMissingError for a stale checkpoint, writing no archive file", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      await withActiveBackend(backend, async () => {
        // Deliberately never added to backend.artifacts — simulates the
        // artifact having been removed outside this library.
        const cp: Checkpoint = { ref: "gone-ref", backend: "fake-active", spec: fromCheckpointRegistryEntry(baseEntry()) };
        const archivePath = path.join(dir, "stale.tar");

        let thrown: unknown;
        try {
          await Checkpoints.exportTo(cp, archivePath);
        } catch (err) {
          thrown = err;
        }
        assert.ok(thrown instanceof CheckpointArtifactMissingError, `expected CheckpointArtifactMissingError, got: ${String(thrown)}`);
        assert.deepEqual(backend.exportCheckpointCalls, []);
        const archiveExists = await fs
          .stat(archivePath)
          .then(() => true)
          .catch(() => false);
        assert.equal(archiveExists, false, "expected no archive file to have been written for a stale checkpoint");
      });
    });
  });

  it("cleans its temp staging directory on both a successful export and a failed one", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      await withActiveBackend(backend, async () => {
        const entry = baseEntry();
        backend.artifacts.add(entry.ref);
        await writeCheckpointRegistryAtomic(dir, entry.name, entry);
        const cp: Checkpoint = { ref: entry.ref, backend: entry.backend, spec: fromCheckpointRegistryEntry(entry) };

        await withIsolatedTmpDir(async (isolatedDir) => {
          const stagingEntries = (): Promise<string[]> =>
            fs.readdir(isolatedDir).then((entries) => entries.filter((e) => e.startsWith("rightsize-checkpoint-export-")));

          await Checkpoints.exportTo(cp, path.join(dir, "ok.tar"));
          assert.deepEqual(await stagingEntries(), [], "expected no leftover temp dir after a successful export");

          backend.failNextExportCheckpoint = new Error("export boom");
          let thrown: unknown;
          try {
            await Checkpoints.exportTo(cp, path.join(dir, "fail.tar"));
          } catch (err) {
            thrown = err;
          }
          assert.ok(thrown instanceof Error);
          assert.deepEqual(await stagingEntries(), [], "expected no leftover temp dir after a failed export");
        });
      });
    });
  });
});

describe("Checkpoints.importFrom — malformed archives", () => {
  it("a missing file throws MalformedCheckpointArchiveError, no backend call", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      await withActiveBackend(backend, async () => {
        let thrown: unknown;
        try {
          await Checkpoints.importFrom(path.join(dir, "does-not-exist.tar"));
        } catch (err) {
          thrown = err;
        }
        assert.ok(thrown instanceof MalformedCheckpointArchiveError, `expected MalformedCheckpointArchiveError, got: ${String(thrown)}`);
        assert.deepEqual(backend.importCheckpointCalls, []);
      });
    });
  });

  it("an archive missing checkpoint.json throws MalformedCheckpointArchiveError, no backend call", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      await withActiveBackend(backend, async () => {
        const archivePath = path.join(dir, "no-checkpoint-json.tar");
        await buildRawArchive(archivePath, undefined, "payload");

        let thrown: unknown;
        try {
          await Checkpoints.importFrom(archivePath);
        } catch (err) {
          thrown = err;
        }
        assert.ok(thrown instanceof MalformedCheckpointArchiveError, `expected MalformedCheckpointArchiveError, got: ${String(thrown)}`);
        assert.deepEqual(backend.importCheckpointCalls, []);
      });
    });
  });

  it("a checkpoint.json that isn't valid JSON throws MalformedCheckpointArchiveError, no backend call", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      await withActiveBackend(backend, async () => {
        const archivePath = path.join(dir, "bad-json.tar");
        await buildRawArchive(archivePath, "{not valid json", "payload");

        let thrown: unknown;
        try {
          await Checkpoints.importFrom(archivePath);
        } catch (err) {
          thrown = err;
        }
        assert.ok(thrown instanceof MalformedCheckpointArchiveError, `expected MalformedCheckpointArchiveError, got: ${String(thrown)}`);
        assert.deepEqual(backend.importCheckpointCalls, []);
      });
    });
  });

  it("a wrong rightsizeArchive value throws MalformedCheckpointArchiveError naming the value, no backend call or registry write", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      await withActiveBackend(backend, async () => {
        const archivePath = path.join(dir, "bad-version.tar");
        await buildRawArchive(archivePath, archiveJson({ rightsizeArchive: 2 }), "payload");

        let thrown: unknown;
        try {
          await Checkpoints.importFrom(archivePath);
        } catch (err) {
          thrown = err;
        }
        assert.ok(thrown instanceof MalformedCheckpointArchiveError, `expected MalformedCheckpointArchiveError, got: ${String(thrown)}`);
        assert.match((thrown as Error).message, /2/);
        assert.deepEqual(backend.importCheckpointCalls, []);
        const registry = await readCheckpointRegistry(dir, "seeded-db");
        assert.equal(registry.kind, "missing");
      });
    });
  });

  it("an invalid name throws InvalidCheckpointNameError before any backend call or registry write", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      await withActiveBackend(backend, async () => {
        const archivePath = path.join(dir, "bad-name.tar");
        await buildRawArchive(archivePath, archiveJson({ name: "Bad_Name" }), "payload");

        let thrown: unknown;
        try {
          await Checkpoints.importFrom(archivePath);
        } catch (err) {
          thrown = err;
        }
        assert.ok(thrown instanceof InvalidCheckpointNameError, `expected InvalidCheckpointNameError, got: ${String(thrown)}`);
        assert.deepEqual(backend.importCheckpointCalls, []);
      });
    });
  });

  it("a backend mismatch throws CheckpointBackendMismatchError before any backend call or registry write", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      await withActiveBackend(backend, async () => {
        const archivePath = path.join(dir, "bad-backend.tar");
        await buildRawArchive(archivePath, archiveJson({ backend: "fake-other" }), "payload");

        let thrown: unknown;
        try {
          await Checkpoints.importFrom(archivePath);
        } catch (err) {
          thrown = err;
        }
        assert.ok(thrown instanceof CheckpointBackendMismatchError, `expected CheckpointBackendMismatchError, got: ${String(thrown)}`);
        assert.deepEqual(backend.importCheckpointCalls, []);
        const registry = await readCheckpointRegistry(dir, "seeded-db");
        assert.equal(registry.kind, "missing", "expected no registry write on a rejected import");
      });
    });
  });
});

describe("Checkpoints.importFrom — named-archive replace semantics", () => {
  it("removes the old same-backend artifact and rewrites the registry entry with the new effective ref", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      await withActiveBackend(backend, async () => {
        const oldEntry = baseEntry({ ref: "rightsize/checkpoint:old-ref" });
        backend.artifacts.add(oldEntry.ref);
        await writeCheckpointRegistryAtomic(dir, oldEntry.name, oldEntry);

        const archivePath = path.join(dir, "replace.tar");
        await buildRawArchive(archivePath, archiveJson({ ref: "rightsize/checkpoint:new-ref" }), "payload");
        backend.importEffectiveRef = () => "rightsize/checkpoint:new-ref";

        const imported = await Checkpoints.importFrom(archivePath);
        assert.equal(imported.ref, "rightsize/checkpoint:new-ref");
        assert.deepEqual(backend.removeCheckpointCalls, ["rightsize/checkpoint:old-ref"]);

        const registry = await readCheckpointRegistry(dir, "seeded-db");
        assert.equal(registry.kind, "found");
        if (registry.kind === "found") {
          assert.equal(registry.entry.ref, "rightsize/checkpoint:new-ref");
        }
      });
    });
  });

  it("leaves a cross-backend old entry's artifact untouched, only rewriting the registry entry", async () => {
    await withTempCacheDir(async (dir) => {
      const backend = new FakeArtifactBackend("fake-active");
      await withActiveBackend(backend, async () => {
        const oldEntry = baseEntry({ backend: "fake-other", ref: "rightsize/checkpoint:cross-backend-ref" });
        await writeCheckpointRegistryAtomic(dir, oldEntry.name, oldEntry);

        const archivePath = path.join(dir, "replace-cross.tar");
        await buildRawArchive(archivePath, archiveJson({ ref: "rightsize/checkpoint:new-ref" }), "payload");
        backend.importEffectiveRef = () => "rightsize/checkpoint:new-ref";

        const imported = await Checkpoints.importFrom(archivePath);
        assert.equal(imported.ref, "rightsize/checkpoint:new-ref");
        assert.deepEqual(backend.removeCheckpointCalls, [], "expected no removeCheckpoint call against a foreign backend's old entry");

        const registry = await readCheckpointRegistry(dir, "seeded-db");
        assert.equal(registry.kind, "found");
        if (registry.kind === "found") {
          assert.equal(registry.entry.ref, "rightsize/checkpoint:new-ref");
          assert.equal(registry.entry.backend, "fake-active", "expected the rewritten entry to now belong to the active backend");
        }
      });
    });
  });
});
