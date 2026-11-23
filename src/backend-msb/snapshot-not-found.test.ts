import { describe, it, assert } from "../../test/harness.js";
import { isSnapshotNotFoundError } from "./snapshot-not-found.js";

describe("isSnapshotNotFoundError", () => {
  it("matches the captured 'snapshot not found' shape verbatim (real msb 0.6.8 binary)", () => {
    assert.ok(isSnapshotNotFoundError("error: snapshot not found: /home/user/.microsandbox/snapshots/rz-ckpt-abc123"));
  });

  it("matches the msb 0.8.1 missing group/member shape", () => {
    assert.ok(isSnapshotNotFoundError("error: io error: No such file or directory (os error 2)"));
  });

  it("matches the localized Windows io error shape", () => {
    assert.ok(isSnapshotNotFoundError("error: io error: The system cannot find the file specified. (os error 2)"));
  });

  it("matches when embedded in a larger stderr blob", () => {
    assert.ok(isSnapshotNotFoundError("some preceding line\nerror: snapshot not found: rz-ckpt-abc123\n"));
  });

  it("does not match an unrelated msb failure, e.g. its state-database error", () => {
    assert.ok(
      !isSnapshotNotFoundError(
        "error: database error: Execution Error: error returned from database: " +
          "(code: 1) index idx_manifest_layers_unique already exists",
      ),
    );
  });

  it("does not match an unrelated msb failure, e.g. its image-cache error", () => {
    assert.ok(
      !isSnapshotNotFoundError(
        "error: image error: cache error at /tmp/cache/layers/sha256_dead.tar.gz: No such file or directory (os error 2)",
      ),
    );
  });

  it("does not match empty output", () => {
    assert.ok(!isSnapshotNotFoundError(""));
  });
});
