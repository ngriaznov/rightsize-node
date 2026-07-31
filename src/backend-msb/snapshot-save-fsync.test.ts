import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert } from "../../test/harness.js";
import { isSnapshotSaveAccessDeniedFailure, salvageStagedArchive } from "./snapshot-save-fsync.js";

// A fresh, empty staging directory per case — the same shape the export path
// itself creates and owns, which is what makes "exactly one candidate" the
// ordinary case rather than a bet.
async function stagingDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-msb-salvage-test-"));
}

describe("isSnapshotSaveAccessDeniedFailure", () => {
  it("matches the captured Windows fsync failure verbatim", () => {
    // Captured verbatim from a windows-2025 hosted runner: msb 0.6.8 fsyncing
    // its finished archive through a read-only handle.
    assert.ok(
      isSnapshotSaveAccessDeniedFailure(
        "msb snapshot save rz-ckpt-fccd7568-archive " +
          "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\rightsize-archive-export-8980-1-1785507050813959600\\artifact " +
          "failed (exit 1): error: io error: Access is denied. (os error 5)",
      ),
    );
  });

  it("matches on the error number alone, whatever language the message text is in", () => {
    // The sentence before the suffix comes from Windows' FormatMessage and is
    // localized; the `(os error N)` suffix is Rust's own and never is.
    assert.ok(isSnapshotSaveAccessDeniedFailure("error: io error: Zugriff verweigert (os error 5)"));
  });

  it("does not match other msb save failures", () => {
    assert.ok(!isSnapshotSaveAccessDeniedFailure("error: snapshot not found: rz-ckpt-never-existed"));
    assert.ok(!isSnapshotSaveAccessDeniedFailure("error: io error: The system cannot find the file specified. (os error 2)"));
    assert.ok(!isSnapshotSaveAccessDeniedFailure(""));
  });

  it("does not match Windows codes that merely start with a 5", () => {
    // Without the closing parenthesis in the needle these all match on their
    // leading digit, and an unrelated network failure would be salvaged as
    // though it were the fsync bug.
    assert.ok(!isSnapshotSaveAccessDeniedFailure("error: io error: The network path was not found. (os error 53)"));
    assert.ok(!isSnapshotSaveAccessDeniedFailure("error: io error: (os error 55)"));
    assert.ok(!isSnapshotSaveAccessDeniedFailure("error: io error: (os error 59)"));
  });
});

describe("salvageStagedArchive", () => {
  it("moves the single staging file onto the destination, byte for byte", async () => {
    const dir = await stagingDir();
    try {
      const dest = path.join(dir, "artifact");
      // msb's own staging name: .<destination file name>.tmp.<pid>.<unix nanos>
      const staged = path.join(dir, ".artifact.tmp.8980.1785507050813959600");
      await fs.writeFile(staged, "fake-msb-artifact-bytes");

      assert.equal(await salvageStagedArchive(dest), true);
      assert.equal(await fs.readFile(dest, "utf8"), "fake-msb-artifact-bytes");
      // The staging file is consumed by the move, exactly as msb's own
      // replace_archive would have consumed it.
      assert.deepEqual(await fs.readdir(dir), ["artifact"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports failure and creates nothing when there is no staging file", async () => {
    // Not the failure being worked around — the archive never got written, so
    // there is nothing to complete and msb's own error is the whole story.
    const dir = await stagingDir();
    try {
      const dest = path.join(dir, "artifact");
      assert.equal(await salvageStagedArchive(dest), false);
      assert.deepEqual(await fs.readdir(dir), []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores a directory carrying the staging name", async () => {
    // msb writes a regular file there. A directory under that name would
    // otherwise be the single candidate, get renamed onto the destination, and
    // leave the archive step bundling a directory as the artifact member.
    const dir = await stagingDir();
    try {
      const dest = path.join(dir, "artifact");
      const decoy = path.join(dir, ".artifact.tmp.8980.1785507050813959600");
      await fs.mkdir(decoy);

      assert.equal(await salvageStagedArchive(dest), false);
      assert.deepEqual(await fs.readdir(dir), [path.basename(decoy)]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports failure and touches nothing when two staging files are present", async () => {
    // Two candidates means something other than this library's own single
    // export is writing here; picking one would be a guess about which holds
    // the archive the caller asked for.
    const dir = await stagingDir();
    try {
      const dest = path.join(dir, "artifact");
      const first = path.join(dir, ".artifact.tmp.8980.1785507050813959600");
      const second = path.join(dir, ".artifact.tmp.9021.1785507050999999999");
      await fs.writeFile(first, "first-archive");
      await fs.writeFile(second, "second-archive");

      assert.equal(await salvageStagedArchive(dest), false);
      assert.equal(await fs.readFile(first, "utf8"), "first-archive");
      assert.equal(await fs.readFile(second, "utf8"), "second-archive");
      assert.deepEqual((await fs.readdir(dir)).sort(), [path.basename(first), path.basename(second)].sort());
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores staging files belonging to a different destination", async () => {
    // The prefix carries the destination's own file name, so a neighbouring
    // export's leftovers are not candidates for this one.
    const dir = await stagingDir();
    try {
      const dest = path.join(dir, "artifact");
      await fs.writeFile(path.join(dir, ".other-artifact.tmp.8980.1785507050813959600"), "not-ours");

      assert.equal(await salvageStagedArchive(dest), false);
      assert.deepEqual(await fs.readdir(dir), [".other-artifact.tmp.8980.1785507050813959600"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports failure rather than throwing when the destination's directory does not exist", async () => {
    // A filesystem error here must not replace msb's own error, which
    // describes the actual problem.
    const dir = await stagingDir();
    await fs.rm(dir, { recursive: true, force: true });
    assert.equal(await salvageStagedArchive(path.join(dir, "artifact")), false);
  });
});
