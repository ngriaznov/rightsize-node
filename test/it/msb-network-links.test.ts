import { describe, itMsbIntegration as itIntegration, assert } from "../harness.js";
import { GenericContainer } from "../../src/core/generic-container.js";
import { Network } from "../../src/core/network.js";
import { Wait } from "../../src/core/wait.js";
import { MsbCliBackend } from "../../src/backend-msb/backend.js";
import { ensureInstalled } from "../../src/backend-msb/provisioner.js";

/**
 * End-to-end reachability of the exec-tunnel network-link emulation
 * (`installNetworkLinks`, `ExecTunnel`) against the real `msb 0.6.3` binary —
 * the one thing `msb-backend.test.ts`'s reject-fast cases can't prove, since
 * those never get past validation into an actual byte-pumped connection.
 *
 * Pattern: a server sibling on port 8888 (aliased `configuration-stub`), a
 * consumer sandbox that polls `alias:port` in a retry loop and prints
 * "FETCH-OK" once the fetch through the tunnel actually succeeds.
 */

describe("msb exec-tunnel network-link reachability (real msb 0.6.3 binary)", () => {
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
