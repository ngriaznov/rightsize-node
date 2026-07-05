import * as net from "node:net";
import * as http from "node:http";
import { describe, it, assert } from "../../test/harness.js";
import { Wait } from "./wait.js";
import { ContainerLaunchError } from "./errors.js";
import type { WaitTarget } from "./wait.js";

function fakeTarget(overrides: Partial<WaitTarget> & { mappedPorts?: Record<number, number> } = {}): WaitTarget {
  const mappedPorts = overrides.mappedPorts ?? {};
  return {
    host: overrides.host ?? "127.0.0.1",
    mappedPort: overrides.mappedPort ?? ((guestPort: number) => {
      const p = mappedPorts[guestPort];
      if (p === undefined) {
        throw new Error(`no mapped port for guest port ${guestPort}`);
      }
      return p;
    }),
    exposedGuestPorts: overrides.exposedGuestPorts ?? [],
    currentLogs: overrides.currentLogs ?? (async () => ""),
    describe: overrides.describe ?? (() => "fake-target"),
  };
}

function listenOnFreePort(server: net.Server): Promise<number> {
  return new Promise((resolvePort) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected an AddressInfo");
      }
      resolvePort(address.port);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

describe("Wait.forListeningPort", () => {
  it("succeeds against an open, holding-peer port", async () => {
    const server = net.createServer((socket) => {
      // Hold the connection open; never send data, never close.
      socket.on("data", () => {});
    });
    const port = await listenOnFreePort(server);
    try {
      const target = fakeTarget({ exposedGuestPorts: [1234], mappedPorts: { 1234: port } });
      await Wait.forListeningPort().withStartupTimeout(2_000).waitUntilReady(target);
    } finally {
      await closeServer(server);
    }
  });

  it("times out on a closed port, with a message carrying describe() and a log line", async () => {
    // Pick a port nothing is listening on: bind then release it.
    const probe = net.createServer();
    const port = await listenOnFreePort(probe);
    await closeServer(probe);

    const target = fakeTarget({
      exposedGuestPorts: [9999],
      mappedPorts: { 9999: port },
      describe: () => "my-fake-container",
      currentLogs: async () => "line one\nline two\n",
    });

    await assert.rejects(async () => {
      await Wait.forListeningPort().withStartupTimeout(500).waitUntilReady(target);
    });

    try {
      await Wait.forListeningPort().withStartupTimeout(500).waitUntilReady(target);
      assert.ok(false, "expected a timeout");
    } catch (err) {
      assert.ok(err instanceof ContainerLaunchError);
      assert.match((err as Error).message, /my-fake-container/);
      assert.match((err as Error).message, /line two/);
    }
  });

  it("rejects an accept-then-EOF proxy (data-or-timeout is required, connect alone is not enough)", async () => {
    const server = net.createServer((socket) => {
      // Accept then immediately close — simulates docker-proxy accepting
      // before the guest process has bound.
      socket.end();
      socket.destroy();
    });
    const port = await listenOnFreePort(server);
    try {
      const target = fakeTarget({ exposedGuestPorts: [1234], mappedPorts: { 1234: port } });
      await assert.rejects(async () => {
        await Wait.forListeningPort().withStartupTimeout(500).waitUntilReady(target);
      });
    } finally {
      await closeServer(server);
    }
  });

  it("is vacuously ready when no ports are exposed", async () => {
    const target = fakeTarget({ exposedGuestPorts: [] });
    await Wait.forListeningPort().withStartupTimeout(100).waitUntilReady(target);
  });

  it("performs at least one probe even with a sub-poll-interval timeout", async () => {
    const server = net.createServer((socket) => socket.on("data", () => {}));
    const port = await listenOnFreePort(server);
    try {
      const target = fakeTarget({ exposedGuestPorts: [1234], mappedPorts: { 1234: port } });
      // 1ms timeout: the do-while shape must still probe once and succeed
      // against an already-open port rather than failing on the deadline
      // check before any probe runs.
      await Wait.forListeningPort().withStartupTimeout(1).waitUntilReady(target);
    } finally {
      await closeServer(server);
    }
  });

  it("a connect that never completes still resolves within a bounded time (hard backstop)", async () => {
    // 192.0.2.1 is TEST-NET-1 (RFC 5737): reserved for documentation/testing,
    // guaranteed non-routable, and — unlike a real firewalled host — does
    // not send back an ICMP unreachable that would turn this into a fast
    // `error` instead of a genuine connect-phase hang. Without a hard timer
    // backstop (independent of socket.setTimeout(), which this probe only
    // arms AFTER connect succeeds), a connect that neither succeeds nor
    // errors would hang forever regardless of withStartupTimeout, since the
    // outer poll loop can't rescue a probe() call that never itself
    // resolves.
    const target = fakeTarget({ exposedGuestPorts: [1234], mappedPorts: { 1234: 1234 }, host: "192.0.2.1" });
    const start = Date.now();
    await assert.rejects(async () => {
      await Wait.forListeningPort().withStartupTimeout(300).waitUntilReady(target);
    });
    const elapsed = Date.now() - start;
    // Generous ceiling: the connect-phase backstop plus one extra poll
    // interval, not a tight race against exact timer values.
    assert.ok(elapsed < 10_000, `expected the black-holed connect to resolve well under 10s, took ${elapsed}ms`);
  });
});

describe("Wait.forHttp", () => {
  it("matches on path and status code", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200);
        res.end("ok");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const port = await new Promise<number>((resolveP) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr === null || typeof addr === "string") throw new Error("expected AddressInfo");
        resolveP(addr.port);
      });
    });
    try {
      const target = fakeTarget({ exposedGuestPorts: [80], mappedPorts: { 80: port } });
      await Wait.forHttp("/healthz").forPort(80).forStatusCode(200).withStartupTimeout(2_000).waitUntilReady(target);
    } finally {
      await closeServer(server);
    }
  });

  it("falls back to the first exposed port when forPort is never called", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    const port = await new Promise<number>((resolveP) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr === null || typeof addr === "string") throw new Error("expected AddressInfo");
        resolveP(addr.port);
      });
    });
    try {
      const target = fakeTarget({ exposedGuestPorts: [8080], mappedPorts: { 8080: port } });
      await Wait.forHttp("/").withStartupTimeout(2_000).waitUntilReady(target);
    } finally {
      await closeServer(server);
    }
  });

  it("timeout message carries the log tail", async () => {
    const probe = net.createServer();
    const port = await listenOnFreePort(probe);
    await closeServer(probe);
    const target = fakeTarget({
      exposedGuestPorts: [80],
      mappedPorts: { 80: port },
      currentLogs: async () => "boot failed\n",
    });
    try {
      await Wait.forHttp("/").withStartupTimeout(500).waitUntilReady(target);
      assert.ok(false, "expected a timeout");
    } catch (err) {
      assert.ok(err instanceof ContainerLaunchError);
      assert.match((err as Error).message, /boot failed/);
    }
  });
});

describe("Wait.forLogMessage", () => {
  it("polls until the pattern is seen the requested number of times", async () => {
    let callCount = 0;
    const target = fakeTarget({
      currentLogs: async () => {
        callCount++;
        // Ready by the 3rd probe.
        return callCount >= 3 ? "ready\nready\n" : "starting\n";
      },
    });
    await Wait.forLogMessage("ready", 2).withStartupTimeout(2_000).waitUntilReady(target);
    assert.ok(callCount >= 3);
  });

  it("times=0 is ready immediately, even before logs are fetchable", async () => {
    const target = fakeTarget({
      currentLogs: async () => {
        throw new Error("logs not available yet");
      },
    });
    await Wait.forLogMessage("anything", 0).withStartupTimeout(100).waitUntilReady(target);
  });

  it("a line matching both whole-line and substring counts once", async () => {
    const target = fakeTarget({
      currentLogs: async () => "ready to accept connections\n",
    });
    // times=1: a single matching line must satisfy this even though the
    // pattern also matches as a substring within that same line.
    await Wait.forLogMessage("ready", 1).withStartupTimeout(500).waitUntilReady(target);
  });
});
