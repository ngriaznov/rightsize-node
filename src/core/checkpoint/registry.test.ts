import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert, afterEach } from "../../../test/harness.js";
import {
  checkpointsDir,
  checkpointRegistryPath,
  readCheckpointRegistry,
  writeCheckpointRegistryAtomic,
  removeCheckpointRegistryFile,
  listCheckpointNames,
  toCheckpointRegistrySpec,
  fromCheckpointRegistryEntry,
} from "./registry.js";
import type { CheckpointRegistryEntry } from "./registry.js";
import type { ContainerSpec } from "../model.js";
import { InvalidCheckpointNameError } from "../errors.js";

const tempDirs: string[] = [];

async function makeTempCacheDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-checkpoint-registry-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

function baseSpec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: "rz-testrun-1",
    image: "redis:8.6-alpine",
    env: [],
    command: undefined,
    ports: [],
    mounts: [],
    networkId: undefined,
    aliases: [],
    runId: "testrun",
    memoryLimitMb: undefined,
    keepAlive: false,
    checkpointRef: undefined,
    ...overrides,
  };
}

function baseEntry(overrides: Partial<CheckpointRegistryEntry> = {}): CheckpointRegistryEntry {
  return {
    name: "seeded-db",
    ref: "rightsize/checkpoint:seeded-db",
    backend: "docker",
    createdIso: "2026-01-01T00:00:00.000Z",
    spec: { env: {}, command: null, exposedPorts: [], memoryLimitMb: null },
    ...overrides,
  };
}

describe("checkpoint registry paths", () => {
  it("checkpointsDir is <cacheDir>/checkpoints", () => {
    assert.equal(checkpointsDir("/cache"), path.join("/cache", "checkpoints"));
  });

  it("checkpointRegistryPath is checkpoints/<name>.json", () => {
    assert.equal(checkpointRegistryPath("/cache", "seeded-db"), path.join("/cache", "checkpoints", "seeded-db.json"));
  });
});

describe("checkpoint name validation at the registry boundary (defense in depth)", () => {
  // These exercise the registry module directly, bypassing Checkpoints.find/
  // remove's own top-of-function requireValidCheckpointName call, to prove
  // checkpointRegistryPath itself — and everything built on it — rejects a
  // traversal shape before any path is ever resolved, independent of whether
  // a caller validated first.

  it("checkpointRegistryPath rejects a traversal name before building any path", () => {
    let thrown: unknown;
    try {
      checkpointRegistryPath("/cache", "../../../etc/passwd");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof InvalidCheckpointNameError, `expected InvalidCheckpointNameError, got: ${String(thrown)}`);
  });

  it("readCheckpointRegistry rejects a traversal name rather than resolving 'missing'", async () => {
    const dir = await makeTempCacheDir();
    let thrown: unknown;
    try {
      await readCheckpointRegistry(dir, "../secret");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof InvalidCheckpointNameError, `expected InvalidCheckpointNameError, got: ${String(thrown)}`);
  });

  it("removeCheckpointRegistryFile rejects a traversal name rather than silently no-op'ing", async () => {
    const dir = await makeTempCacheDir();
    let thrown: unknown;
    try {
      await removeCheckpointRegistryFile(dir, "../secret");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof InvalidCheckpointNameError, `expected InvalidCheckpointNameError, got: ${String(thrown)}`);
  });

  it("writeCheckpointRegistryAtomic rejects a traversal name before writing any file", async () => {
    const dir = await makeTempCacheDir();
    let thrown: unknown;
    try {
      await writeCheckpointRegistryAtomic(dir, "../secret", baseEntry({ name: "../secret" }));
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof InvalidCheckpointNameError, `expected InvalidCheckpointNameError, got: ${String(thrown)}`);
    // "../secret" resolved against checkpoints/ would escape one level up,
    // to <dir>/secret.json — confirm nothing was ever written there.
    const escapedFileExists = await fs
      .stat(path.join(dir, "secret.json"))
      .then(() => true)
      .catch(() => false);
    assert.equal(escapedFileExists, false, "expected no file to have been written outside the checkpoints directory");
  });
});

