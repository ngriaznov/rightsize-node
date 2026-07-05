import * as net from "node:net";
import { describe, itDockerIntegration, assert } from "../harness.js";
import { DockerBackend } from "../../src/backend-docker/backend.js";
import { DockerClient } from "../../src/backend-docker/client.js";
import { PortBindConflictError } from "../../src/core/errors.js";
import { RunId } from "../../src/core/run-id.js";
import { FreePorts } from "../../src/core/free-ports.js";
import type { ContainerSpec } from "../../src/core/model.js";
import type { SandboxHandle } from "../../src/core/backend.js";

/**
 * Live gates against the real Docker daemon on this machine (`RIGHTSIZE_IT=1`).
 * Every container this file creates carries the `dev.rightsize.runId` label
 * for this process's `RunId.value` and is force-removed in an `afterEach`-
 * style `finally` per test, so a run leaves nothing behind for `docker ps -a`
 * to show regardless of which assertion failed.
 */

let seq = 0;
function nextName(): string {
  seq += 1;
  return `rz-${RunId.value}-it-${seq}`;
}

function baseSpec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: nextName(),
    image: "alpine:latest",
    env: [],
    command: ["sleep", "60"],
    ports: [],
    mounts: [],
    networkId: undefined,
    aliases: [],
    runId: RunId.value,
    memoryLimitMb: undefined,
    ...overrides,
  };
}

async function withContainer<T>(
  backend: DockerBackend,
  spec: ContainerSpec,
  fn: (handle: SandboxHandle) => Promise<T>,
): Promise<T> {
  const handle = await backend.create(spec);
  try {
    await backend.start(handle);
    return await fn(handle);
  } finally {
    await backend.stop(handle).catch(() => {});
    await backend.remove(handle).catch(() => {});
  }
}

/** A zero-byte connect+read probe: resolves true if the peer ever sends data or holds the connection open past a short timeout, false on immediate EOF/refusal. */
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

