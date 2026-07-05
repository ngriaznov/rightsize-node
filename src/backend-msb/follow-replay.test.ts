import { describe, it, assert } from "../../test/harness.js";
import { undeliveredLines } from "./follow-replay.js";

describe("undeliveredLines", () => {
  it("slices from the delivered count", () => {
    assert.deepEqual(undeliveredLines("a\nb\nc\n", 1), ["b", "c"]);
  });

  it("returns nothing when everything was already delivered", () => {
    assert.deepEqual(undeliveredLines("a\nb\n", 2), []);
  });

  it("returns everything when nothing was delivered yet", () => {
    assert.deepEqual(undeliveredLines("a\nb\n", 0), ["a", "b"]);
  });

  it("does not manufacture a phantom trailing empty line from the final newline", () => {
    assert.deepEqual(undeliveredLines("only-line\n", 0), ["only-line"]);
  });

  it("preserves a genuine interior blank line the workload printed", () => {
    assert.deepEqual(undeliveredLines("a\n\nb\n", 0), ["a", "", "b"]);
  });

  it("handles text with no trailing newline (an unterminated final line)", () => {
    assert.deepEqual(undeliveredLines("a\nb", 0), ["a", "b"]);
  });
});
