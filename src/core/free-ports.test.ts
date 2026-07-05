import * as net from "node:net";
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
