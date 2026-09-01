import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert } from "../../test/harness.js";
import {
  DockerBackendProvider,
  isEndpointReachable,
  daemonOsProbeCommand,
  isLinuxDaemonOs,
  isLinuxDaemonReachable,
  type DaemonProbeRunner,
} from "./provider.js";

describe("DockerBackendProvider", () => {
  it("name and priority are pinned", () => {
    const provider = new DockerBackendProvider();
    assert.equal(provider.name, "docker");
    assert.equal(provider.priority, 10);
  });

  it("unsupportedReason names the daemon socket", () => {
    const provider = new DockerBackendProvider();
    assert.ok(provider.unsupportedReason().toLowerCase().includes("docker"));
  });

  it("unsupportedReason names the named pipe on win32", () => {
    const provider = new DockerBackendProvider();
    if (process.platform !== "win32") {
      return; // the posix wording is covered by the previous test.
    }
    assert.match(provider.unsupportedReason(), /pipe/i);
  });

  it("isSupported is synchronous — never returns a Promise", () => {
    const provider = new DockerBackendProvider();
    const result = provider.isSupported();
    assert.equal(typeof result, "boolean");
  });
});

/**
 * `isEndpointReachable`'s pure POSIX/Windows decision, exercised via its
 * injected-platform seam (second parameter) — mirrors `PlatformInfo`'s
 * `_currentFor`-style tests in `backend-msb/platform.test.ts`, which
 * exercise Windows-only branches from a non-Windows dev machine the same
 * way. Every case here runs deterministically on any host: the win32 branch
 * never needs a real named pipe (bare stat success is its whole check), and
 * the posix branch's real-unix-socket case is structurally impossible on
 * Windows for the same reason `client.test.ts`'s fixture server is (no
 * unix-domain-socket-at-a-filesystem-path concept there), so only that one
 * case is skipped on win32.
 */
describe("isEndpointReachable", () => {
  function freshTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "rzd-provider-"));
  }

  it("is false when nothing exists at the path, on either platform", () => {
    const missing = path.join(freshTempDir(), "does-not-exist");
    assert.equal(isEndpointReachable(missing, "linux"), false);
    assert.equal(isEndpointReachable(missing, "win32"), false);
  });

  it("posix: is false for a plain regular file — a stray file must never read as a running daemon", () => {
    const filePath = path.join(freshTempDir(), "not-a-socket");
    fs.writeFileSync(filePath, "");
    assert.equal(isEndpointReachable(filePath, "linux"), false);
    assert.equal(isEndpointReachable(filePath, "darwin"), false);
  });

  it("posix: is true for a real unix domain socket", () => {
    if (process.platform === "win32") {
      return; // binding a real unix socket at a filesystem path is structurally POSIX-only.
    }
    const sockPath = path.join(freshTempDir(), "d.sock");
    const server = net.createServer();
    server.listen(sockPath);
    try {
      assert.equal(isEndpointReachable(sockPath, process.platform), true);
    } finally {
      server.close();
    }
  });

  it("win32: is true for any existing entry regardless of type — fs.Stats type bits are unreliable for named pipes there", () => {
    const filePath = path.join(freshTempDir(), "some-file");
    fs.writeFileSync(filePath, "");
    assert.equal(isEndpointReachable(filePath, "win32"), true);
  });
});

/**
 * The pure per-platform command `isLinuxDaemonReachable` spawns — never
 * actually spawned here (mirrors `cleanupSyncCommand`'s own tests in
 * `backend.test.ts`, which check only the argv it would run).
 */
describe("daemonOsProbeCommand", () => {
  it("on POSIX platforms, dials curl --unix-socket for GET /version", () => {
    for (const platform of ["linux", "darwin"]) {
      const { command, args } = daemonOsProbeCommand(platform, "/var/run/docker.sock");
      assert.equal(command, "curl");
      assert.deepEqual(args, [
        "--silent",
        "--max-time",
        "2",
        "--unix-socket",
        "/var/run/docker.sock",
        "http://localhost/version",
      ]);
    }
  });

  it("on win32, never invokes curl with the named pipe path — shells out to `docker version` instead", () => {
    const { command, args } = daemonOsProbeCommand("win32", "\\\\.\\pipe\\docker_engine");
    assert.equal(command, "docker");
    assert.deepEqual(args, ["version", "--format", "{{json .Server}}"]);
    assert.equal(args.includes("--unix-socket"), false, "must never pass a named pipe path to curl's --unix-socket");
  });

  it("the win32 command is independent of the socket path — docker CLI resolves DOCKER_HOST/the pipe itself", () => {
    const withCustomPipe = daemonOsProbeCommand("win32", "\\\\.\\pipe\\some_custom_pipe");
    assert.deepEqual(withCustomPipe, { command: "docker", args: ["version", "--format", "{{json .Server}}"] });
  });
});

