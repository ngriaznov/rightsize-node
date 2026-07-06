import { describe, it, assert } from "../../test/harness.js";
import { isImageCacheCorruption } from "./image-cache.js";

describe("isImageCacheCorruption", () => {
  it("matches the captured msb error verbatim", () => {
    // Captured verbatim from a real msb 0.6.3 binary, reproduced by racing
    // concurrent `msb run` of images sharing a base layer against one fresh
    // cache (see the classifier's doc for the full repro).
    const output =
      "   ✗ Pulling      floci/floci-gcp:0.4.0\n" +
      "error: image error: cache error at /home/runner/.microsandbox/cache/layers/" +
      "sha256_2a9a84f53fe64d76a54296ab37a4664aacef9f848d4aa6ad7efd84b135a351c6.tar.gz: " +
      "No such file or directory (os error 2)\n";
    assert.ok(isImageCacheCorruption(output));
  });

  it("matches regardless of which image, digest, or host path", () => {
    // Path, digest, and image name all vary per host/run — the classifier
    // must match on the stable parts of msb's wording only.
    assert.ok(
      isImageCacheCorruption(
        "error: image error: cache error at /tmp/msb-repro/cache/layers/" +
          "sha256_c01d7b7a3f78972c12a4244ffb10257694b9d989c40172ab6184de42b967ab85.tar.gz: " +
          "No such file or directory (os error 2)",
      ),
    );
    assert.ok(
      isImageCacheCorruption(
        "error: cache error at C:\\Users\\runner\\.microsandbox\\cache\\layers\\" +
          "sha256_deadbeef.tar.gz: No such file or directory (os error 2)",
      ),
    );
  });

  it("does not match unrelated failures", () => {
    assert.ok(!isImageCacheCorruption("panic: index out of bounds"));
    assert.ok(!isImageCacheCorruption(""));
    assert.ok(!isImageCacheCorruption("error: image not found: floci/floci-az:0.8.0"));
  });

  it("does not match a workload's own missing-file complaint", () => {
    // A generic "No such file" with no cache-error framing must not
    // false-positive (e.g. a workload's own stderr complaining about a
    // missing file it expected).
    assert.ok(!isImageCacheCorruption("sh: /app/config.yaml: No such file or directory"));
  });

  it("does not match a cache error that is not about a missing file", () => {
    assert.ok(
      !isImageCacheCorruption(
        "error: cache error at /tmp/x/layers/sha256_abc.tar.gz: Permission denied (os error 13)",
      ),
    );
  });
});
