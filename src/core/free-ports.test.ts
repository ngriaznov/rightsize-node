import * as net from "node:net";
import * as dgram from "node:dgram";
import { describe, it, assert } from "../../test/harness.js";
import { FreePorts } from "./free-ports.js";

function canBind(port: number): Promise<boolean> {
  return new Promise((resolveBind) => {
    const server = net.createServer();
    server.once("error", () => resolveBind(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolveBind(true));
    });
  });
}

function canBindUdp(port: number): Promise<boolean> {
  return new Promise((resolveBind) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", () => resolveBind(false));
    socket.bind(port, "127.0.0.1", () => {
      socket.close(() => resolveBind(true));
    });
  });
}

describe("FreePorts.allocate", () => {
  it("returns unique, bindable ports", async () => {
    const ports = await Promise.all([FreePorts.allocate(), FreePorts.allocate(), FreePorts.allocate(), FreePorts.allocate(), FreePorts.allocate()]);
    const unique = new Set(ports);
    assert.equal(unique.size, ports.length);
    for (const port of ports) {
      assert.ok(port > 0);
      assert.ok(await canBind(port));
    }
    for (const port of ports) {
      FreePorts.release(port);
    }
  });
});

describe("FreePorts.release", () => {
  it("removes the port from issuedView so it can be reissued", async () => {
    const port = await FreePorts.allocate();
    assert.ok(FreePorts.issuedView().has(port));
    FreePorts.release(port);
    assert.ok(!FreePorts.issuedView().has(port));
  });

  it("releasing an unissued port is a harmless no-op", () => {
    const before = FreePorts.issuedView().size;
    FreePorts.release(59999);
    assert.equal(FreePorts.issuedView().size, before);
  });

  // Mutation-proof: a no-op release() leaves the port permanently in
  // issuedView, which this test observes directly and independently of
  // whichever OS port happens to get allocated next.
  it("fails if release is a no-op (mutation guard)", async () => {
    const before = FreePorts.issuedView().size;
    const port = await FreePorts.allocate();
    assert.equal(FreePorts.issuedView().size, before + 1);

    FreePorts.release(port);

    // A no-op release() would leave issuedView().size at before+1 forever;
    // a real release() brings it back down to `before`.
    assert.equal(FreePorts.issuedView().size, before);
    assert.ok(!FreePorts.issuedView().has(port));
  });
});

describe("FreePorts.allocateUdp", () => {
  it("returns unique, UDP-bindable ports", async () => {
    const ports = await Promise.all([
      FreePorts.allocateUdp(),
      FreePorts.allocateUdp(),
      FreePorts.allocateUdp(),
      FreePorts.allocateUdp(),
      FreePorts.allocateUdp(),
    ]);
    const unique = new Set(ports);
    assert.equal(unique.size, ports.length);
    for (const port of ports) {
      assert.ok(port > 0);
      assert.ok(await canBindUdp(port));
    }
    for (const port of ports) {
      FreePorts.releaseUdp(port);
    }
  });
});

describe("FreePorts.releaseUdp", () => {
  it("removes the port from issuedUdpView so it can be reissued", async () => {
    const port = await FreePorts.allocateUdp();
    assert.ok(FreePorts.issuedUdpView().has(port));
    FreePorts.releaseUdp(port);
    assert.ok(!FreePorts.issuedUdpView().has(port));
  });

  it("releasing an unissued UDP port is a harmless no-op", () => {
    const before = FreePorts.issuedUdpView().size;
    FreePorts.releaseUdp(59999);
    assert.equal(FreePorts.issuedUdpView().size, before);
  });

  // Mutation-proof, mirroring the TCP guard above.
  it("fails if releaseUdp is a no-op (mutation guard)", async () => {
    const before = FreePorts.issuedUdpView().size;
    const port = await FreePorts.allocateUdp();
    assert.equal(FreePorts.issuedUdpView().size, before + 1);

    FreePorts.releaseUdp(port);

    assert.equal(FreePorts.issuedUdpView().size, before);
    assert.ok(!FreePorts.issuedUdpView().has(port));
  });
});

describe("FreePorts — TCP and UDP pools are independent", () => {
  it("release() never touches the UDP pool, and releaseUdp() never touches the TCP pool", async () => {
    const tcpPort = await FreePorts.allocate();
    const udpPort = await FreePorts.allocateUdp();

    // Releasing the TCP port via the UDP function is a no-op against the UDP
    // pool (the TCP port was never issued there), and the TCP port must stay
    // issued in its OWN pool until release() itself is called.
    FreePorts.releaseUdp(tcpPort);
    assert.ok(FreePorts.issuedView().has(tcpPort));

    FreePorts.release(udpPort);
    assert.ok(FreePorts.issuedUdpView().has(udpPort));

    FreePorts.release(tcpPort);
    FreePorts.releaseUdp(udpPort);
  });
});
