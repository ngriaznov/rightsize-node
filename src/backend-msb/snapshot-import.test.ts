import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseImportedMemberId } from "./snapshot-import.js";

describe("parseImportedMemberId", () => {
  it("reads the id from an Added line", () => {
    assert.equal(parseImportedMemberId("Added: snap_0123456789abcdef0123456789abcdef\n"), "snap_0123456789abcdef0123456789abcdef");
  });

  it("reads the id from a Reused line", () => {
    assert.equal(parseImportedMemberId("Reused: snap_0123456789abcdef0123456789abcdef\n"), "snap_0123456789abcdef0123456789abcdef");
  });

  it("finds the line among other output and tolerates CRLF", () => {
    assert.equal(parseImportedMemberId("warning: something\r\nAdded: snap_abc\r\n"), "snap_abc");
  });

  it("returns undefined for empty or blank output", () => {
    assert.equal(parseImportedMemberId(""), undefined);
    assert.equal(parseImportedMemberId("\n   \n"), undefined);
  });

  it("returns undefined when no Added/Reused line is present", () => {
    assert.equal(parseImportedMemberId("group g: head snap_abc (Initialized)\n/cache/checkpoints/g/snap_abc\n"), undefined);
  });

  it("does not treat a line that merely mentions the words as a match", () => {
    assert.equal(parseImportedMemberId("note: Added: snap_abc\nAdded:snap_abc\n"), undefined);
  });
});
