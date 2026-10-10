import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert, beforeEach, afterEach } from "../../../test/harness.js";
import { requireCopiedHostFilesExist } from "./copied-files.js";
import { CheckpointHostFileMissingError } from "../errors.js";

describe("requireCopiedHostFilesExist", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-copied-files-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("resolves for no mounts and for mounts whose host files all exist", async () => {
    await requireCopiedHostFilesExist([]);
    const a = path.join(dir, "a.conf");
    const b = path.join(dir, "b.conf");
    await fs.writeFile(a, "a");
    await fs.writeFile(b, "b");
    await requireCopiedHostFilesExist([
      { hostPath: a, guestPath: "/etc/app/a.conf", readOnly: false },
      { hostPath: b, guestPath: "/etc/app/b.conf", readOnly: true },
    ]);
  });

  it("throws CheckpointHostFileMissingError naming the first missing mount, in spec order", async () => {
    const present = path.join(dir, "present.conf");
    await fs.writeFile(present, "x");
    const gone1 = path.join(dir, "gone1.conf");
    const gone2 = path.join(dir, "gone2.conf");
    let thrown: unknown;
    try {
      await requireCopiedHostFilesExist([
        { hostPath: present, guestPath: "/etc/app/present.conf", readOnly: false },
        { hostPath: gone1, guestPath: "/etc/app/gone1.conf", readOnly: false },
        { hostPath: gone2, guestPath: "/etc/app/gone2.conf", readOnly: false },
      ]);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof CheckpointHostFileMissingError, `expected CheckpointHostFileMissingError, got: ${String(thrown)}`);
    assert.equal((thrown as CheckpointHostFileMissingError).guestPath, "/etc/app/gone1.conf");
    assert.equal((thrown as CheckpointHostFileMissingError).hostPath, gone1);
  });

  it("counts a file deleted after it was copied in as missing", async () => {
    const file = path.join(dir, "deleted-after-start.conf");
    await fs.writeFile(file, "x");
    await requireCopiedHostFilesExist([{ hostPath: file, guestPath: "/g", readOnly: false }]);
    await fs.rm(file);
    await assert.rejects(() => requireCopiedHostFilesExist([{ hostPath: file, guestPath: "/g", readOnly: false }]));
  });

  it("counts a path under something that is not a directory as missing (ENOTDIR)", async () => {
    const file = path.join(dir, "plain-file");
    await fs.writeFile(file, "x");
    let thrown: unknown;
    try {
      await requireCopiedHostFilesExist([{ hostPath: path.join(file, "child"), guestPath: "/g", readOnly: false }]);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof CheckpointHostFileMissingError);
  });
});
