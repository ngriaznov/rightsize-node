import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert, beforeEach, afterEach } from "../../../test/harness.js";
import { reuseHash, reuseName, type ReuseIdentitySpec } from "./hash.js";

function baseIdentity(overrides: Partial<ReuseIdentitySpec> = {}): ReuseIdentitySpec {
  return {
    image: "redis:7-alpine",
    env: [["A", "1"], ["B", "2"]],
    command: undefined,
    exposedPorts: [6379],
    memoryLimitMb: undefined,
    copies: [],
    ...overrides,
  };
}

// The feature spec's pinned cross-language contract vector: `{image:
// "redis:7-alpine", env: {A: "1", B: "2"}, command: [], exposedPorts:
// [6379], memoryLimitMb: null, copies: []}` MUST hash to the same value in
// every rightsize language implementation — this is that fixed value for
// the Node/TypeScript implementation, cross-checked against the Kotlin and
// Rust repos out of band.
const PINNED_VECTOR_HASH = "799aad5a3338ce3d36999c7ff2733d4673c0592d417563f334544693ec1907a5";

describe("reuseHash — the pinned cross-language contract vector", () => {
  it("hashes the spec pinned by the reuse spec/addendum to the fixed cross-language value", async () => {
    const spec = baseIdentity();
    const hash = await reuseHash(spec);
    assert.equal(hash, PINNED_VECTOR_HASH);
    // Deterministic: hashing the identical logical spec twice yields the same digest.
    assert.equal(await reuseHash(baseIdentity()), hash);
  });

  it("the pinned vector's derived name is rz-reuse-<first 12 hex chars>", () => {
    assert.equal(reuseName(PINNED_VECTOR_HASH), "rz-reuse-799aad5a3338");
  });
});

describe("reuseHash — identity rules", () => {
  it("env key order does not affect the hash (canonicalized by sorting)", async () => {
    const a = await reuseHash(baseIdentity({ env: [["A", "1"], ["B", "2"]] }));
    const b = await reuseHash(baseIdentity({ env: [["B", "2"], ["A", "1"]] }));
    assert.equal(a, b);
  });

  it("a different image changes the hash", async () => {
    const a = await reuseHash(baseIdentity({ image: "redis:7-alpine" }));
    const b = await reuseHash(baseIdentity({ image: "redis:7.2-alpine" }));
    assert.ok(a !== b);
  });

  it("a different env value changes the hash", async () => {
    const a = await reuseHash(baseIdentity({ env: [["A", "1"]] }));
    const b = await reuseHash(baseIdentity({ env: [["A", "2"]] }));
    assert.ok(a !== b);
  });

  it("command undefined and command [] hash identically (both mean 'no command override')", async () => {
    const a = await reuseHash(baseIdentity({ command: undefined }));
    const b = await reuseHash(baseIdentity({ command: [] }));
    assert.equal(a, b);
  });

  it("a different command changes the hash", async () => {
    const a = await reuseHash(baseIdentity({ command: ["redis-server"] }));
    const b = await reuseHash(baseIdentity({ command: ["redis-server", "--appendonly", "yes"] }));
    assert.ok(a !== b);
  });

  it("exposedPorts order does not affect the hash (canonicalized by sorting)", async () => {
    const a = await reuseHash(baseIdentity({ exposedPorts: [6379, 8080] }));
    const b = await reuseHash(baseIdentity({ exposedPorts: [8080, 6379] }));
    assert.equal(a, b);
  });

  it("a different set of exposedPorts changes the hash", async () => {
    const a = await reuseHash(baseIdentity({ exposedPorts: [6379] }));
    const b = await reuseHash(baseIdentity({ exposedPorts: [6379, 8080] }));
    assert.ok(a !== b);
  });

  it("memoryLimitMb undefined vs a set value changes the hash", async () => {
    const a = await reuseHash(baseIdentity({ memoryLimitMb: undefined }));
    const b = await reuseHash(baseIdentity({ memoryLimitMb: 512 }));
    assert.ok(a !== b);
  });
});

describe("reuseHash — copy content and path", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-reuse-hash-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("a copy's content change (same guestPath) changes the hash", async () => {
    const fileA = path.join(tmpDir, "a.txt");
    const fileB = path.join(tmpDir, "b.txt");
    await fs.writeFile(fileA, "hello");
    await fs.writeFile(fileB, "goodbye");

    const withA = await reuseHash(baseIdentity({ copies: [{ guestPath: "/etc/conf", hostPath: fileA }] }));
    const withB = await reuseHash(baseIdentity({ copies: [{ guestPath: "/etc/conf", hostPath: fileB }] }));
    assert.ok(withA !== withB);
  });

  it("copy guestPath order does not affect the hash (canonicalized by sorting on guestPath)", async () => {
    const fileA = path.join(tmpDir, "a.txt");
    const fileB = path.join(tmpDir, "b.txt");
    await fs.writeFile(fileA, "hello");
    await fs.writeFile(fileB, "goodbye");

    const forward = await reuseHash(
      baseIdentity({
        copies: [
          { guestPath: "/a", hostPath: fileA },
          { guestPath: "/b", hostPath: fileB },
        ],
      }),
    );
    const reversed = await reuseHash(
      baseIdentity({
        copies: [
          { guestPath: "/b", hostPath: fileB },
          { guestPath: "/a", hostPath: fileA },
        ],
      }),
    );
    assert.equal(forward, reversed);
  });

  it("the same content copied to a different guestPath changes the hash", async () => {
    const file = path.join(tmpDir, "same.txt");
    await fs.writeFile(file, "identical content");

    const a = await reuseHash(baseIdentity({ copies: [{ guestPath: "/one", hostPath: file }] }));
    const b = await reuseHash(baseIdentity({ copies: [{ guestPath: "/two", hostPath: file }] }));
    assert.ok(a !== b);
  });
});

describe("reuseName", () => {
  it("is 'rz-reuse-' followed by the first 12 hex chars of the hash", () => {
    const hash = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567";
    assert.equal(reuseName(hash), "rz-reuse-abcdef012345");
  });
});
