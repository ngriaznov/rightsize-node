import { describe, it, assert } from "../../../test/harness.js";
import { TarCli, tarDirArg } from "./tar-cli.js";

describe("TarCli argv construction", () => {
  it("create: -cf <archive basename> -C <workDir> <members...>", () => {
    assert.deepEqual(TarCli.create("archive.tar", "/tmp/work", ["checkpoint.json", "artifact"]), [
      "-cf",
      "archive.tar",
      "-C",
      "/tmp/work",
      "checkpoint.json",
      "artifact",
    ]);
  });

  it("extract: -xf <archive basename> -C <destDir>", () => {
    assert.deepEqual(TarCli.extract("archive.tar", "/tmp/dest"), ["-xf", "archive.tar", "-C", "/tmp/dest"]);
  });

  it("tarDirArg forward-slashes -C paths on win32 only — GNU (MSYS) tar mangles backslash paths, both flavors accept slashes", () => {
    assert.equal(tarDirArg("C:\\Users\\x\\staging", "win32"), "C:/Users/x/staging");
    assert.equal(tarDirArg("/tmp/back\\slash", "linux"), "/tmp/back\\slash");
  });
});
