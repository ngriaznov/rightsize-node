import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { describe, itIntegration, assert } from "../harness.js";
import { GenericContainer } from "../../src/core/generic-container.js";
import { Wait } from "../../src/core/wait.js";
import { MountableFile } from "../../src/core/mountable-file.js";
import type { SandboxBackend } from "../../src/core/backend.js";
import { MsbCliBackend } from "../../src/backend-msb/backend.js";
import { ensureInstalled } from "../../src/backend-msb/provisioner.js";
import { DockerBackend } from "../../src/backend-docker/backend.js";
import { DockerClient } from "../../src/backend-docker/client.js";

/**
 * The behavioral contract every backend must honor, executed against BOTH
 * backends from the SAME test bodies — this file is the referee for backend
 * equivalence, not a per-backend smoke test. Selected via `RIGHTSIZE_BACKEND`
 * (`microsandbox` or `docker`); the four-combination gate is
 * `{node,bun} x {microsandbox,docker}` all green on this machine.
 *
 * Images used throughout: `alpine:3.19` and `python:3.12-alpine` only —
 * two small images keep the suite's pull cost minimal.
 */

const BACKEND_NAME = process.env["RIGHTSIZE_BACKEND"] ?? "microsandbox";

// msb does not enforce `:ro` mounts in-guest (advisory only); docker
// does. The contract test for the default read-only mount parameterizes on
// this rather than asserting one universal outcome.
const readOnlyMountEnforced = BACKEND_NAME === "docker";

function makeBackend(): SandboxBackend {
  if (BACKEND_NAME === "docker") {
    return new DockerBackend(DockerClient.fromEnv());
  }
  if (BACKEND_NAME === "microsandbox") {
    return new MsbCliBackend(ensureInstalled());
  }
  throw new Error(`unknown RIGHTSIZE_BACKEND '${BACKEND_NAME}' — expected 'microsandbox' or 'docker'`);
}

/** A zero-byte connect+read probe: resolves true if the peer sends data or holds the connection open, false on immediate EOF/refusal. */
function portIsReachable(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolvePort) => {
    const socket = net.connect(port, "127.0.0.1");
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolvePort(value);
    };
    socket.once("connect", () => {
      socket.setTimeout(timeoutMs);
      socket.once("data", () => finish(true));
      socket.once("timeout", () => finish(true));
      socket.once("end", () => finish(false));
    });
    socket.once("error", () => finish(false));
  });
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number, pollMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

