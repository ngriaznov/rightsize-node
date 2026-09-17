import { describe, it, assert } from "../../test/harness.js";
import { isSnapshotHeadRemovalRefused } from "./snapshot-rm.js";

describe("isSnapshotHeadRemovalRefused", () => {
  it("matches the captured 'cannot remove current head' shape verbatim (real msb 0.7.1 binary)", () => {
    assert.ok(
      isSnapshotHeadRemovalRefused(
        "error: invalid config: cannot remove current head snap_abcdef0123456789abcdef0123456789; " +
          "first select another snapshot with 'msb snapshot head src:box-1'",
      ),
    );
  });

  it("matches when embedded in a larger stderr blob", () => {
    assert.ok(
      isSnapshotHeadRemovalRefused("some preceding line\nerror: invalid config: cannot remove current head snap_abc\n"),
    );
  });

  it("does not match a plain 'not found' failure", () => {
    assert.ok(!isSnapshotHeadRemovalRefused("error: snapshot not found: /cache/checkpoints/box-1/snap_abc"));
  });

  it("does not match an unrelated msb failure, e.g. its state-database error", () => {
    assert.ok(
      !isSnapshotHeadRemovalRefused(
        "error: database error: Execution Error: error returned from database: " +
          "(code: 1) index idx_manifest_layers_unique already exists",
      ),
    );
  });

  it("does not match empty output", () => {
    assert.ok(!isSnapshotHeadRemovalRefused(""));
  });
});
