import { describe, it, assert } from "../../test/harness.js";
import { RunId } from "./run-id.js";

describe("RunId", () => {
  it("is 8 hex characters", () => {
    assert.match(RunId.value, /^[0-9a-f]{8}$/);
  });

  it("is stable across reads within the same process", () => {
    const first = RunId.value;
    const second = RunId.value;
    assert.equal(first, second);
  });
});
