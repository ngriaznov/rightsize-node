import { describe, it, assert } from "../../test/harness.js";
import { isRestoreAccessDeniedFailure } from "./restore-access-denied.js";

describe("isRestoreAccessDeniedFailure", () => {
  it("matches the captured Windows restore failure verbatim", () => {
    // Captured shape: msb 0.7.1 restoring a snapshot artifact whose
    // Windows file handle from the just-completed stop/snapshot cycle
    // hasn't been released yet.
    assert.ok(
      isRestoreAccessDeniedFailure(
        "restore rz-ckpt-fccd7568 --name rz-abc12345-1 failed (exit 1): error: io error: Access is denied. (os error 5)",
      ),
    );
  });

  it("requires BOTH 'Access is denied' and one of 'io error'/'os error 5' — neither alone is enough", () => {
    assert.ok(!isRestoreAccessDeniedFailure("error: io error: The system cannot find the file specified. (os error 2)"));
    assert.ok(!isRestoreAccessDeniedFailure("error: permission denied: Access is denied by policy"), "os error 5' text absent");
    assert.ok(!isRestoreAccessDeniedFailure(""));
  });

  it("matches when only 'os error 5' accompanies 'Access is denied', without the literal 'io error' phrase", () => {
    assert.ok(isRestoreAccessDeniedFailure("error: Access is denied. (os error 5)"));
  });

  it("does not match other msb restore failures", () => {
    assert.ok(!isRestoreAccessDeniedFailure("error: failed to restore snapshot 'rz-ckpt-x': destination disk is full"));
    assert.ok(!isRestoreAccessDeniedFailure("error: snapshot not found: rz-ckpt-never-existed"));
  });
});
