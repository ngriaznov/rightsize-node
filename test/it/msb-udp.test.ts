import * as dgram from "node:dgram";
import { describe, itMsbIntegration as itIntegration, assert } from "../harness.js";
import { GenericContainer } from "../../src/core/generic-container.js";
import { Wait } from "../../src/core/wait.js";
import { MsbCliBackend } from "../../src/backend-msb/backend.js";
import { ensureInstalled } from "../../src/backend-msb/provisioner.js";

/**
 * Real-msb-binary coverage for the Phase-1 UDP host-port-publish path (the
 * FACT this whole feature is built on: msb 0.7.1's `-p HOST:GUEST/udp` was
 * live-verified end to end — host-to-guest datagram arrives). A host-side
 * UDP socket sends into a running sandbox's `withExposedUdpPorts`/
 * `getMappedUdpPort` mapped port; the guest's own `nc -u -l -p <port>`
 * writes whatever it receives to a file, polled via `exec cat` — the same
 * shape `msb-network-links.test.ts` uses for its own reachability poll, one
 * layer down (a raw UDP datagram in place of an HTTP fetch through a
 * tunnel).
 *
 * Wrapped in a short bounded resend loop: a UDP datagram can be dropped even
 * over a microVM's loopback-published port, so a single send-then-check is
 * not a reliable test — this resends every poll interval until the guest's
 * file shows the payload or the deadline passes.
 */
describe("msb UDP host-port publish (the provisioner's pinned msb binary)", () => {
  itIntegration("a host-sent UDP datagram lands in the guest via the mapped UDP port", async () => {
    await using target = await new GenericContainer("alpine:3.19")
      .withBackend(new MsbCliBackend(ensureInstalled()))
      .withExposedUdpPorts(9999)
      .withCommand("sh", "-c", "nc -u -l -p 9999 > /srv/got.txt")
      .waitingFor(Wait.forLogMessage(".*", 0))
      .start();

    const hostPort = target.getMappedUdpPort(9999);

    const sendPing = (): Promise<void> =>
      new Promise((resolve, reject) => {
        const socket = dgram.createSocket("udp4");
        socket.send("PING-FROM-HOST", hostPort, "127.0.0.1", (err) => {
          socket.close();
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

    let got = "";
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && got !== "PING-FROM-HOST") {
      await sendPing();
      await new Promise((r) => setTimeout(r, 500));
      const read = await target.exec("sh", "-c", "cat /srv/got.txt 2>/dev/null || true");
      got = read.stdout.trim();
    }
    assert.equal(
      got,
      "PING-FROM-HOST",
      "expected msb's '-p HOST:GUEST/udp' published port to deliver a host-sent datagram into the guest",
    );
  });
});
