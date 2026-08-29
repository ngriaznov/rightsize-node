import { describe, it, assert } from "../../test/harness.js";
import { hasSandboxStartedMarker, SANDBOX_STARTED_MARKER } from "./fast-exit.js";

describe("hasSandboxStartedMarker", () => {
  it("true when the marker line is present, wherever it falls in the log", () => {
    assert.ok(hasSandboxStartedMarker(`boot diagnostics\n${SANDBOX_STARTED_MARKER}\nmore lines\n`));
    assert.ok(hasSandboxStartedMarker(SANDBOX_STARTED_MARKER));
  });

  it("false on an empty or unrelated system log", () => {
    assert.equal(hasSandboxStartedMarker(""), false);
    assert.equal(hasSandboxStartedMarker("some unrelated boot diagnostics\n"), false);
  });

  it("false on a near-miss that isn't the exact marker text", () => {
    assert.equal(hasSandboxStartedMarker("sandbox started"), false);
    assert.equal(hasSandboxStartedMarker("--- sandbox starting ---"), false);
  });
});