/** The pure JSON-to-verdict decision, fed the raw stdout either probe command would print. */
describe("isLinuxDaemonOs", () => {
  it("true when the daemon reports linux", () => {
    assert.equal(isLinuxDaemonOs(JSON.stringify({ Os: "linux", Version: "27.0.0" })), true);
  });

  it("the value comparison is case-insensitive", () => {
    assert.equal(isLinuxDaemonOs(JSON.stringify({ Os: "Linux" })), true);
    assert.equal(isLinuxDaemonOs(JSON.stringify({ Os: "LINUX" })), true);
  });

  it("false when the daemon reports windows — a Windows-containers dockerd, e.g. a GitHub Windows runner's own daemon", () => {
    assert.equal(isLinuxDaemonOs(JSON.stringify({ Os: "windows", Version: "27.0.0" })), false);
  });

  it("false for a non-JSON or empty body — a failed/timed-out probe's stdout", () => {
    assert.equal(isLinuxDaemonOs(""), false);
    assert.equal(isLinuxDaemonOs("not json at all"), false);
  });

  it("false when the body is JSON but has no Os field, or Os isn't a string", () => {
    assert.equal(isLinuxDaemonOs(JSON.stringify({ Version: "27.0.0" })), false);
    assert.equal(isLinuxDaemonOs(JSON.stringify({ Os: 42 })), false);
    assert.equal(isLinuxDaemonOs(JSON.stringify(null)), false);
    assert.equal(isLinuxDaemonOs(JSON.stringify(["linux"])), false);
  });
});

/**
 * `isSupported()`'s actual gate, exercised through the injected-`runner`
 * seam (mirrors `DockerClient`'s own injected `connectTimeoutMs` seam) so
 * these run deterministically with no real daemon, no real `curl`/`docker`
 * process, and no real timeout wait — the three red-proof cases the
 * detection change exists for, plus the spawn-failure edge next to case (c).
 */
describe("isLinuxDaemonReachable — the linux-daemon gate", () => {
  it("(a) daemon reports linux => supported", () => {
    const fakeRunner: DaemonProbeRunner = () => ({ status: 0, stdout: JSON.stringify({ Os: "linux" }) });
    assert.equal(isLinuxDaemonReachable("linux", "/var/run/docker.sock", fakeRunner), true);
  });

  it("(b) daemon reports windows => NOT supported, even though it's perfectly reachable", () => {
    const fakeRunner: DaemonProbeRunner = () => ({ status: 0, stdout: JSON.stringify({ Os: "windows" }) });
    assert.equal(isLinuxDaemonReachable("win32", "\\\\.\\pipe\\docker_engine", fakeRunner), false);
  });

  it("(c) probe failure/timeout => not supported", () => {
    // The exact shape `spawnSync` reports when its own `timeout` option kills
    // a wedged child: a null exit status, no signal-driven exception, empty
    // stdout — never a thrown error.
    const timedOutRunner: DaemonProbeRunner = () => ({ status: null, stdout: "" });
    assert.equal(isLinuxDaemonReachable("linux", "/var/run/docker.sock", timedOutRunner), false);
  });

  it("a spawn error (missing curl/docker binary) is also unsupported, never thrown", () => {
    const missingBinaryRunner: DaemonProbeRunner = () => ({ status: null, stdout: "", error: new Error("ENOENT") });
    assert.equal(isLinuxDaemonReachable("darwin", "/var/run/docker.sock", missingBinaryRunner), false);
  });

  it("a runner that throws synchronously still resolves to false rather than propagating", () => {
    const throwingRunner: DaemonProbeRunner = () => {
      throw new Error("spawnSync blew up");
    };
    assert.equal(isLinuxDaemonReachable("linux", "/var/run/docker.sock", throwingRunner), false);
  });

  it("a non-zero exit (daemon reachable but the request itself failed) is unsupported", () => {
    const nonZeroExitRunner: DaemonProbeRunner = () => ({ status: 1, stdout: "" });
    assert.equal(isLinuxDaemonReachable("linux", "/var/run/docker.sock", nonZeroExitRunner), false);
  });
});
