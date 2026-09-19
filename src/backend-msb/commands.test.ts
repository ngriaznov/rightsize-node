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
        ports: [{ hostPort: 15432, guestPort: 5432, protocol: "tcp" }],
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

  it("run: a udp port binding gets a '/udp' suffix on -p; a tcp binding in the same spec stays plain HOST:GUEST", () => {
    const argv = MsbCommands.run(
      baseSpec({
        ports: [
          { hostPort: 1111, guestPort: 22, protocol: "tcp" },
          { hostPort: 2222, guestPort: 53, protocol: "udp" },
        ],
      }),
    );
    assert.deepEqual(argv, [
      "run",
      "--name",
      "rz-abc12345-1",
      "-p",
      "1111:22",
      "-p",
      "2222:53/udp",
      "redis:8.6-alpine",
    ]);
  });

  it("run: a tcp-only spec's -p emission is byte-identical to before udp existed", () => {
    const argv = MsbCommands.run(baseSpec({ ports: [{ hostPort: 15432, guestPort: 5432, protocol: "tcp" }] }));
    assert.deepEqual(argv.slice(3, 5), ["-p", "15432:5432"]);
    assert.equal(argv.some((a) => a.includes("/udp")), false);
  });

  it("run: the SAME numeric guest port exposed on both protocols emits two independent -p flags, only the udp one suffixed", () => {
    const argv = MsbCommands.run(
      baseSpec({
        ports: [
          { hostPort: 1111, guestPort: 53, protocol: "tcp" },
          { hostPort: 2222, guestPort: 53, protocol: "udp" },
        ],
      }),
    );
    assert.deepEqual(argv, [
      "run",
      "--name",
      "rz-abc12345-1",
      "-p",
      "1111:53",
      "-p",
      "2222:53/udp",
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
        ports: [{ hostPort: 1111, guestPort: 22, protocol: "tcp" }],
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
        ports: [{ hostPort: 1111, guestPort: 22, protocol: "tcp" }],
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

  it("execWithEnv: no env pairs is identical to exec()'s own argv shape", () => {
    assert.deepEqual(MsbCommands.execWithEnv("box-1", [], ["echo", "hi"]), ["exec", "box-1", "--", "echo", "hi"]);
  });

  it("execWithEnv: -e KEY=VALUE pairs appear right after 'exec', before the name, in spec order", () => {
    assert.deepEqual(
      MsbCommands.execWithEnv(
        "box-1",
        [
          ["A", "1"],
          ["B", "2"],
        ],
        ["redis-server", "--port", "6379"],
      ),
      ["exec", "-e", "A=1", "-e", "B=2", "box-1", "--", "redis-server", "--port", "6379"],
    );
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

  it("run: a checkpointRef spec (never actually reached via bootOnce, which dispatches those to restore()) still boots the ordinary image, not --from-snapshot", () => {
    // msb 0.7.1 removed `run --from-snapshot` outright — run() has no
    // checkpointRef branch left at all. MsbCliBackend.bootOnce is the layer
    // that now dispatches a checkpointRef spec to MsbCommands.restore()
    // instead of ever calling run() with one; this just pins that run()
    // itself no longer special-cases the field.
    const argv = MsbCommands.run(baseSpec({ checkpointRef: "rz-ckpt-abcdef012345" }));
    assert.deepEqual(argv, ["run", "--name", "rz-abc12345-1", "redis:8.6-alpine"]);
  });

  it("restore: minimal spec emits just ref and --name — never --disk-only", () => {
    const argv = MsbCommands.restore(baseSpec({ checkpointRef: "rz-ckpt-abcdef012345" }));
    assert.deepEqual(argv, ["restore", "rz-ckpt-abcdef012345", "--name", "rz-abc12345-1"]);
  });

  it("restore: never emits --disk-only — a disk-scope snapshot (the only kind this library creates) rejects it", () => {
    const argv = MsbCommands.restore(
      baseSpec({
        checkpointRef: "rz-ckpt-abcdef012345",
        memoryLimitMb: 256,
        networkDisabled: true,
        ports: [{ hostPort: 1111, guestPort: 22, protocol: "tcp" }],
        mounts: [{ hostPath: "/h", guestPath: "/g", readOnly: false }],
      }),
    );
    assert.equal(argv.includes("--disk-only"), false);
  });

  it("restore: memory flag comes right after --name", () => {
    const argv = MsbCommands.restore(baseSpec({ checkpointRef: "rz-ckpt-abcdef012345", memoryLimitMb: 256 }));
    assert.deepEqual(argv, ["restore", "rz-ckpt-abcdef012345", "--name", "rz-abc12345-1", "-m", "256M"]);
  });

  it("restore: ports appear after --name (and memory, if any), in spec order", () => {
    const argv = MsbCommands.restore(
      baseSpec({
        checkpointRef: "rz-ckpt-abcdef012345",
        ports: [
          { hostPort: 1111, guestPort: 22, protocol: "tcp" },
          { hostPort: 2222, guestPort: 80, protocol: "tcp" },
        ],
      }),
    );
    assert.deepEqual(argv, [
      "restore",
      "rz-ckpt-abcdef012345",
      "--name",
      "rz-abc12345-1",
      "-p",
      "1111:22",
      "-p",
      "2222:80",
    ]);
  });

  it("restore: a udp port binding gets a '/udp' suffix on -p, same as run() — a checkpoint reboot re-publishes the original protocol", () => {
    const argv = MsbCommands.restore(
      baseSpec({
        checkpointRef: "rz-ckpt-abcdef012345",
        ports: [
          { hostPort: 1111, guestPort: 22, protocol: "tcp" },
          { hostPort: 2222, guestPort: 53, protocol: "udp" },
        ],
      }),
    );
    assert.deepEqual(argv, [
      "restore",
      "rz-ckpt-abcdef012345",
      "--name",
      "rz-abc12345-1",
      "-p",
      "1111:22",
      "-p",
      "2222:53/udp",
    ]);
  });

  it("restore: a tcp-only spec's -p emission is byte-identical to before udp existed", () => {
    const argv = MsbCommands.restore(
      baseSpec({ checkpointRef: "rz-ckpt-abcdef012345", ports: [{ hostPort: 1111, guestPort: 22, protocol: "tcp" }] }),
    );
    assert.deepEqual(argv.slice(-2), ["-p", "1111:22"]);
    assert.equal(argv.some((a) => a.includes("/udp")), false);
  });

  it("restore: never emits -e, --mount-file, or --root-disk, even when the spec carries env/disk settings — msb restore has no such flags", () => {
    const argv = MsbCommands.restore(
      baseSpec({
        checkpointRef: "rz-ckpt-abcdef012345",
        env: [["A", "1"]],
        diskLimitMb: 4096,
      }),
    );
    for (const flag of ["-e", "--mount-file", "--root-disk"]) {
      assert.equal(argv.includes(flag), false, `restore's argv must never carry ${flag} — msb restore has no such flag`);
    }
  });

  it("restore: networkDisabled emits --no-net right after --name, before ports", () => {
    const argv = MsbCommands.restore(
      baseSpec({
        checkpointRef: "rz-ckpt-abcdef012345",
        networkDisabled: true,
        ports: [{ hostPort: 1111, guestPort: 22, protocol: "tcp" }],
      }),
    );
    assert.deepEqual(argv, [
      "restore",
      "rz-ckpt-abcdef012345",
      "--name",
      "rz-abc12345-1",
      "--no-net",
      "-p",
      "1111:22",
    ]);
  });

  it("restore: networkDisabled false emits no --no-net and no other --net flag", () => {
    const argv = MsbCommands.restore(baseSpec({ checkpointRef: "rz-ckpt-abcdef012345", networkDisabled: false }));
    assert.equal(argv.includes("--no-net"), false);
    assert.equal(argv.includes("--net"), false);
  });

  it("restore: mounts emit --volume host:guest:ro|rw,nodev after ports, in spec order", () => {
    const argv = MsbCommands.restore(
      baseSpec({
        checkpointRef: "rz-ckpt-abcdef012345",
        ports: [{ hostPort: 1111, guestPort: 22, protocol: "tcp" }],
        mounts: [
          { hostPath: "/host/f.txt", guestPath: "/guest/f.txt", readOnly: true },
          { hostPath: "/h", guestPath: "/g", readOnly: false },
        ],
      }),
    );
    assert.deepEqual(argv, [
      "restore",
      "rz-ckpt-abcdef012345",
      "--name",
      "rz-abc12345-1",
      "-p",
      "1111:22",
      "--volume",
      "/host/f.txt:/guest/f.txt:ro,nodev",
      "--volume",
      "/h:/g:rw,nodev",
    ]);
  });

  it("restore: never emits --mount-file for mounts — the flag is --volume, not run()'s spelling", () => {
    const argv = MsbCommands.restore(
      baseSpec({
        checkpointRef: "rz-ckpt-abcdef012345",
        mounts: [{ hostPath: "/h", guestPath: "/g", readOnly: false }],
      }),
    );
    assert.equal(argv.includes("--mount-file"), false);
    assert.equal(argv.includes("--volume"), true);
  });

  it("restore: memory, network, ports, and mounts all appear together in that fixed order, never --disk-only", () => {
    const argv = MsbCommands.restore(
      baseSpec({
        checkpointRef: "rz-ckpt-abcdef012345",
        memoryLimitMb: 1024,
        networkDisabled: true,
        ports: [{ hostPort: 1111, guestPort: 22, protocol: "tcp" }],
        mounts: [{ hostPath: "/h", guestPath: "/g", readOnly: false }],
      }),
    );
    assert.deepEqual(argv, [
      "restore",
      "rz-ckpt-abcdef012345",
      "--name",
      "rz-abc12345-1",
      "-m",
      "1024M",
      "--no-net",
      "-p",
      "1111:22",
      "--volume",
      "/h:/g:rw,nodev",
    ]);
  });

  it("restore: never appends the spec's command — msb restore has no trailing-command shape at all", () => {
    const argv = MsbCommands.restore(
      baseSpec({ checkpointRef: "rz-ckpt-abcdef012345", command: ["sh", "-c", "true"] }),
    );
    assert.equal(argv.includes("--"), false);
  });

  it("restore: throws when spec.checkpointRef is undefined", () => {
    assert.throws(() => MsbCommands.restore(baseSpec()));
  });

  it("snapshotCreate", () => {
    assert.deepEqual(MsbCommands.snapshotCreate("box-1", "rz-ckpt-abcdef012345"), [
      "snapshot",
      "create",
      "--from-sandbox",
      "box-1",
      "rz-ckpt-abcdef012345",
    ]);
  });

  it("snapshotCreate with a destDir appends --dest-dir <dir>", () => {
    assert.deepEqual(MsbCommands.snapshotCreate("box-1", "rz-ckpt-abcdef012345", "/cache/checkpoints"), [
      "snapshot",
      "create",
      "--from-sandbox",
      "box-1",
      "rz-ckpt-abcdef012345",
      "--dest-dir",
      "/cache/checkpoints",
    ]);
  });

  it("snapshotRemove: appends -f (force) after the ref", () => {
    assert.deepEqual(MsbCommands.snapshotRemove("/cache/checkpoints/box-1/snap_abcdef012345"), [
      "snapshot",
      "rm",
      "/cache/checkpoints/box-1/snap_abcdef012345",
      "-f",
    ]);
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

  it("snapshotImport: always carries --dest, never omitted", () => {
    assert.deepEqual(MsbCommands.snapshotImport("/in/archive.tar.zst", "/cache/checkpoints"), [
      "snapshot",
      "load",
      "/in/archive.tar.zst",
      "--dest",
      "/cache/checkpoints",
    ]);
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
