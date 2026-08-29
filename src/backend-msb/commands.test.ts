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
    checkpointRef: undefined,
    diskLimitMb: undefined,
    tmpfsRootMb: undefined,
    networkDisabled: false,
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
      // readOnly: true above — the token is always present, and `ro` is what makes the
      // flag mean anything on this backend.
      "/host/f.txt:/guest/f.txt:ro,nodev",
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
      // readOnly: false above. A two-segment spec is never emitted: on Windows msb
      // splits a token-less spec at the drive letter's colon and rejects the path tail.
      "/h:/g:rw,nodev",
      "redis:8.6-alpine",
      "--",
      "sh",
      "-c",
      "true",
    ]);
  });

  it("run: disk limit emits --root-disk <mb>M right after memory, before ports", () => {
    const argv = MsbCommands.run(baseSpec({ diskLimitMb: 2048 }));
    assert.deepEqual(argv, ["run", "--name", "rz-abc12345-1", "--root-disk", "2048M", "redis:8.6-alpine"]);
  });

  it("run: tmpfs root emits --root-disk tmpfs:<mb>M", () => {
    const argv = MsbCommands.run(baseSpec({ tmpfsRootMb: 512 }));
    assert.deepEqual(argv, ["run", "--name", "rz-abc12345-1", "--root-disk", "tmpfs:512M", "redis:8.6-alpine"]);
  });

  it("run: networkDisabled emits --net private", () => {
    const argv = MsbCommands.run(baseSpec({ networkDisabled: true }));
    assert.deepEqual(argv, ["run", "--name", "rz-abc12345-1", "--net", "private", "redis:8.6-alpine"]);
  });

  it("run: memory, root-disk, and net-private appear together in that fixed order, ahead of ports", () => {
    const argv = MsbCommands.run(
      baseSpec({
        memoryLimitMb: 1024,
        diskLimitMb: 4096,
        networkDisabled: true,
        ports: [{ hostPort: 1111, guestPort: 22 }],
      }),
    );
    assert.deepEqual(argv, [
      "run",
      "--name",
      "rz-abc12345-1",
      "-m",
      "1024M",
      "--root-disk",
      "4096M",
      "--net",
      "private",
      "-p",
      "1111:22",
      "redis:8.6-alpine",
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

  it("systemLog: --source system --tail 1000, distinct from the workload logs() shape", () => {
    assert.deepEqual(MsbCommands.systemLog("box-1"), ["logs", "box-1", "--source", "system", "--tail", "1000"]);
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

  it("run: checkpointRef boots via --from-snapshot instead of the image, keeping every other flag", () => {
    const argv = MsbCommands.run(
      baseSpec({
        checkpointRef: "rz-ckpt-abcdef012345",
        memoryLimitMb: 256,
        ports: [{ hostPort: 1111, guestPort: 22 }],
        env: [["A", "1"]],
        command: ["sh", "-c", "true"],
      }),
    );
    assert.deepEqual(argv, [
      "run",
      "--name",
      "rz-abc12345-1",
      "-m",
      "256M",
      "-p",
      "1111:22",
      "-e",
      "A=1",
      "--from-snapshot",
      "rz-ckpt-abcdef012345",
      "--",
      "sh",
      "-c",
      "true",
    ]);
    assert.equal(argv.includes("redis:8.6-alpine"), false, "the image must never appear alongside --from-snapshot");
  });

  it("snapshotCreate", () => {
    assert.deepEqual(MsbCommands.snapshotCreate("box-1", "rz-ckpt-abcdef012345"), [
      "snapshot",
      "create",
      "--from",
      "box-1",
      "rz-ckpt-abcdef012345",
    ]);
  });

  it("snapshotCreate with a destDir appends --dest-dir <dir>", () => {
    assert.deepEqual(MsbCommands.snapshotCreate("box-1", "rz-ckpt-abcdef012345", "/cache/checkpoints"), [
      "snapshot",
      "create",
      "--from",
      "box-1",
      "rz-ckpt-abcdef012345",
      "--dest-dir",
      "/cache/checkpoints",
    ]);
  });

  it("snapshotRemove", () => {
    assert.deepEqual(MsbCommands.snapshotRemove("rz-ckpt-abcdef012345"), ["snapshot", "rm", "rz-ckpt-abcdef012345"]);
  });

  it("snapshotInspect", () => {
    assert.deepEqual(MsbCommands.snapshotInspect("rz-ckpt-abcdef012345"), ["snapshot", "inspect", "rz-ckpt-abcdef012345"]);
  });

  it("snapshotExport", () => {
    assert.deepEqual(MsbCommands.snapshotExport("rz-ckpt-abcdef012345", "/out/archive.tar.zst"), [
      "snapshot",
      "save",
      "rz-ckpt-abcdef012345",
      "/out/archive.tar.zst",
    ]);
  });

  it("snapshotImport", () => {
    assert.deepEqual(MsbCommands.snapshotImport("/in/archive.tar.zst"), ["snapshot", "load", "/in/archive.tar.zst"]);
  });

  it("snapshotList: --format json, never --json", () => {
    assert.deepEqual(MsbCommands.snapshotList(), ["snapshot", "list", "--format", "json"]);
  });

  it("copyIn", () => {
    assert.deepEqual(MsbCommands.copyIn("/host/f.txt", "box-1", "/guest/f.txt"), [
      "copy",
      "-q",
      "/host/f.txt",
      "box-1:/guest/f.txt",
    ]);
  });

  it("copyOut", () => {
    assert.deepEqual(MsbCommands.copyOut("box-1", "/guest/f.txt", "/host/f.txt"), [
      "copy",
      "-q",
      "box-1:/guest/f.txt",
      "/host/f.txt",
    ]);
  });
});