describe(`backend contract suite (${BACKEND_NAME})`, () => {
  itIntegration("publishes a TCP port to host loopback", async () => {
    await using c = await new GenericContainer("python:3.12-alpine")
      .withBackend(makeBackend())
      .withCommand("python3", "-m", "http.server", "8000")
      .withExposedPorts(8000)
      .waitingFor(Wait.forHttp("/").forPort(8000).withStartupTimeout(30_000))
      .start();

    const port = c.getMappedPort(8000);
    assert.ok(await portIsReachable(port), `expected 127.0.0.1:${port} to be reachable once ready`);
  });

  itIntegration("env vars are visible to the workload", async () => {
    await using c = await new GenericContainer("alpine:3.19")
      .withBackend(makeBackend())
      .withEnv("CONTRACT_VAR", "hello-contract")
      .withCommand("sleep", "60")
      .start();

    const result = await c.exec("sh", "-c", "echo $CONTRACT_VAR");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "hello-contract");
  });

  itIntegration("later withEnv wins for a repeated key (last-wins)", async () => {
    await using c = await new GenericContainer("alpine:3.19")
      .withBackend(makeBackend())
      .withEnv("CONTRACT_VAR", "first")
      .withEnv("CONTRACT_VAR", "second")
      .withCommand("sleep", "60")
      .start();

    const result = await c.exec("sh", "-c", "echo $CONTRACT_VAR");
    assert.equal(result.stdout.trim(), "second");
  });

  itIntegration("exec returns real exit codes and stderr", async () => {
    await using c = await new GenericContainer("alpine:3.19")
      .withBackend(makeBackend())
      .withCommand("sleep", "60")
      .start();

    const ok = await c.exec("sh", "-c", "echo oops >&2; exit 7");
    assert.equal(ok.exitCode, 7);
    assert.ok(ok.stderr.includes("oops"), `expected stderr to include 'oops', got: ${ok.stderr}`);
  });

  itIntegration("logs capture workload stdout; forLogMessage waits on a boot marker", async () => {
    await using c = await new GenericContainer("alpine:3.19")
      .withBackend(makeBackend())
      .withCommand("sh", "-c", "echo BOOT-MARKER; sleep 60")
      .waitingFor(Wait.forLogMessage("BOOT-MARKER").withStartupTimeout(30_000))
      .start();

    const logs = await c.logs();
    assert.ok(logs.includes("BOOT-MARKER"), `expected logs to include BOOT-MARKER, got: ${logs}`);
  });

  itIntegration("logs() preserves a genuinely-empty interior line as real output", async () => {
    await using c = await new GenericContainer("alpine:3.19")
      .withBackend(makeBackend())
      .withCommand("sh", "-c", "echo before; echo ''; echo after; sleep 60")
      .waitingFor(Wait.forLogMessage("after").withStartupTimeout(30_000))
      .start();

    const logs = await c.logs();
    // Trailing newline is a stream-end artifact, not a line — trim exactly
    // one before splitting so it isn't mistaken for a manufactured empty.
    const lines = (logs.endsWith("\n") ? logs.slice(0, -1) : logs).split("\n");
    const beforeIdx = lines.indexOf("before");
    assert.ok(beforeIdx !== -1, `expected 'before' in logs, got: ${JSON.stringify(lines)}`);
    assert.deepEqual(lines.slice(beforeIdx, beforeIdx + 3), ["before", "", "after"]);
  });

  itIntegration("stop terminates the container; exec after stop is rejected by the guard", async () => {
    const container = new GenericContainer("alpine:3.19").withBackend(makeBackend()).withCommand("sleep", "60");
    await container.start();
    assert.equal(container.isRunning, true);

    await container.stop();
    assert.equal(container.isRunning, false);
    await assert.rejects(() => container.exec("echo", "should-not-run"));
  });

  itIntegration("withCopyFileToContainer round-trips a bundled resource and a host path", async () => {
    const bundled = MountableFile.forResource("../fixtures/contract-bundled.txt", import.meta.url);

    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "rightsize-contract-"));
    const hostFilePath = path.join(hostDir, "contract-host.txt");
    fs.writeFileSync(hostFilePath, "from-host-path\n");
    const hostFile = MountableFile.forHostPath(hostFilePath);

    await using c = await new GenericContainer("alpine:3.19")
      .withBackend(makeBackend())
      .withCopyFileToContainer(bundled, "/data/bundled.txt")
      .withCopyFileToContainer(hostFile, "/other/host.txt")
      .withCommand("sleep", "60")
      .start();

    const bundledRead = await c.exec("cat", "/data/bundled.txt");
    assert.equal(bundledRead.exitCode, 0);
    assert.equal(bundledRead.stdout.trim(), "from-bundled-resource");

    const hostRead = await c.exec("cat", "/other/host.txt");
    assert.equal(hostRead.exitCode, 0);
    assert.equal(hostRead.stdout.trim(), "from-host-path");
  });

  itIntegration(
    `default read-only mount ${readOnlyMountEnforced ? "rejects" : "does not reject"} an in-guest write`,
    async () => {
      const bundled = MountableFile.forResource("../fixtures/contract-bundled.txt", import.meta.url);

      await using c = await new GenericContainer("alpine:3.19")
        .withBackend(makeBackend())
        .withCopyFileToContainer(bundled, "/data/bundled.txt")
        .withCommand("sleep", "60")
        .start();

      const write = await c.exec("sh", "-c", "echo mutated > /data/bundled.txt");
      if (readOnlyMountEnforced) {
        assert.ok(write.exitCode !== 0, "expected the write to a read-only mount to fail on this backend");
      } else {
        // msb's documented non-enforcement (advisory-only `:ro`): the
        // write succeeds in-guest. This branch exists to document the
        // divergence with an executed assertion, not to skip the case.
        assert.equal(write.exitCode, 0, "expected msb's advisory-only read-only mount to permit the write");
      }
    },
  );

  itIntegration("followOutput streams lines in order and close halts delivery", async () => {
    // This case previously skipped on Windows against microsandbox: the old
    // `msb logs -f` pipe-based follow never relayed a slow trickle of lines
    // there (confirmed against the real binary — a 60s window still delivered
    // only "line-1"). followOutput on Windows no longer touches that channel:
    // it polls non-follow `msb logs` snapshots, which carry trickled lines
    // the whole time, so this case now runs everywhere.
    await using c = await new GenericContainer("alpine:3.19")
      .withBackend(makeBackend())
      .withCommand("sh", "-c", "for i in 1 2 3 4 5; do echo line-$i; sleep 0.3; done; sleep 60")
      .start();

    const received: string[] = [];
    const follow = await c.followOutput((line) => received.push(line));

    const gotAllFive = await waitUntil(() => received.length >= 5, 15_000);
    assert.ok(gotAllFive, `expected 5 lines, got: ${JSON.stringify(received)}`);
    assert.deepEqual(received.slice(0, 5), ["line-1", "line-2", "line-3", "line-4", "line-5"]);

    await follow.close();
    const countAfterClose = received.length;
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(received.length, countAfterClose, "close() must halt further delivery");
  });

  itIntegration("followOutput delivers a genuinely-empty interior line as real output on both backends", async () => {
    await using c = await new GenericContainer("alpine:3.19")
      .withBackend(makeBackend())
      .withCommand("sh", "-c", "echo before; echo ''; echo after; sleep 60")
      .start();

    const received: string[] = [];
    const follow = await c.followOutput((line) => received.push(line));

    const gotAll = await waitUntil(() => received.length >= 3, 15_000);
    assert.ok(gotAll, `expected 3 lines including a blank one, got: ${JSON.stringify(received)}`);
    assert.deepEqual(received.slice(0, 3), ["before", "", "after"]);

    await follow.close();
  });

  itIntegration(
    "followOutput delivers a final unterminated line after the workload exits, exactly once",
    async () => {
      // This case previously skipped on Windows against microsandbox: the
      // old `msb logs -f` pipe-based follow never observed a trailing
      // unterminated line there on either the live stream or the watchdog's
      // replay fetch. followOutput on Windows no longer touches that channel:
      // it polls non-follow `msb logs` snapshots, whose terminal fetch after
      // the sandbox stops does surface a trailing unterminated line, so this
      // case now runs everywhere.
      //
      // A brief sleep BEFORE the two lines gives msb's readiness poll (every
      // 300ms against `msb ls`) a window to observe the sandbox as "Running"
      // before the workload exits — msb's start() throws if the attached
      // process exits before that's ever seen (readiness comes from
      // `msb ls`, never from the workload's own exit). After that window the
      // process genuinely exits, so both backends' flush-on-exit path (the
      // docker LineAssembler's end-of-stream flush, the msb watchdog's
      // quiesce-then-replay) is exercised for real, not sidestepped by a
      // container that's kept alive indefinitely.
      const container = new GenericContainer("alpine:3.19")
        .withBackend(makeBackend())
        .withCommand("sh", "-c", "sleep 1; echo first; printf 'unterminated-tail'");
      await container.start();

      const received: string[] = [];
      const follow = await container.followOutput((line) => received.push(line));

      const gotTail = await waitUntil(() => received.includes("unterminated-tail"), 15_000);
      assert.ok(gotTail, `expected the unterminated tail line, got: ${JSON.stringify(received)}`);

      // Give any duplicate-delivery bug a chance to manifest before asserting
      // the final shape: a regression here would show up as a repeated
      // "unterminated-tail" entry, not just a missing one.
      await new Promise((r) => setTimeout(r, 800));
      assert.deepEqual(received, ["first", "unterminated-tail"]);

      await follow.close();
      await container.stop();
    },
  );

  itIntegration(
    "await using disposal makes the published port genuinely unreachable after scope exit",
    async () => {
      let port: number;
      {
        await using c = await new GenericContainer("python:3.12-alpine")
          .withBackend(makeBackend())
          .withCommand("python3", "-m", "http.server", "8000")
          .withExposedPorts(8000)
          .waitingFor(Wait.forHttp("/").forPort(8000).withStartupTimeout(30_000))
          .start();
        port = c.getMappedPort(8000);
        assert.ok(await portIsReachable(port), "expected the port to be reachable inside the using-scope");
      }
      // Scope exited: [Symbol.asyncDispose] already ran to completion.
      const stillReachable = await portIsReachable(port, 500);
      assert.equal(stillReachable, false, "expected the port to be unreachable after await-using disposal");
    },
  );
});
