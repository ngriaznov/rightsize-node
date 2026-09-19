import * as dgram from "node:dgram";
import { describe, itDockerIntegration, assert } from "../harness.js";
import { GenericContainer } from "../../src/core/generic-container.js";
import { Network } from "../../src/core/network.js";
import { Wait } from "../../src/core/wait.js";
import { DockerBackend } from "../../src/backend-docker/backend.js";
import { DockerClient } from "../../src/backend-docker/client.js";

/**
 * Real docker-daemon UDP coverage (RIGHTSIZE_IT=1 + a reachable Linux
 * container daemon — see `itDockerIntegration`'s own doc). The two Phase-1
 * UDP paths this library's unit suites can only prove the PLUMBING for
 * (argv/payload shape), never the actual on-the-wire behavior:
 *
 *  (a) container-to-container UDP on a shared docker network — no
 *      `NetworkLink`/`withExposedUdpPorts` involved at all, since docker's
 *      native bridge network already carries UDP between members with no
 *      per-port declaration (see `buildCreateBody`'s own doc and the
 *      networking guide's "what each backend actually does" section);
 *  (b) a host-side UDP socket reaching a container through its
 *      `withExposedUdpPorts`/`getMappedUdpPort` mapped port.
 *
 * Both use alpine:3.19's busybox `nc -u`. Each probe is wrapped in a short
 * bounded resend loop — a single UDP datagram can be lost even on loopback
 * or a bridge network under load, and a real test must tolerate that rather
 * than flake on the first send.
 */
function newDockerBackend(): DockerBackend {
  return new DockerBackend(new DockerClient());
}

describe("docker UDP (real daemon)", () => {
  itDockerIntegration("container-to-container UDP echo over a shared network — no NetworkLink involved", async () => {
    await using network = Network.newNetwork();

    // A `while true` respawn loop: a bare `nc -u -l ... -e /bin/cat` handles
    // one exchange then exits, the same one-shot-then-respawn shape msb's
    // own exec-tunnel listener has (see ExecTunnel's own doc) — this keeps
    // the echo server available across the resend loop's retries below.
    await using echoServer = await new GenericContainer("alpine:3.19")
      .withBackend(newDockerBackend())
      .withNetwork(network)
      .withNetworkAliases("udp-echo")
      .withCommand("sh", "-c", "while true; do nc -u -l -p 9999 -e /bin/cat; done")
      .waitingFor(Wait.forLogMessage(".*", 0))
      .start();

    await using client = await new GenericContainer("alpine:3.19")
      .withBackend(newDockerBackend())
      .withNetwork(network)
      .withCommand("sleep", "60")
      .waitingFor(Wait.forLogMessage(".*", 0))
      .start();

    let reply = "";
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && reply !== "PING") {
      const probe = await client.exec("sh", "-c", "echo -n PING | nc -u -w2 udp-echo 9999");
      reply = probe.stdout.trim();
      if (reply !== "PING") {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    assert.equal(reply, "PING", "expected the docker-native bridge network to carry a UDP datagram between siblings with no NetworkLink");
  });

  itDockerIntegration("host -> container datagram via the mapped UDP port", async () => {
    await using target = await new GenericContainer("alpine:3.19")
      .withBackend(newDockerBackend())
      .withExposedUdpPorts(9999)
      .withCommand("sh", "-c", "nc -u -l -p 9999 > /tmp/got.txt")
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
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && got !== "PING-FROM-HOST") {
      await sendPing();
      await new Promise((r) => setTimeout(r, 500));
      const read = await target.exec("sh", "-c", "cat /tmp/got.txt 2>/dev/null || true");
      got = read.stdout.trim();
    }
    assert.equal(got, "PING-FROM-HOST", "expected a host-sent UDP datagram to reach the guest via the mapped UDP port");
  });
});
