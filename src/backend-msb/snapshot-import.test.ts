import { describe, it, assert } from "../../test/harness.js";
import { isSnapshotAlreadyExistsError, parseImportedDigestDirName } from "./snapshot-import.js";

describe("isSnapshotAlreadyExistsError", () => {
  it("matches the captured 'snapshot already exists' shape verbatim (real msb 0.6.6 binary)", () => {
    assert.ok(isSnapshotAlreadyExistsError("error: snapshot already exists: /home/user/.microsandbox/snapshots/sha256-b9c0448ee9d54e33"));
  });

  it("matches when embedded in a larger stderr blob", () => {
    assert.ok(isSnapshotAlreadyExistsError("some preceding line\nerror: snapshot already exists: /path/sha256-abc\n"));
  });

  it("does not match an unrelated msb failure, e.g. 'snapshot not found'", () => {
    assert.ok(!isSnapshotAlreadyExistsError("error: snapshot not found: /path/rz-ckpt-abc123"));
  });

  it("does not match empty output", () => {
    assert.ok(!isSnapshotAlreadyExistsError(""));
  });
});

describe("parseImportedDigestDirName", () => {
  it("extracts the digest-dir basename from a success line", () => {
    const output = "imported snapshot to /home/user/.microsandbox/snapshots/sha256-b9c0448ee9d54e33\n";
    assert.equal(parseImportedDigestDirName(output), "sha256-b9c0448ee9d54e33");
  });

  it("extracts the digest-dir basename from an already-exists stderr line, same shape", () => {
    const output = "error: snapshot already exists: /home/user/.microsandbox/snapshots/sha256-b9c0448ee9d54e33\n";
    assert.equal(parseImportedDigestDirName(output), "sha256-b9c0448ee9d54e33");
  });

  it("uses the LAST non-empty line when the output has multiple", () => {
    const output = "unpacking archive...\nverifying digest...\nimported snapshot to /snapshots/sha256-abc123\n";
    assert.equal(parseImportedDigestDirName(output), "sha256-abc123");
  });

  it("resolves undefined for empty output", () => {
    assert.equal(parseImportedDigestDirName(""), undefined);
  });

  it("resolves undefined for output with no trailing path-shaped token", () => {
    assert.equal(parseImportedDigestDirName("\n   \n"), undefined);
  });
});
