import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert } from "../../test/harness.js";
import { DockerBackendProvider, isEndpointReachable } from "./provider.js";

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
