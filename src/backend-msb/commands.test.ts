import { describe, it, assert } from "../../test/harness.js";
import { MsbCommands } from "./commands.js";
import type { ContainerSpec } from "../core/model.js";

function baseSpec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: "rz-abc12345-1",
    image: "redis:8.6-alpine",
    env: [],
    command: undefined,
    ports: [],
    mounts: [],
    networkId: undefined,
    aliases: [],
    runId: "abc12345",
    memoryLimitMb: undefined,
    keepAlive: false,
    ...overrides,
  };
}

describe("MsbCommands", () => {
  it("run: minimal spec has no -d, no memory flag, and ends with just the image", () => {
    const argv = MsbCommands.run(baseSpec());
    assert.deepEqual(argv, ["run", "--name", "rz-abc12345-1", "redis:8.6-alpine"]);
    assert.equal(argv.includes("-d"), false);
  });

  it("run: memory flag comes immediately after --name", () => {
    const argv = MsbCommands.run(baseSpec({ memoryLimitMb: 1024 }));
    assert.deepEqual(argv.slice(0, 5), ["run", "--name", "rz-abc12345-1", "-m", "1024M"]);
  });

  it("run: ports, env, mounts appear in that order before the image", () => {
    const argv = MsbCommands.run(
      baseSpec({
        ports: [{ hostPort: 15432, guestPort: 5432 }],
        env: [["POSTGRES_USER", "test"]],
        mounts: [{ hostPath: "/host/f.txt", guestPath: "/guest/f.txt", readOnly: true }],
      }),
    );
    assert.deepEqual(argv, [
      "run",
      "--name",
      "rz-abc12345-1",
      "-p",
      "15432:5432",
      "-e",
      "POSTGRES_USER=test",
      "--mount-file",
      "/host/f.txt:/guest/f.txt",
      "redis:8.6-alpine",
    ]);
  });

  it("run: an explicit command is appended after -- ; undefined command adds nothing", () => {
    const withCmd = MsbCommands.run(baseSpec({ command: ["redis-server", "--port", "6379"] }));
    assert.deepEqual(withCmd.slice(-4), ["--", "redis-server", "--port", "6379"]);

    const withoutCmd = MsbCommands.run(baseSpec());
    assert.equal(withoutCmd.includes("--"), false);
  });

  it("run: full ordering — name, memory, ports, env, mounts, image, -- cmd", () => {
    const argv = MsbCommands.run(
      baseSpec({
        memoryLimitMb: 512,
        ports: [{ hostPort: 1111, guestPort: 22 }],
        env: [["A", "1"]],
        mounts: [{ hostPath: "/h", guestPath: "/g", readOnly: false }],
        command: ["sh", "-c", "true"],
      }),
    );
    assert.deepEqual(argv, [
      "run",
      "--name",
      "rz-abc12345-1",
      "-m",
      "512M",
      "-p",
      "1111:22",
      "-e",
      "A=1",
      "--mount-file",
      "/h:/g",
      "redis:8.6-alpine",
      "--",
      "sh",
      "-c",
      "true",
    ]);
  });

  it("exec", () => {
    assert.deepEqual(MsbCommands.exec("box-1", ["echo", "hi"]), ["exec", "box-1", "--", "echo", "hi"]);
  });

  it("execStream", () => {
    assert.deepEqual(MsbCommands.execStream("box-1", ["nc", "-l", "-p", "80"]), [
      "exec",
      "--stream",
      "box-1",
      "--",
      "nc",
      "-l",
      "-p",
      "80",
    ]);
  });

  it("logs", () => {
    assert.deepEqual(MsbCommands.logs("box-1"), ["logs", "box-1", "--tail", "1000"]);
  });

  it("followLogs", () => {
    assert.deepEqual(MsbCommands.followLogs("box-1"), ["logs", "box-1", "-f"]);
  });

  it("stop and rm", () => {
    assert.deepEqual(MsbCommands.stop("box-1"), ["stop", "box-1"]);
    assert.deepEqual(MsbCommands.rm("box-1"), ["rm", "box-1"]);
  });

  it("ls: --format json, never --json", () => {
    assert.deepEqual(MsbCommands.ls(), ["ls", "--format", "json"]);
  });

  it("image remove targets one reference", () => {
    assert.deepEqual(MsbCommands.imageRemove("floci/floci-az:0.8.0"), [
      "image",
      "remove",
      "floci/floci-az:0.8.0",
    ]);
  });
});
