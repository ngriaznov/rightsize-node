import { describe, itMsbIntegration as itIntegration, assert } from "../harness.js";
import { GenericContainer } from "../../src/core/generic-container.js";
import { Network } from "../../src/core/network.js";
import { Wait } from "../../src/core/wait.js";
import { MsbCliBackend } from "../../src/backend-msb/backend.js";
import { ensureInstalled } from "../../src/backend-msb/provisioner.js";
import { UnsupportedByBackendError } from "../../src/core/errors.js";

/**
 * End-to-end reachability of the exec-tunnel network-link emulation
 * (`installNetworkLinks`, `ExecTunnel`) against the real `msb 0.6.8` binary —
 * the one thing `msb-backend.test.ts`'s reject-fast cases can't prove, since
 * those never get past validation into an actual byte-pumped connection.
 *
 * Pattern: a server sibling on port 8888 (aliased `configuration-stub`), a
 * consumer sandbox that polls `alias:port` in a retry loop and prints
 * "FETCH-OK" once the fetch through the tunnel actually succeeds.
 */

describe("msb exec-tunnel network-link reachability (the provisioner's pinned msb binary)", () => {
  itIntegration("a consumer sandbox reaches a sibling by alias over the exec-tunnel", async () => {
    await using network = Network.newNetwork();

    await using stub = await new GenericContainer("python:3.12-alpine")
      .withBackend(new MsbCliBackend(ensureInstalled()))
      .withNetwork(network)
      .withNetworkAliases("configuration-stub")
      .withExposedPorts(8888)
      .withCommand("sh", "-c", "echo FETCH-OK > /index.html && python3 -m http.server 8888")
      .waitingFor(Wait.forHttp("/").forPort(8888).withStartupTimeout(30_000))
      .start();

    await using consumer = await new GenericContainer("alpine:3.19")
      .withBackend(new MsbCliBackend(ensureInstalled()))
      .withNetwork(network)
      .withCommand("sleep", "120")
      .start();

    // Retry loop: the tunnel's in-guest `nc -l` listener needs a moment to be
    // installed and respawned after the alias/hosts-file setup, so the first
    // probe or two racing that setup is expected, not a failure.
    const deadline = Date.now() + 20_000;
    let lastOutput = "";
    let ok = false;
    while (Date.now() < deadline) {
      const probe = await consumer.exec(
        "sh",
        "-c",
        "wget -q -O - --timeout=2 http://configuration-stub:8888/ 2>/dev/null || true",
      );
      lastOutput = probe.stdout.trim();
      if (lastOutput === "FETCH-OK") {
        ok = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(ok, `expected the consumer to fetch FETCH-OK through the tunnel; last output: '${lastOutput}'`);
  });
});

/**
 * End-to-end reachability of the UDP-link forwarder (`installNetworkLinks`'s
 * UDP path, the in-guest `UDP_FORWARDER_SCRIPT`) against the real msb
 * binary. Server: `alpine/socat`'s own entrypoint, given only its args (the
 * entrypoint itself is kept) so it echoes every datagram it receives back to
 * its sender. No wait strategy depends on the forwarder's own logging — `nc
 * -u -l` prints nothing on bind — so every container here keeps the default
 * `Wait.forListeningPort()`, vacuously ready for a UDP-only exposure exactly
 * as Phase 1 (UDP port exposure) already established.
 */
describe("msb UDP-link reachability (the provisioner's pinned msb binary)", () => {
  itIntegration("a consumer sandbox reaches a UDP echo sibling through its alias", async () => {
    await using network = Network.newNetwork();

    await using echo = await new GenericContainer("alpine/socat:1.8.1.3")
      .withBackend(new MsbCliBackend(ensureInstalled()))
      .withNetwork(network)
      .withNetworkAliases("udp-echo")
      .withExposedUdpPorts(9153)
      .withCommand("-T5", "UDP4-RECVFROM:9153,fork", "EXEC:cat")
      .start();

    await using consumer = await new GenericContainer("alpine:3.19")
      .withBackend(new MsbCliBackend(ensureInstalled()))
      .withNetwork(network)
      .withCommand("sleep", "3600")
      .start();

    // UDP is lossy and the forwarder may still be starting on the first
    // try — retry a fresh send rather than treat one dropped datagram as
    // failure.
    const payload = `udp-link-${Date.now()}`;
    let echoed = "";
    for (let attempt = 0; attempt < 10; attempt++) {
      const probe = await consumer.exec("sh", "-c", `echo ${payload} | nc -u -w2 udp-echo 9153`);
      echoed = probe.stdout.trim();
      if (echoed === payload) {
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(echoed, payload, `expected the consumer's datagram to echo back through the forwarder; last output: '${echoed}'`);
  });

  itIntegration("three distinct clients each get their own payload back — proves the forwarder serves more than one client", async () => {
    await using network = Network.newNetwork();

    await using echo = await new GenericContainer("alpine/socat:1.8.1.3")
      .withBackend(new MsbCliBackend(ensureInstalled()))
      .withNetwork(network)
      .withNetworkAliases("udp-echo-multi")
      .withExposedUdpPorts(9153)
      .withCommand("-T5", "UDP4-RECVFROM:9153,fork", "EXEC:cat")
      .start();

    await using consumer = await new GenericContainer("alpine:3.19")
      .withBackend(new MsbCliBackend(ensureInstalled()))
      .withNetwork(network)
      .withCommand("sleep", "3600")
      .start();

    for (let client = 0; client < 3; client++) {
      const payload = `udp-client-${client}-${Date.now()}`;
      let echoed = "";
      for (let attempt = 0; attempt < 10; attempt++) {
        const probe = await consumer.exec("sh", "-c", `echo ${payload} | nc -u -w2 udp-echo-multi 9153`);
        echoed = probe.stdout.trim();
        if (echoed === payload) {
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.equal(echoed, payload, `client ${client}: expected its own payload back, distinct from the others; last output: '${echoed}'`);
    }
  });

  /**
   * A UDP link has to survive a checkpoint of the consumer, not just its own
   * installation. msb's checkpoint reboots the consumer through `msb
   * restore`, and `restore()` builds its argv fresh from
   * `spec.hostUdpEgressPorts` rather than carrying over whatever
   * `--net-rule`/`--net-default` policy the ORIGINAL boot granted — see
   * `MsbCommands.restore`'s own doc — so the restore argv has to re-grant the
   * host UDP port itself, or the rebooted guest has no route out for the
   * forwarder to use. The reboot also wipes `/tmp`, which is where the
   * forwarder script and its readiness log live (see `installUdpLink`), so
   * `GenericContainer.checkpoint`'s link replay has to reinstall the
   * forwarder from scratch, not just find one still running.
   */
  itIntegration("a checkpointed consumer keeps its UDP link", async () => {
    await using network = Network.newNetwork();

    await using echo = await new GenericContainer("alpine/socat:1.8.1.3")
      .withBackend(new MsbCliBackend(ensureInstalled()))
      .withNetwork(network)
      .withNetworkAliases("udp-echo-ckpt")
      .withExposedUdpPorts(9153)
      .withCommand("-T5", "UDP4-RECVFROM:9153,fork", "EXEC:cat")
      .start();

    await using consumer = await new GenericContainer("alpine:3.19")
      .withBackend(new MsbCliBackend(ensureInstalled()))
      .withNetwork(network)
      .withCommand("sleep", "3600")
      .start();

    // Same lossy-UDP resend loop the sibling tests above use, factored out
    // since this test needs it twice: once before the checkpoint, once
    // after.
    const udpEchoRoundTrip = async (payload: string): Promise<string> => {
      let echoed = "";
      for (let attempt = 0; attempt < 10; attempt++) {
        const probe = await consumer.exec("sh", "-c", `echo ${payload} | nc -u -w2 udp-echo-ckpt 9153`);
        echoed = probe.stdout.trim();
        if (echoed === payload) {
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return echoed;
    };

    const nonce = Date.now();
    const before = await udpEchoRoundTrip(`before-${nonce}`);
    assert.equal(before, `before-${nonce}`, "expected the udp link to work before the checkpoint");

    await consumer.checkpoint();

    const after = await udpEchoRoundTrip(`after-${nonce}`);
    assert.equal(after, `after-${nonce}`, "expected the udp link to work again after the checkpoint reboot");
  });

  itIntegration("a consumer image without a capable nc fails start with the typed unsupported error", async () => {
    await using network = Network.newNetwork();

    await using echo = await new GenericContainer("alpine/socat:1.8.1.3")
      .withBackend(new MsbCliBackend(ensureInstalled()))
      .withNetwork(network)
      .withNetworkAliases("udp-echo-nonc")
      .withExposedUdpPorts(9153)
      .withCommand("-T5", "UDP4-RECVFROM:9153,fork", "EXEC:cat")
      .start();

    // debian:12-slim has neither nc nor busybox (the same image
    // msb-backend.test.ts's TCP no-nc case uses) — the generic nc probe
    // every link requires, TCP or UDP alike, rejects it before the
    // UDP-specific probe is ever reached.
    let thrown: unknown;
    try {
      await new GenericContainer("debian:12-slim")
        .withBackend(new MsbCliBackend(ensureInstalled()))
        .withNetwork(network)
        .withCommand("sleep", "60")
        .start();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof UnsupportedByBackendError, `expected UnsupportedByBackendError, got: ${String(thrown)}`);
  });
});
