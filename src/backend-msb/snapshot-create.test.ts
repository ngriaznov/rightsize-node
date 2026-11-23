import { describe, it, assert } from "../../test/harness.js";
import { parseSnapshotCreateArtifactPath, stripWindowsVerbatimPrefix } from "./snapshot-create.js";

describe("stripWindowsVerbatimPrefix", () => {
  it("drops the extended-length prefix msb 0.8 prints on Windows", () => {
    assert.equal(
      stripWindowsVerbatimPrefix("\\\\?\\C:\\Users\\r\\checkpoints\\rz-ckpt-x\\snap_ab"),
      "C:\\Users\\r\\checkpoints\\rz-ckpt-x\\snap_ab",
    );
  });

  it("turns the UNC form back into a plain UNC path", () => {
    assert.equal(stripWindowsVerbatimPrefix("\\\\?\\UNC\\server\\share\\ck"), "\\\\server\\share\\ck");
  });

  it("leaves other paths alone", () => {
    assert.equal(stripWindowsVerbatimPrefix("/cache/checkpoints/rz-ckpt-x/snap_ab"), "/cache/checkpoints/rz-ckpt-x/snap_ab");
    assert.equal(stripWindowsVerbatimPrefix("C:\\ck\\snap_ab"), "C:\\ck\\snap_ab");
  });
});

describe("parseSnapshotCreateArtifactPath", () => {
  it("returns the absolute path from the last non-empty line (real msb 0.7.1 shape)", () => {
    const stdout =
      "Created snapshot snap_abcdef0123456789abcdef0123456789\n" +
      "/cache/checkpoints/box-1/snap_abcdef0123456789abcdef0123456789\n";
    assert.equal(
      parseSnapshotCreateArtifactPath(stdout),
      "/cache/checkpoints/box-1/snap_abcdef0123456789abcdef0123456789",
    );
  });

  it("ignores trailing blank lines", () => {
    const stdout = "Created snapshot snap_abc\n/cache/checkpoints/box-1/snap_abc\n\n\n";
    assert.equal(parseSnapshotCreateArtifactPath(stdout), "/cache/checkpoints/box-1/snap_abc");
  });

  it("trims surrounding whitespace on the last line", () => {
    assert.equal(
      parseSnapshotCreateArtifactPath("Created\n   /cache/checkpoints/box-1/snap_abc   \n"),
      "/cache/checkpoints/box-1/snap_abc",
    );
  });

  it("returns undefined for empty output", () => {
    assert.equal(parseSnapshotCreateArtifactPath(""), undefined);
  });

  it("returns undefined for output that is only whitespace/blank lines", () => {
    assert.equal(parseSnapshotCreateArtifactPath("   \n  \n\t\n"), undefined);
  });

  it("returns undefined when the last line is not an absolute path — never guesses", () => {
    assert.equal(parseSnapshotCreateArtifactPath("Created snapshot snap_abc\nsnap_abc\n"), undefined);
  });

  it("returns undefined when the last line is a relative-looking path", () => {
    assert.equal(parseSnapshotCreateArtifactPath("snapshots/box-1/snap_abc\n"), undefined);
  });

  it("uses only the LAST line, ignoring an earlier absolute-looking line", () => {
    const stdout = "/not/the/right/path\nsnap_abc\n";
    assert.equal(parseSnapshotCreateArtifactPath(stdout), undefined);
  });
});