describe("readCheckpointRegistry", () => {
  it("resolves 'missing' for a name with no file at all", async () => {
    const dir = await makeTempCacheDir();
    const read = await readCheckpointRegistry(dir, "never-written");
    assert.equal(read.kind, "missing");
  });

  it("resolves 'corrupt' for malformed JSON", async () => {
    const dir = await makeTempCacheDir();
    await fs.mkdir(checkpointsDir(dir), { recursive: true });
    await fs.writeFile(checkpointRegistryPath(dir, "broken"), "{not json");
    const read = await readCheckpointRegistry(dir, "broken");
    assert.equal(read.kind, "corrupt");
  });

  it("resolves 'corrupt' for well-formed JSON missing a required field", async () => {
    const dir = await makeTempCacheDir();
    await fs.mkdir(checkpointsDir(dir), { recursive: true });
    await fs.writeFile(checkpointRegistryPath(dir, "partial"), JSON.stringify({ name: "partial" }));
    const read = await readCheckpointRegistry(dir, "partial");
    assert.equal(read.kind, "corrupt");
  });

  it("resolves 'corrupt' when spec.command is neither an array nor null", async () => {
    const dir = await makeTempCacheDir();
    const entry = { ...baseEntry(), spec: { env: {}, command: "not-an-array-or-null", exposedPorts: [], memoryLimitMb: null } };
    await fs.mkdir(checkpointsDir(dir), { recursive: true });
    await fs.writeFile(checkpointRegistryPath(dir, "bad-command"), JSON.stringify(entry));
    const read = await readCheckpointRegistry(dir, "bad-command");
    assert.equal(read.kind, "corrupt");
  });

  it("resolves 'found' with the exact entry for a well-shaped file", async () => {
    const dir = await makeTempCacheDir();
    const entry = baseEntry();
    await writeCheckpointRegistryAtomic(dir, entry.name, entry);
    const read = await readCheckpointRegistry(dir, entry.name);
    assert.equal(read.kind, "found");
    if (read.kind === "found") {
      assert.deepEqual(read.entry, entry);
    }
  });
});

describe("writeCheckpointRegistryAtomic / removeCheckpointRegistryFile", () => {
  it("writes exactly the pinned JSON field names", async () => {
    const dir = await makeTempCacheDir();
    const entry = baseEntry({ spec: { env: { A: "1" }, command: ["sleep", "60"], exposedPorts: [80], memoryLimitMb: 256 } });
    await writeCheckpointRegistryAtomic(dir, entry.name, entry);

    const raw = await fs.readFile(checkpointRegistryPath(dir, entry.name), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), ["backend", "createdIso", "name", "ref", "spec"].sort());
    const spec = parsed["spec"] as Record<string, unknown>;
    assert.deepEqual(Object.keys(spec).sort(), ["command", "env", "exposedPorts", "memoryLimitMb"].sort());
  });

  it("a second write for the same name REPLACES the file's content", async () => {
    const dir = await makeTempCacheDir();
    const first = baseEntry({ ref: "rightsize/checkpoint:seeded-db", createdIso: "2026-01-01T00:00:00.000Z" });
    await writeCheckpointRegistryAtomic(dir, first.name, first);
    const second = baseEntry({ ref: "rightsize/checkpoint:seeded-db", createdIso: "2026-06-01T00:00:00.000Z" });
    await writeCheckpointRegistryAtomic(dir, second.name, second);

    const read = await readCheckpointRegistry(dir, "seeded-db");
    assert.equal(read.kind, "found");
    if (read.kind === "found") {
      assert.equal(read.entry.createdIso, "2026-06-01T00:00:00.000Z");
    }
  });

  it("removeCheckpointRegistryFile deletes an existing file", async () => {
    const dir = await makeTempCacheDir();
    const entry = baseEntry();
    await writeCheckpointRegistryAtomic(dir, entry.name, entry);
    await removeCheckpointRegistryFile(dir, entry.name);
    const read = await readCheckpointRegistry(dir, entry.name);
    assert.equal(read.kind, "missing");
  });

  it("removeCheckpointRegistryFile on a name that was never written is a harmless no-op", async () => {
    const dir = await makeTempCacheDir();
    await removeCheckpointRegistryFile(dir, "never-existed"); // must not throw
  });
});

