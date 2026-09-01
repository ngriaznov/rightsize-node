import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert } from "../../test/harness.js";
import { DockerClient, socketPathFromDockerHost } from "./client.js";

/**
 * These fixtures bind a real unix-domain socket at an arbitrary filesystem
 * path via `net.createServer().listen(path)` — that is exactly the
 * mechanism the design's Windows scope excludes: the Docker backend is
 * unix-socket-only and does not apply on Windows at all (confirmed:
 * `listen()` on such a path fails there with EACCES, since Windows has no
 * unix-domain-socket-at-a-filesystem-path concept the way POSIX does).
 * These are unit-test fixtures standing in for a real daemon, not IT-gated
 * tests, so they cannot route through `itDockerIntegration`'s daemon-
 * reachability probe; skipping outright on win32 is the correct behavior
 * for a mechanism that is structurally POSIX-only, not merely
 * environment-dependent.
 */
function skipOnWindows(): boolean {
  return process.platform === "win32";
}

/**
 * A throwaway unix-socket path in a fresh temp dir per fixture — short enough
 * to stay under a unix socket's SUN_LEN limit (~104 bytes on macOS), which is
 * why this doesn't route through `os.tmpdir()` (whose per-process TMPDIR on
 * macOS already eats a large chunk of that budget on its own).
 */
function freshSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rzd-"));
  return path.join(dir, "d.sock");
}

/** Binds a fixture unix-socket server that writes `response` verbatim to the first connection then closes it. */
async function fixtureServer(response: Buffer | string): Promise<{ sockPath: string; close: () => void }> {
  const sockPath = freshSocketPath();
  const server = net.createServer((socket) => {
    socket.on("data", () => {
      // Drain whatever the client sent; these tests only care what the client parses back.
    });
    socket.end(response);
  });
  await new Promise<void>((r) => server.listen(sockPath, r));
  return { sockPath, close: () => server.close() };
}

