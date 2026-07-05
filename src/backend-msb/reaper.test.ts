import { describe, it, assert } from "../../test/harness.js";
import { orphanNames } from "./reaper.js";

describe("orphanNames", () => {
  it("filters out this run's own names, keeps other runs' names", () => {
    const ls = JSON.stringify([
      { name: "rz-abc12345-1", status: "Running" },
      { name: "rz-abc12345-2", status: "Stopped" },
      { name: "rz-deadbeef-1", status: "Running" },
    ]);
    assert.deepEqual(orphanNames(ls, "abc12345"), ["rz-deadbeef-1"]);
  });

  it("returns an empty list when nothing but this run's own names appear", () => {
    const ls = `rz-abc12345-1 rz-abc12345-2`;
    assert.deepEqual(orphanNames(ls, "abc12345"), []);
  });

  it("de-duplicates repeated mentions of the same orphan name", () => {
    const ls = `rz-deadbeef-1 seen twice: rz-deadbeef-1`;
    assert.deepEqual(orphanNames(ls, "abc12345"), ["rz-deadbeef-1"]);
  });

  it("ignores names that don't match the rz-<8hex>-<seq> shape", () => {
    const ls = `not-a-sandbox-name rz-shortid-1 rz-deadbeef-1`;
    assert.deepEqual(orphanNames(ls, "abc12345"), ["rz-deadbeef-1"]);
  });

  it("does not match a name whose run-id-and-seq is only a glued-on prefix of a longer token", () => {
    // "rz-deadbeef-1" is a textual prefix of "rz-deadbeef-1-extra", but the
    // two are different tokens — the character right after the matched
    // digits ("-") continues the identifier, so this must not be reported
    // as an orphan at all.
    const ls = `rz-deadbeef-1-extra`;
    assert.deepEqual(orphanNames(ls, "abc12345"), []);
  });

  it("still matches a whole token immediately followed by an unrelated separator", () => {
    const ls = `rz-deadbeef-1 rz-deadbeef-10`;
    assert.deepEqual(orphanNames(ls, "abc12345"), ["rz-deadbeef-1", "rz-deadbeef-10"]);
  });
});
