import { describe, it, assert } from "../../test/harness.js";
import { isSnapshotAlreadyExistsError, parseImportedArtifactPath } from "./snapshot-import.js";

describe("isSnapshotAlreadyExistsError", () => {
  it("matches the captured 'snapshot already exists' shape verbatim (real msb 0.6.8 binary)", () => {
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

describe("parseImportedArtifactPath", () => {
  it("extracts the loaded artifact's absolute path from msb 0.7.1's group/digest/path success shape", () => {
    const output =
      "group msb-a1b2c3d4e5f6: head snap_0123456789abcdef0123456789abcdef (Initialized)\n" +
      "digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd\n" +
      "/cache/checkpoints/msb-a1b2c3d4e5f6/snap_0123456789abcdef0123456789abcdef\n";
    assert.equal(
      parseImportedArtifactPath(output),
      "/cache/checkpoints/msb-a1b2c3d4e5f6/snap_0123456789abcdef0123456789abcdef",
    );
  });

  it("extracts the artifact path from an already-exists stderr line, same last-line shape", () => {
    const output = "error: snapshot already exists: /cache/checkpoints/msb-a1b2c3d4e5f6/snap_abcdef0123456789\n";
    assert.equal(parseImportedArtifactPath(output), "/cache/checkpoints/msb-a1b2c3d4e5f6/snap_abcdef0123456789");
  });

  it("uses the LAST non-empty line when the output has multiple, never the group/digest status lines above it", () => {
    const output = "group msb-abc: head snap_abc (Initialized)\ndigest: sha256:abc\n/snapshots/msb-abc/snap_abc\n";
    assert.equal(parseImportedArtifactPath(output), "/snapshots/msb-abc/snap_abc");
  });

  it("resolves undefined for empty output", () => {
    assert.equal(parseImportedArtifactPath(""), undefined);
  });

  it("resolves undefined when the last line is not an absolute path — e.g. just the '(Initialized)' status line", () => {
    assert.equal(parseImportedArtifactPath("group msb-abc: head snap_abc (Initialized)\n"), undefined);
  });

  it("resolves undefined for whitespace-only output", () => {
    assert.equal(parseImportedArtifactPath("\n   \n"), undefined);
  });

  it("resolves undefined for a relative-looking last line", () => {
    assert.equal(parseImportedArtifactPath("snapshots/msb-abc/snap_abc\n"), undefined);
  });
});