describe("DockerBackend integration (real daemon)", () => {
  itDockerIntegration("basic lifecycle: create, start, exec, logs, stop, remove", async () => {
    const backend = new DockerBackend(DockerClient.fromEnv());
    const spec = baseSpec({ env: [["FOO", "bar"]] });
    await withContainer(backend, spec, async (handle) => {
      const exec = await backend.exec(handle, ["sh", "-c", "echo $FOO"]);
      assert.equal(exec.exitCode, 0);
      assert.equal(exec.stdout.trim(), "bar");

      const nonZero = await backend.exec(handle, ["sh", "-c", "exit 7"]);
      assert.equal(nonZero.exitCode, 7);

      const logs = await backend.logs(handle);
      assert.equal(typeof logs, "string");
    });
  });

  itDockerIntegration("publishes a TCP port to host loopback", async () => {
    const backend = new DockerBackend(DockerClient.fromEnv());
    const hostPort = await FreePorts.allocate();
    try {
      const spec = baseSpec({
        image: "redis:8.6-alpine",
        command: undefined,
        ports: [{ hostPort, guestPort: 6379 }],
      });
      await withContainer(backend, spec, async () => {
        const deadline = Date.now() + 15_000;
        let reachable = false;
        while (Date.now() < deadline) {
          if (await portIsReachable(hostPort)) {
            reachable = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 300));
        }
        assert.ok(reachable, `expected 127.0.0.1:${hostPort} to become reachable`);
      });
    } finally {
      FreePorts.release(hostPort);
    }
  });

  itDockerIntegration("typed port-conflict error on a host port already bound by another container", async () => {
    const backend = new DockerBackend(DockerClient.fromEnv());
    const hostPort = await FreePorts.allocate();
    const specA = baseSpec({ ports: [{ hostPort, guestPort: 6379 }], image: "redis:8.6-alpine", command: undefined });
    const handleA = await backend.create(specA);
    try {
      await backend.start(handleA);

      const specB = baseSpec({ ports: [{ hostPort, guestPort: 6379 }], image: "redis:8.6-alpine", command: undefined });
      const handleB = await backend.create(specB);
      try {
        let thrown: unknown;
        try {
          await backend.start(handleB);
        } catch (err) {
          thrown = err;
        }
        assert.ok(thrown instanceof PortBindConflictError, `expected PortBindConflictError, got ${String(thrown)}`);
      } finally {
        await backend.stop(handleB).catch(() => {});
        await backend.remove(handleB).catch(() => {});
      }
    } finally {
      await backend.stop(handleA).catch(() => {});
      await backend.remove(handleA).catch(() => {});
      FreePorts.release(hostPort);
    }
  });

  itDockerIntegration("followOutput delivers lines in order and close halts delivery", async () => {
    const backend = new DockerBackend(DockerClient.fromEnv());
    const spec = baseSpec({
      command: ["sh", "-c", "for i in 1 2 3 4 5; do echo line-$i; sleep 0.2; done; sleep 30"],
    });
    const handle = await backend.create(spec);
    try {
      await backend.start(handle);
      const received: string[] = [];
      const follow = await backend.followLogs(handle, (line) => {
        received.push(line);
      });
      const deadline = Date.now() + 10_000;
      while (received.length < 5 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.deepEqual(received, ["line-1", "line-2", "line-3", "line-4", "line-5"]);

      await follow.close();
      const countAfterClose = received.length;
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(received.length, countAfterClose, "close() must halt further delivery");
    } finally {
      await backend.stop(handle).catch(() => {});
      await backend.remove(handle).catch(() => {});
    }
  });

  itDockerIntegration("followOutput delivers a final unterminated line exactly once after the workload exits", async () => {
    const backend = new DockerBackend(DockerClient.fromEnv());
    // No trailing newline on the last echo -n: proves the LineAssembler's
    // flush-once-at-stream-end path is reached through the real daemon's
    // framed log stream, not just the unit-level frames.test.ts fixtures.
    const spec = baseSpec({ command: ["sh", "-c", "echo first; printf 'unterminated-tail'"] });
    const handle = await backend.create(spec);
    try {
      await backend.start(handle);
      const received: string[] = [];
      const follow = await backend.followLogs(handle, (line) => received.push(line));

      const deadline = Date.now() + 10_000;
      while (!received.includes("unterminated-tail") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.deepEqual(received, ["first", "unterminated-tail"]);
      await follow.close();
    } finally {
      await backend.stop(handle).catch(() => {});
      await backend.remove(handle).catch(() => {});
    }
  });

  itDockerIntegration("native-network alias connect: a sibling reaches this container by alias", async () => {
    const backend = new DockerBackend(DockerClient.fromEnv());
    const networkId = `rz-net-it-${RunId.value}`;
    await backend.ensureNetwork(networkId);
    try {
      const serverSpec = baseSpec({
        image: "redis:8.6-alpine",
        command: undefined,
        networkId,
        aliases: ["redis-under-test"],
      });
      const clientSpec = baseSpec({
        image: "alpine:latest",
        command: ["sleep", "60"],
        networkId,
      });
      const serverHandle = await backend.create(serverSpec);
      const clientHandle = await backend.create(clientSpec);
      try {
        await backend.start(serverHandle);
        await backend.start(clientHandle);

        const deadline = Date.now() + 15_000;
        let ok = false;
        while (Date.now() < deadline) {
          const probe = await backend.exec(clientHandle, [
            "sh",
            "-c",
            "nc -z -w1 redis-under-test 6379 && echo REACHABLE || echo UNREACHABLE",
          ]);
          if (probe.stdout.includes("REACHABLE")) {
            ok = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        assert.ok(ok, "expected the alias 'redis-under-test' to be reachable from the sibling container");
      } finally {
        await backend.stop(serverHandle).catch(() => {});
        await backend.remove(serverHandle).catch(() => {});
        await backend.stop(clientHandle).catch(() => {});
        await backend.remove(clientHandle).catch(() => {});
      }
    } finally {
      await backend.removeNetwork(networkId).catch(() => {});
    }
  });

  itDockerIntegration("close() force-removes every container carrying this run's label", async () => {
    const backend = new DockerBackend(DockerClient.fromEnv());
    const spec = baseSpec();
    const handle = await backend.create(spec);
    await backend.start(handle);

    await backend.close();

    const client = DockerClient.fromEnv();
    const inspect = await client.request("GET", `/containers/${handle.id}/json`);
    assert.equal(inspect.status, 404, "close() must have force-removed this run's labeled container");
  });
});