describe("listCheckpointNames", () => {
  it("resolves an empty list when the checkpoints directory doesn't exist yet", async () => {
    const dir = await makeTempCacheDir();
    const names = await listCheckpointNames(dir);
    assert.deepEqual(names, []);
  });

  it("lists every written name, excluding the atomic-write tmp files", async () => {
    const dir = await makeTempCacheDir();
    await writeCheckpointRegistryAtomic(dir, "one", baseEntry({ name: "one" }));
    await writeCheckpointRegistryAtomic(dir, "two", baseEntry({ name: "two" }));
    // A leftover tmp file, as if a write had crashed mid-way — never a real entry.
    await fs.writeFile(path.join(checkpointsDir(dir), ".three.json.tmp-1-1"), "garbage");

    const names = await listCheckpointNames(dir);
    assert.deepEqual(names.sort(), ["one", "two"]);
  });
});

describe("toCheckpointRegistrySpec / fromCheckpointRegistryEntry", () => {
  it("toCheckpointRegistrySpec reduces a ContainerSpec to the pinned shape", () => {
    const spec = baseSpec({
      env: [
        ["A", "1"],
        ["B", "2"],
      ],
      command: ["sleep", "60"],
      ports: [{ hostPort: 15999, guestPort: 80 }],
      memoryLimitMb: 256,
    });
    const reduced = toCheckpointRegistrySpec(spec);
    assert.deepEqual(reduced, { env: { A: "1", B: "2" }, command: ["sleep", "60"], exposedPorts: [80], memoryLimitMb: 256 });
  });

  it("toCheckpointRegistrySpec normalizes undefined command/memoryLimitMb to null", () => {
    const spec = baseSpec({ command: undefined, memoryLimitMb: undefined });
    const reduced = toCheckpointRegistrySpec(spec);
    assert.equal(reduced.command, null);
    assert.equal(reduced.memoryLimitMb, null);
  });

  it("fromCheckpointRegistryEntry reconstructs exactly the four fields fromCheckpoint() reads", () => {
    const entry = baseEntry({
      ref: "rightsize/checkpoint:seeded-db",
      spec: { env: { A: "1" }, command: ["sleep", "60"], exposedPorts: [80], memoryLimitMb: 256 },
    });
    const spec = fromCheckpointRegistryEntry(entry);
    assert.deepEqual(spec.env, [["A", "1"]]);
    assert.deepEqual(spec.command, ["sleep", "60"]);
    assert.equal(spec.ports.length, 1);
    assert.equal(spec.ports[0]?.guestPort, 80);
    assert.equal(spec.memoryLimitMb, 256);
    assert.equal(spec.checkpointRef, entry.ref);
  });

  it("fromCheckpointRegistryEntry normalizes null command/memoryLimitMb back to undefined", () => {
    const entry = baseEntry({ spec: { env: {}, command: null, exposedPorts: [], memoryLimitMb: null } });
    const spec = fromCheckpointRegistryEntry(entry);
    assert.equal(spec.command, undefined);
    assert.equal(spec.memoryLimitMb, undefined);
  });

  it("a round trip through toCheckpointRegistrySpec then fromCheckpointRegistryEntry preserves env/command/guestPorts/memoryLimitMb", () => {
    const original = baseSpec({
      env: [["FOO", "bar"]],
      command: ["node", "server.js"],
      ports: [
        { hostPort: 1, guestPort: 8080 },
        { hostPort: 2, guestPort: 9090 },
      ],
      memoryLimitMb: 512,
    });
    const reduced = toCheckpointRegistrySpec(original);
    const entry = baseEntry({ spec: reduced });
    const reconstructed = fromCheckpointRegistryEntry(entry);

    assert.deepEqual(reconstructed.env, original.env);
    assert.deepEqual(reconstructed.command, original.command);
    assert.deepEqual(
      reconstructed.ports.map((p) => p.guestPort),
      original.ports.map((p) => p.guestPort),
    );
    assert.equal(reconstructed.memoryLimitMb, original.memoryLimitMb);
  });
});
