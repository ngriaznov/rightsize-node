import * as path from "node:path";
import { describe, it, assert } from "../../../test/harness.js";
import { checkpointRef } from "./ref.js";
import { cacheDir } from "../cache-dir.js";

/** Runs `fn` with `RIGHTSIZE_CACHE_DIR` pinned to a known value, then restores the prior env value regardless of outcome. */
function withCacheDirEnv<T>(dir: string, fn: () => T): T {
  const saved = process.env["RIGHTSIZE_CACHE_DIR"];
  process.env["RIGHTSIZE_CACHE_DIR"] = dir;
  try {
    return fn();
  } finally {
    if (saved === undefined) {
      delete process.env["RIGHTSIZE_CACHE_DIR"];
    } else {
      process.env["RIGHTSIZE_CACHE_DIR"] = saved;
    }
  }
}

describe("checkpointRef", () => {
  it("mints an absolute <cacheDir>/checkpoints/rz-ckpt-<12-hex> ref for the microsandbox backend", () => {
    withCacheDirEnv("/fake/cache", () => {
      const ref = checkpointRef("microsandbox", undefined);
      assert.equal(path.isAbsolute(ref), true, "expected a path ref");
      assert.match(ref, /^.*[/\\]checkpoints[/\\]rz-ckpt-[0-9a-f]{12}$/);
      // path.resolve, not path.join: production absolutizes with resolve, which on
      // Windows prepends the current drive to a rootless override like /fake/cache.
      assert.equal(ref, path.resolve(cacheDir(), "checkpoints", ref.slice(ref.lastIndexOf("rz-ckpt-"))));
    });
  });

  it("mints a deterministic path ref from a name: <cacheDir>/checkpoints/rz-ckpt-<name>", () => {
    withCacheDirEnv("/fake/cache", () => {
      const ref = checkpointRef("microsandbox", "seeded-db");
      assert.equal(ref, path.resolve("/fake/cache", "checkpoints", "rz-ckpt-seeded-db"));
    });
  });

  it("leaves the docker ref form unchanged: rightsize/checkpoint:<suffix>, never a path", () => {
    withCacheDirEnv("/fake/cache", () => {
      const unnamed = checkpointRef("docker", undefined);
      assert.match(unnamed, /^rightsize\/checkpoint:[0-9a-f]{12}$/);

      const named = checkpointRef("docker", "seeded-db");
      assert.equal(named, "rightsize/checkpoint:seeded-db");
    });
  });

  it("respects the RIGHTSIZE_CACHE_DIR override when minting a microsandbox path ref", () => {
    withCacheDirEnv("/another/cache/dir", () => {
      const ref = checkpointRef("microsandbox", "seeded-db");
      assert.equal(ref, path.resolve("/another/cache/dir", "checkpoints", "rz-ckpt-seeded-db"));
    });
  });

  it("resolves a RELATIVE RIGHTSIZE_CACHE_DIR override to an absolute ref, not a relative one", () => {
    withCacheDirEnv(path.join("relative", "cache", "dir"), () => {
      const ref = checkpointRef("microsandbox", "seeded-db");
      assert.equal(
        path.isAbsolute(ref),
        true,
        "expected an absolute ref even from a relative RIGHTSIZE_CACHE_DIR — every path-ref branch " +
          "(MsbCliBackend's isPathRef, hasCheckpoint/removeCheckpoint's path.isAbsolute(ref)) classifies " +
          "a ref by absoluteness alone, and a relative one would silently misclassify as a bare name",
      );
      assert.equal(ref, path.resolve(path.join("relative", "cache", "dir"), "checkpoints", "rz-ckpt-seeded-db"));
    });
  });
});
