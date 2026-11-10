import { describe, it, assert } from "../../test/harness.js";
import { isPortBindConflictOutput } from "./port-conflict.js";

describe("isPortBindConflictOutput", () => {
  it("matches 'address already in use'", () => {
    assert.ok(isPortBindConflictOutput("Error: bind: address already in use"));
  });

  it("matches 'port is already allocated'", () => {
    assert.ok(isPortBindConflictOutput("Bind for 0.0.0.0:5432 failed: port is already allocated"));
  });

  it("is case-insensitive", () => {
    assert.ok(isPortBindConflictOutput("ADDRESS ALREADY IN USE"));
  });

  it("matches the generic already-in-use + port combination", () => {
    assert.ok(isPortBindConflictOutput("host port 5432 already in use by another process"));
  });

  it("matches msb 0.7.14's pre-boot port claim failure on Linux, macOS and Windows", () => {
    assert.ok(isPortBindConflictOutput("failed to publish tcp port 127.0.0.1:49213: Address already in use (os error 98)"));
    assert.ok(isPortBindConflictOutput("failed to publish udp port 127.0.0.1:49214: Address already in use (os error 48)"));
    assert.ok(
      isPortBindConflictOutput(
        "failed to publish tcp port 127.0.0.1:49213: Only one usage of each socket address " +
          "(protocol/network address/port) is normally permitted. (os error 10048)",
      ),
    );
  });

  it("does not match an unrelated failure", () => {
    assert.equal(isPortBindConflictOutput("Error: no such image: redis:doesnotexist"), false);
    assert.equal(isPortBindConflictOutput("permission denied"), false);
    // Another socket error from the same pre-boot claim is not a conflict a new port fixes.
    assert.equal(
      isPortBindConflictOutput("failed to publish tcp port 127.0.0.1:80: Permission denied (os error 13)"),
      false,
    );
  });
});
