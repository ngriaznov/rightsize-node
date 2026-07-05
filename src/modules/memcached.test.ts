import * as net from "node:net";
import { describe, it, assert } from "../../test/harness.js";
import { MemcachedContainer, MemcachedRespondsStrategy } from "./memcached.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";
import type { WaitTarget } from "../core/wait.js";

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected an AddressInfo");
      }
      resolve(address.port);
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function fakeWaitTarget(port: number): WaitTarget {
  return {
    host: "127.0.0.1",
    mappedPort: () => port,
    exposedGuestPorts: [11211],
    currentLogs: async () => "",
    describe: () => "fake memcached target",
  };
}

describe("MemcachedContainer wait strategy", () => {
  it("is ready once the peer replies with a VERSION line", async () => {
    const server = net.createServer((socket) => {
      socket.on("data", (chunk) => {
        if (chunk.toString("utf8").startsWith("version")) {
          socket.write("VERSION 1.6.31\r\n");
        }
      });
    });
    const port = await listen(server);
    try {
      const strategy = new MemcachedRespondsStrategy().withStartupTimeout(2_000);
      await strategy.waitUntilReady(fakeWaitTarget(port));
    } finally {
      await close(server);
    }
  });

  it("times out against a peer that accepts but never replies VERSION", async () => {
    const server = net.createServer((socket) => {
      socket.on("data", () => {
        // Accept the connection and the version command, but never reply —
        // proves the strategy doesn't confuse "connected" with "ready".
      });
    });
    const port = await listen(server);
    try {
      const strategy = new MemcachedRespondsStrategy().withStartupTimeout(300);
      await assert.rejects(() => strategy.waitUntilReady(fakeWaitTarget(port)));
    } finally {
      await close(server);
    }
  });

  it("times out against a closed port with no listener at all", async () => {
    const server = net.createServer();
    const port = await listen(server);
    await close(server);
    const strategy = new MemcachedRespondsStrategy().withStartupTimeout(300);
    await assert.rejects(() => strategy.waitUntilReady(fakeWaitTarget(port)));
  });

  it("builder -> spec: exposes port 11211 and builds the address accessor", async () => {
    const backend = new FakeModuleBackend();
    const mc = new MemcachedContainer().withBackend(backend).waitingFor(instantReadyWait());
    await mc.start();
    try {
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [11211]);
      assert.equal(mc.address, `127.0.0.1:${mc.getMappedPort(11211)}`);
    } finally {
      await mc.stop();
    }
  });

  it("accepts a custom image tag via the constructor", async () => {
    const backend = new FakeModuleBackend();
    const mc = new MemcachedContainer("memcached:1.6.31-alpine").withBackend(backend).waitingFor(instantReadyWait());
    await mc.start();
    try {
      assert.equal(backend.lastSpec?.image, "memcached:1.6.31-alpine");
    } finally {
      await mc.stop();
    }
  });
});
