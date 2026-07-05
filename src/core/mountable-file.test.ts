import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert } from "../../test/harness.js";
import { MountableFile } from "./mountable-file.js";

describe("MountableFile.forHostPath", () => {
  it("absolutizes a relative host path", () => {
    const file = MountableFile.forHostPath("some/relative/path.txt");
    assert.ok(path.isAbsolute(file.path));
    assert.equal(file.path, path.resolve("some/relative/path.txt"));
  });

  it("leaves an already-absolute path untouched", () => {
    const abs = path.join(os.tmpdir(), "already-absolute.txt");
    const file = MountableFile.forHostPath(abs);
    assert.equal(file.path, abs);
  });
});

describe("MountableFile.forResource", () => {
  it("resolves relative to a passed import.meta.url base and round-trips the fixture contents", () => {
    const file = MountableFile.forResource("rightsize-fixture.txt", import.meta.url);
    assert.ok(fs.existsSync(file.path));
    const contents = fs.readFileSync(file.path, "utf8");
    assert.equal(contents, "rightsize mountable-file fixture\n");
    // The resolved mount path is a temp copy, not the source file's own path.
    const sourcePath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "rightsize-fixture.txt");
    assert.ok(file.path !== sourcePath);
  });

  it("resolves relative to process.cwd() when no base is given", () => {
    const cwdRelative = path.relative(process.cwd(), path.join(process.cwd(), "src/core/rightsize-fixture.txt"));
    const file = MountableFile.forResource(cwdRelative);
    assert.ok(fs.existsSync(file.path));
    assert.equal(fs.readFileSync(file.path, "utf8"), "rightsize mountable-file fixture\n");
  });
});
