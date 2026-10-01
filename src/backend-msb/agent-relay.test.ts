import { describe, it, assert } from "../../test/harness.js";
import { isAgentRelayUnavailable } from "./agent-relay.js";

describe("isAgentRelayUnavailable", () => {
  it("matches the attached `msb run` capture", () => {
    assert.ok(
      isAgentRelayUnavailable(
        [
          'error: failed to start "rz-731fdcdc-8"',
          "  → other: sandbox process exited (exit code: 0) before agent relay became available",
          "  → run `msb logs --source system rz-731fdcdc-8` for full diagnostics",
        ].join("\n"),
      ),
    );
  });

  it("matches the PowerShell-decorated capture of a brokered restore verbatim", () => {
    // Captured from a Windows CI run: PowerShell prefixed and wrapped msb's
    // stderr (the `RemoteExcept` / `ion` break is the console's own) and
    // mangled the arrow into mojibake.
    assert.ok(
      isAgentRelayUnavailable(
        [
          'msb.exe : error: failed to start "rz-731fdcdc-8"',
          "At line:1 char:1",
          "+ & 'C:\\Users\\runneradmin\\AppData\\Local\\rightsize\\msb\\0.7.6\\bin\\msb.exe ...",
          "+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~",
          '    + CategoryInfo          : NotSpecified: (error: failed to start "rz-731fdcdc-8":String) [], RemoteExcept',
          "   ion",
          "    + FullyQualifiedErrorId : NativeCommandError",
          "",
          "  ΓåÆ other: sandbox process exited (exit code: 0) before agent relay became available",
          "  ΓåÆ run `msb logs --source system rz-731fdcdc-8` for full diagnostics",
        ].join("\n"),
      ),
    );
  });

  it("matches the Unix wording of a clean exit", () => {
    assert.ok(
      isAgentRelayUnavailable(
        'error: failed to start "rz-731fdcdc-8"\n' +
          "  → other: sandbox process exited (exit status: 0) before agent relay became available\n",
      ),
    );
  });

  it("does not depend on the arrow, the `other:` prefix or the line structure", () => {
    assert.ok(isAgentRelayUnavailable("sandbox process exited (exit code: 0) before agent relay became available"));
    assert.ok(isAgentRelayUnavailable("error: sandbox process exited (exit status: 0)\nbefore agent relay became available"));
  });

  it("does not match a Windows crash exit with the same message", () => {
    assert.ok(
      !isAgentRelayUnavailable(
        "  → other: sandbox process exited (exit code: 0xc0000409) before agent relay became available",
      ),
    );
  });

  it("does not match a non-zero exit code with the same message", () => {
    assert.ok(
      !isAgentRelayUnavailable("  → other: sandbox process exited (exit code: 1) before agent relay became available"),
    );
    assert.ok(
      !isAgentRelayUnavailable("  → other: sandbox process exited (exit code: 10) before agent relay became available"),
    );
    assert.ok(
      !isAgentRelayUnavailable("  → other: sandbox process exited (exit status: 1) before agent relay became available"),
    );
  });

  it("does not match a signal exit with the same message", () => {
    // The old tab-in-env abort on msb 0.6.x: deterministic, fails the same
    // way every time, so it must not be retried.
    assert.ok(
      !isAgentRelayUnavailable(
        "  → other: sandbox process exited (signal: 6 (SIGABRT)) before agent relay became available",
      ),
    );
  });

  it("does not match output without the relay phrase", () => {
    assert.ok(!isAgentRelayUnavailable("error: sandbox process exited (exit code: 0)"));
    assert.ok(!isAgentRelayUnavailable("error: sandbox exited during preparation: exit code: 0"));
    assert.ok(!isAgentRelayUnavailable("error: startup timed out after 180 seconds before agent readiness"));
  });

  it("does not match the relay phrase alone, with no exit marker", () => {
    assert.ok(!isAgentRelayUnavailable("error: something failed before agent relay became available"));
  });

  it("does not match unrelated msb errors or empty output", () => {
    assert.ok(!isAgentRelayUnavailable("error: sandbox 'rz-abc-1' already exists"));
    assert.ok(!isAgentRelayUnavailable("error: database error: disk I/O error"));
    assert.ok(!isAgentRelayUnavailable(""));
  });
});
