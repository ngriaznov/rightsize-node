import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert } from "../../../test/harness.js";
import {
  parseCheckpointArchiveMetadata,
  writeCheckpointArchive,
  readCheckpointArchive,
  CHECKPOINT_ARCHIVE_VERSION,
} from "./archive.js";
import type { CheckpointArchiveMetadata } from "./archive.js";
import { MalformedCheckpointArchiveError } from "../errors.js";

function validMetadata(overrides: Partial<CheckpointArchiveMetadata> = {}): CheckpointArchiveMetadata {
  return {
    rightsizeArchive: 1,
    name: "seeded-db",
    ref: "rightsize/checkpoint:seeded-db",
    backend: "docker",
    createdIso: "2026-01-01T00:00:00.000Z",
    spec: { env: { A: "1" }, command: ["sleep", "60"], exposedPorts: [80], memoryLimitMb: 256 },
    ...overrides,
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-archive-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Points `os.tmpdir()` at a private, empty directory for the duration of
 * `fn` (Node reads `TMPDIR`/`TEMP`/`TMP` live on every call — never cached
 * at startup), then restores the prior env and removes it. Needed only by
 * the staging-cleanup assertions below: `writeCheckpointArchive`/
 * `readCheckpointArchive` stage under the REAL `os.tmpdir()` with a shared
 * `rightsize-checkpoint-{export,import}-*` prefix, and other test FILES
 * (each `node --test`/`bun test` file is its own process) exercise the same
 * production code concurrently — diffing the real system tmpdir would race
 * their staging directories against this file's own before/after snapshots.
 */
async function withIsolatedTmpDir<T>(fn: (isolatedDir: string) => Promise<T>): Promise<T> {
  const isolatedDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-archive-tmpdir-isolation-"));
  const saved = {
    TMPDIR: process.env["TMPDIR"],
    TEMP: process.env["TEMP"],
    TMP: process.env["TMP"],
  };
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

describe("parseCheckpointArchiveMetadata", () => {
  it("parses a well-formed checkpoint.json", () => {
    const metadata = parseCheckpointArchiveMetadata(JSON.stringify(validMetadata()), "/archives/x.tar");
    assert.deepEqual(metadata, validMetadata());
  });

  it("accepts name: null (an unnamed/ephemeral checkpoint)", () => {
    const metadata = parseCheckpointArchiveMetadata(JSON.stringify(validMetadata({ name: null })), "/archives/x.tar");
    assert.equal(metadata.name, null);
  });

  it("throws MalformedCheckpointArchiveError naming the archive on invalid JSON", () => {
    let thrown: unknown;
    try {
      parseCheckpointArchiveMetadata("{not json", "/archives/x.tar");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof MalformedCheckpointArchiveError, `expected MalformedCheckpointArchiveError, got: ${String(thrown)}`);
    assert.equal((thrown as MalformedCheckpointArchiveError).archivePath, "/archives/x.tar");
  });

  it("throws naming the unsupported version when rightsizeArchive isn't the current version", () => {
    let thrown: unknown;
    try {
      parseCheckpointArchiveMetadata(JSON.stringify(validMetadata({ rightsizeArchive: 2 as 1 })), "/archives/x.tar");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof MalformedCheckpointArchiveError, `expected MalformedCheckpointArchiveError, got: ${String(thrown)}`);
    assert.match((thrown as Error).message, /2/);
    assert.match((thrown as Error).message, new RegExp(String(CHECKPOINT_ARCHIVE_VERSION)));
  });

  it("throws when 'name' is neither a string nor null", () => {
    const raw = { ...validMetadata(), name: 42 };
    let thrown: unknown;
    try {
      parseCheckpointArchiveMetadata(JSON.stringify(raw), "/archives/x.tar");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof MalformedCheckpointArchiveError, `expected MalformedCheckpointArchiveError, got: ${String(thrown)}`);
  });

  it("throws when a required string field is missing", () => {
    const raw: Record<string, unknown> = { ...validMetadata() };
    delete raw["backend"];
    let thrown: unknown;
    try {
      parseCheckpointArchiveMetadata(JSON.stringify(raw), "/archives/x.tar");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof MalformedCheckpointArchiveError, `expected MalformedCheckpointArchiveError, got: ${String(thrown)}`);
  });

  it("throws when 'spec' is missing or malformed", () => {
    const raw = { ...validMetadata(), spec: { env: {}, command: null, exposedPorts: "not-an-array", memoryLimitMb: null } };
    let thrown: unknown;
    try {
      parseCheckpointArchiveMetadata(JSON.stringify(raw), "/archives/x.tar");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof MalformedCheckpointArchiveError, `expected MalformedCheckpointArchiveError, got: ${String(thrown)}`);
  });
});

describe("writeCheckpointArchive / readCheckpointArchive — the tar container itself", () => {
  it("round-trips checkpoint.json and the artifact byte-for-byte through a real tar file", async () => {
    await withTempDir(async (dir) => {
      const archivePath = path.join(dir, "out", "archive.tar");
      const metadata = validMetadata();

      await writeCheckpointArchive(archivePath, metadata, async (artifactPath) => {
        await fs.writeFile(artifactPath, "the-artifact-bytes");
      });

      const stat = await fs.stat(archivePath);
      assert.ok(stat.isFile(), "expected the parent directory to have been created and the archive written into it");

      const result = await readCheckpointArchive(archivePath, async (parsedMetadata, artifactPath) => {
        const content = await fs.readFile(artifactPath, "utf8");
        return { parsedMetadata, content };
      });

      assert.deepEqual(result.parsedMetadata, metadata);
      assert.equal(result.content, "the-artifact-bytes");
    });
  });

  it("overwrites a pre-existing file at destPath", async () => {
    await withTempDir(async (dir) => {
      const archivePath = path.join(dir, "archive.tar");
      await fs.writeFile(archivePath, "stale content that must not survive");

      await writeCheckpointArchive(archivePath, validMetadata(), async (artifactPath) => {
        await fs.writeFile(artifactPath, "fresh-artifact");
      });

      const result = await readCheckpointArchive(archivePath, async (metadata) => metadata);
      assert.equal(result.ref, validMetadata().ref);
    });
  });

  it("readCheckpointArchive throws MalformedCheckpointArchiveError for a file that does not exist", async () => {
    await withTempDir(async (dir) => {
      let thrown: unknown;
      try {
        await readCheckpointArchive(path.join(dir, "nope.tar"), async () => undefined);
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof MalformedCheckpointArchiveError, `expected MalformedCheckpointArchiveError, got: ${String(thrown)}`);
    });
  });

  it("readCheckpointArchive throws MalformedCheckpointArchiveError for a file that isn't a valid tar", async () => {
    await withTempDir(async (dir) => {
      const notATar = path.join(dir, "not-a-tar.tar");
      await fs.writeFile(notATar, "this is definitely not tar data");

      let thrown: unknown;
      try {
        await readCheckpointArchive(notATar, async () => undefined);
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof MalformedCheckpointArchiveError, `expected MalformedCheckpointArchiveError, got: ${String(thrown)}`);
    });
  });

  it("temp directories are cleaned up on both a successful and a failed importArtifact/exportArtifact callback", async () => {
    await withIsolatedTmpDir(async (isolatedDir) => {
      const outDir = await fs.mkdtemp(path.join(isolatedDir, "out-"));
      const stagingEntries = (): Promise<string[]> =>
        fs.readdir(isolatedDir).then((entries) => entries.filter((e) => e.startsWith("rightsize-checkpoint-")));

      const archivePath = path.join(outDir, "cleanup.tar");
      await writeCheckpointArchive(archivePath, validMetadata(), async (artifactPath) => {
        await fs.writeFile(artifactPath, "ok");
      });
      assert.deepEqual(await stagingEntries(), [], "expected no leftover export staging dir after a successful export");

      let exportThrown: unknown;
      try {
        await writeCheckpointArchive(path.join(outDir, "cleanup-fail.tar"), validMetadata(), async () => {
          throw new Error("boom: export artifact failed");
        });
      } catch (err) {
        exportThrown = err;
      }
      assert.ok(exportThrown instanceof Error);
      assert.deepEqual(await stagingEntries(), [], "expected no leftover export staging dir after a failed export");

      let importThrown: unknown;
      try {
        await readCheckpointArchive(archivePath, async () => {
          throw new Error("boom: import artifact failed");
        });
      } catch (err) {
        importThrown = err;
      }
      assert.ok(importThrown instanceof Error);
      assert.deepEqual(await stagingEntries(), [], "expected no leftover import staging dir after a failed import");
    });
  });
});
