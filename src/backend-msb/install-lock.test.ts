import { describe, it, assert } from "../../test/harness.js";
import { isMsbInstallLockActive } from "./backend.js";

describe("isMsbInstallLockActive", () => {
  it("matches the captured refusal verbatim", () => {
    // Captured from a windows-2025 hosted runner: `msb run` refused mid-suite
    // while msb's internal install lock was held, with ordinary boots
    // succeeding on both sides of the failure.
    assert.ok(
      isMsbInstallLockActive(
        "error: runtime error: microsandbox install operation in progress until 2026-07-31 20:55:04.779845600; retry after it completes",
      ),
    );
  });

  it("matches regardless of the deadline timestamp", () => {
    // The timestamp varies per occurrence; the classifier keys on the stable
    // phrase only.
    assert.ok(
      isMsbInstallLockActive(
        "error: runtime error: microsandbox install operation in progress until 2027-01-01 00:00:00.000000000; retry after it completes",
      ),
    );
  });

  it("ignores other msb runtime errors", () => {
    assert.ok(!isMsbInstallLockActive("error: runtime error: something else entirely"));
    assert.ok(!isMsbInstallLockActive('error: failed to start "rz-abc-1"'));
    assert.ok(!isMsbInstallLockActive(""));
  });
});
