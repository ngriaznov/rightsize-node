import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert, beforeEach, afterEach } from "../../../test/harness.js";
import { readRegistry, writeRegistryAtomic, removeRegistry, reusePath, type ReuseRegistryEntry } from "./registry.js";

const HASH = "799aad5a3338ce3d36999c7ff2733d4673c0592d417563f334544693ec1907a5";

function makeEntry(overrides: Partial<ReuseRegistryEntry> = {}): ReuseRegistryEntry {
  return {
    name: "rz-reuse-799aad5a3338",
    image: "redis:7-alpine",
    ports: { "6379": 54321 },
    createdIso: "2026-01-01T00:00:00.000Z",
    backend: "microsandbox",
    ...overrides,
  };
}

describe("reuse registry", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-reuse-registry-test-"));
  });

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it("reusePath is <cacheDir>/reuse/<hash>.json", () => {
    assert.equal(reusePath(cacheDir, HASH), path.join(cacheDir, "reuse", `${HASH}.json`));
  });

  it("readRegistry reports 'missing' when no file exists — no directory created as a side effect", async () => {
    const result = await readRegistry(cacheDir, HASH);
    assert.equal(result.kind, "missing");
    await assert.rejects(() => fs.stat(path.join(cacheDir, "reuse")));
  });

  it("writeRegistryAtomic then readRegistry round-trips the entry exactly, via a real rename (no partial file ever visible)", async () => {
    const entry = makeEntry();
    await writeRegistryAtomic(cacheDir, HASH, entry);

    const result = await readRegistry(cacheDir, HASH);
    assert.equal(result.kind, "found");
    assert.deepEqual(result.kind === "found" ? result.entry : undefined, entry);

    // No stray tmp file left behind after a successful write.
    const files = await fs.readdir(path.join(cacheDir, "reuse"));
    assert.deepEqual(files, [`${HASH}.json`]);
  });

  it("readRegistry reports 'corrupt' for unparseable JSON, distinct from 'missing'", async () => {
    const dir = path.join(cacheDir, "reuse");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${HASH}.json`), "{ not json");

    const result = await readRegistry(cacheDir, HASH);
    assert.equal(result.kind, "corrupt");
  });

  it("readRegistry reports 'corrupt' for well-formed JSON missing a required field", async () => {
    const dir = path.join(cacheDir, "reuse");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${HASH}.json`), JSON.stringify({ name: "rz-reuse-abc" }));

    const result = await readRegistry(cacheDir, HASH);
    assert.equal(result.kind, "corrupt");
  });

  it("removeRegistry deletes the file; missing file is a silent no-op", async () => {
    await writeRegistryAtomic(cacheDir, HASH, makeEntry());
    await removeRegistry(cacheDir, HASH);
    assert.equal((await readRegistry(cacheDir, HASH)).kind, "missing");

    // Idempotent: removing again (nothing there) never throws.
    await removeRegistry(cacheDir, HASH);
  });

  it("a later write for the same hash overwrites the earlier entry", async () => {
    await writeRegistryAtomic(cacheDir, HASH, makeEntry({ ports: { "6379": 1111 } }));
    await writeRegistryAtomic(cacheDir, HASH, makeEntry({ ports: { "6379": 2222 } }));

    const result = await readRegistry(cacheDir, HASH);
    assert.equal(result.kind, "found");
    assert.deepEqual(result.kind === "found" ? result.entry.ports : undefined, { "6379": 2222 });
  });
});
