import { describe, it, assert } from "../../test/harness.js";
import { DockerCli } from "./cli.js";

describe("DockerCli argv construction", () => {
  it("copyIn: docker cp <hostPath> <id>:<containerPath>", () => {
    assert.deepEqual(DockerCli.copyIn("/host/f.txt", "container-1", "/guest/f.txt"), [
      "cp",
      "/host/f.txt",
      "container-1:/guest/f.txt",
    ]);
  });

  it("copyOut: docker cp <id>:<containerPath> <hostPath>", () => {
    assert.deepEqual(DockerCli.copyOut("container-1", "/guest/f.txt", "/host/f.txt"), [
      "cp",
      "container-1:/guest/f.txt",
      "/host/f.txt",
    ]);
  });

  it("save: docker save -o <destFile> <tag>", () => {
    assert.deepEqual(DockerCli.save("/out/archive.tar", "rightsize/checkpoint:abcdef012345"), [
      "save",
      "-o",
      "/out/archive.tar",
      "rightsize/checkpoint:abcdef012345",
    ]);
  });

  it("load: docker load -i <srcFile>", () => {
    assert.deepEqual(DockerCli.load("/in/archive.tar"), ["load", "-i", "/in/archive.tar"]);
  });
});