describe("DockerClient request framing", () => {
  it("parses a Content-Length response", async () => {
    if (skipOnWindows()) {
      return;
    }
    const { sockPath, close } = await fixtureServer(
      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 12\r\n\r\n{\"Id\":\"abc\"}",
    );
    const client = new DockerClient(sockPath);
    const resp = await client.request("GET", "/_ping");
    assert.equal(resp.status, 200);
    assert.equal(resp.body.toString(), '{"Id":"abc"}');
    close();
  });

  it("parses a chunked response", async () => {
    if (skipOnWindows()) {
      return;
    }
    const { sockPath, close } = await fixtureServer(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
    );
    const client = new DockerClient(sockPath);
    const resp = await client.request("GET", "/containers/x/logs");
    assert.equal(resp.status, 200);
    assert.equal(resp.body.toString(), "hello world");
    close();
  });

  it("parses a non-200 status with an empty body", async () => {
    if (skipOnWindows()) {
      return;
    }
    const { sockPath, close } = await fixtureServer("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
    const client = new DockerClient(sockPath);
    const resp = await client.request("GET", "/images/missing/json");
    assert.equal(resp.status, 404);
    assert.equal(resp.body.length, 0);
    close();
  });

  it("parses a 500 with a JSON error body", async () => {
    if (skipOnWindows()) {
      return;
    }
    const { sockPath, close } = await fixtureServer(
      'HTTP/1.1 500 Internal Server Error\r\nContent-Length: 28\r\n\r\n{"message":"already in use"}',
    );
    const client = new DockerClient(sockPath);
    const resp = await client.request("POST", "/containers/x/start");
    assert.equal(resp.status, 500);
    assert.equal(resp.body.toString(), '{"message":"already in use"}');
    close();
  });

  it("sends a JSON body with a matching Content-Length", async () => {
    if (skipOnWindows()) {
      return;
    }
    const sockPath = freshSocketPath();
    let received = "";
    const server = net.createServer((socket) => {
      // Respond only once the request has actually arrived — matches how a
      // real daemon behaves (it reads the request before writing a
      // response), and avoids a fixture-only race where ending the
      // connection immediately on accept can tear it down before an
      // HTTP-client implementation has flushed the request it just queued.
      socket.on("data", (chunk) => {
        received += chunk.toString();
        socket.end("HTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\n{}");
      });
    });
    await new Promise<void>((r) => server.listen(sockPath, r));
    const client = new DockerClient(sockPath);
    const body = JSON.stringify({ Image: "redis" });
    const resp = await client.request("POST", "/containers/create?name=x", body);
    assert.equal(resp.status, 201);
    assert.ok(received.startsWith("POST /containers/create?name=x HTTP/1.1\r\n"));
    assert.ok(received.includes(`Content-Length: ${Buffer.byteLength(body)}\r\n`));
    assert.ok(received.includes("Content-Type: application/json\r\n"));
    assert.ok(received.endsWith(body));
    server.close();
  });
});

describe("DockerClient connect/response timeout", () => {
  it("rejects with a named error instead of hanging forever when the daemon never responds", async () => {
    if (skipOnWindows()) {
      return;
    }
    // Accepts the connection and reads whatever the client sends, but never
    // writes a response — reproduces the hang this timeout exists to bound:
    // without it, send() has nothing that ever settles its promise on a
    // stalled connection/header phase, independent of RESPONSE_TIMEOUT_MS
    // (which only starts once a response has already arrived).
    const sockPath = freshSocketPath();
    const server = net.createServer((socket) => {
      socket.on("data", () => {
        // Drain the request; deliberately never write or end a response.
      });
    });
    await new Promise<void>((r) => server.listen(sockPath, r));

    const client = new DockerClient(sockPath, 200);
    let caught: unknown;
    try {
      await client.request("GET", "/_ping");
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error, `expected an Error, got ${String(caught)}`);
    assert.match((caught as Error).message, /did not connect\/respond within/);

    server.close();
  });
});

describe("DockerClient request_stream", () => {
  it("returns headers and a still-open socket positioned after the header block", async () => {
    if (skipOnWindows()) {
      return;
    }
    const { sockPath, close } = await fixtureServer("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello");
    const client = new DockerClient(sockPath);
    const { status, chunked, contentLength, body } = await client.requestStream("GET", "/x");
    assert.equal(status, 200);
    assert.equal(chunked, false);
    assert.equal(contentLength, 5);
    const collected: Buffer[] = [];
    for await (const chunk of body) {
      collected.push(chunk as Buffer);
    }
    assert.equal(Buffer.concat(collected).toString(), "hello");
    close();
  });
});

describe("socketPathFromDockerHost", () => {
  const DEFAULT = "/var/run/docker.sock";
  // The real per-platform default for whichever host actually runs this
  // file — used by the tests below that call the two-arg form with no
  // platform override, so they stay accurate whether run on POSIX or on an
  // actual win32 CI runner (see backend.test.ts's transport regression
  // describe block for the analogous split).
  const REAL_DEFAULT = process.platform === "win32" ? "\\\\.\\pipe\\docker_engine" : DEFAULT;

  it("falls back to this host's default endpoint when unset", () => {
    assert.equal(socketPathFromDockerHost(undefined), REAL_DEFAULT);
  });

  it("parses a unix:// scheme path", () => {
    assert.equal(socketPathFromDockerHost("unix:///run/user/1000/docker.sock"), "/run/user/1000/docker.sock");
  });

  it("accepts a bare path with no scheme", () => {
    assert.equal(socketPathFromDockerHost("/custom/docker.sock"), "/custom/docker.sock");
  });

  it("falls back to this host's default endpoint for a tcp:// host — this client has no TCP transport", () => {
    assert.equal(socketPathFromDockerHost("tcp://127.0.0.1:2375"), REAL_DEFAULT);
  });

  it("falls back to this host's default endpoint for an http:// host", () => {
    assert.equal(socketPathFromDockerHost("http://127.0.0.1:2375"), REAL_DEFAULT);
  });
});

/**
 * The per-platform endpoint decision, exercised via the injected-platform
 * seam (`socketPathFromDockerHost`'s second parameter) so every case runs
 * deterministically on any host — mirrors `PlatformInfo`'s `_currentFor`
 * tests in `backend-msb/platform.test.ts`, which exercise Windows-only
 * branches from a non-Windows dev machine the same way.
 */
describe("socketPathFromDockerHost — injected-platform seam", () => {
  const UNIX_DEFAULT = "/var/run/docker.sock";
  const WIN32_DEFAULT = "\\\\.\\pipe\\docker_engine";

  it("defaults to the unix socket path on posix platforms", () => {
    assert.equal(socketPathFromDockerHost(undefined, "linux"), UNIX_DEFAULT);
    assert.equal(socketPathFromDockerHost(undefined, "darwin"), UNIX_DEFAULT);
  });

  it("defaults to the named pipe path on win32", () => {
    assert.equal(socketPathFromDockerHost(undefined, "win32"), WIN32_DEFAULT);
  });

  it("parses an npipe:// scheme path into the literal pipe path", () => {
    assert.equal(socketPathFromDockerHost("npipe:////./pipe/docker_engine", "win32"), WIN32_DEFAULT);
  });

  it("parses an npipe:// scheme path naming a non-default pipe", () => {
    assert.equal(socketPathFromDockerHost("npipe:////./pipe/custom_engine", "win32"), "\\\\.\\pipe\\custom_engine");
  });

  it("accepts a bare named pipe path with no scheme", () => {
    assert.equal(socketPathFromDockerHost("\\\\.\\pipe\\docker_engine", "win32"), WIN32_DEFAULT);
  });

  it("npipe:// parsing does not depend on the injected platform — unix:// parsing is likewise platform-agnostic today", () => {
    assert.equal(socketPathFromDockerHost("npipe:////./pipe/docker_engine", "linux"), WIN32_DEFAULT);
  });

  it("a tcp:// DOCKER_HOST falls back to the win32 default, never leaking a TCP port into the transport", () => {
    assert.equal(socketPathFromDockerHost("tcp://127.0.0.1:2375", "win32"), WIN32_DEFAULT);
  });

  it("a unix:// DOCKER_HOST is honored verbatim regardless of the injected platform", () => {
    assert.equal(socketPathFromDockerHost("unix:///run/user/1000/docker.sock", "win32"), "/run/user/1000/docker.sock");
  });
});
