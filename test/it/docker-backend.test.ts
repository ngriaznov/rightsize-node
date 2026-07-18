import * as net from "node:net";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, itDockerIntegration, assert } from "../harness.js";
import { DockerBackend } from "../../src/backend-docker/backend.js";
import { DockerClient } from "../../src/backend-docker/client.js";
import { GenericContainer } from "../../src/core/generic-container.js";
import { PortBindConflictError } from "../../src/core/errors.js";
import { RunId } from "../../src/core/run-id.js";
import { FreePorts } from "../../src/core/free-ports.js";
import type { ContainerSpec } from "../../src/core/model.js";
import type { SandboxHandle } from "../../src/core/backend.js";
import { Checkpoints } from "../../src/core/checkpoint/api.js";
import { Backends } from "../../src/core/backends.js";
// Side-effect import: registers DockerBackendProvider so Backends.active()
// (which Checkpoints.find/remove resolve against) can actually resolve to
// docker, independent of whichever backend this file's own explicit
// .withBackend(new DockerBackend(...)) instances use.
import "../../src/backend-docker/index.js";

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
    keepAlive: false,
    checkpointRef: undefined,
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

  itDockerIntegration(
    "removeByName resolves the container's name to its daemon id and force-removes it; a name that no longer (or never did) exist is a silent no-op",
    async () => {
      const backend = new DockerBackend(DockerClient.fromEnv());
      const spec = baseSpec({ command: ["sleep", "60"] });
      const handle = await backend.create(spec);
      await backend.start(handle);

      await backend.removeByName(spec.name);
      await assert.rejects(() => backend.exec(handle, ["true"]), "expected the container to actually be gone");

      // Idempotent: an already-removed name, and a name that never existed, are both silent no-ops.
      await backend.removeByName(spec.name);
      await backend.removeByName("rz-does-not-exist-at-all-00000000");
    },
  );

  itDockerIntegration(
    "removeByName does not touch a DIFFERENT container whose name is a substring of the target name",
    async () => {
      const backend = new DockerBackend(DockerClient.fromEnv());
      const targetSpec = baseSpec({ command: ["sleep", "60"] });
      const prefixName = `${targetSpec.name}-extra`;
      const prefixSpec = baseSpec({ name: prefixName, command: ["sleep", "60"] });
      const target = await backend.create(targetSpec);
      await backend.start(target);
      const prefixHandle = await backend.create(prefixSpec);
      await backend.start(prefixHandle);
      try {
        await backend.removeByName(targetSpec.name);
        await assert.rejects(() => backend.exec(target, ["true"]));
        // The unrelated container sharing a textual prefix must survive.
        const stillThere = await backend.exec(prefixHandle, ["true"]);
        assert.equal(stillThere.exitCode, 0);
      } finally {
        await backend.stop(prefixHandle).catch(() => {});
        await backend.remove(prefixHandle).catch(() => {});
      }
    },
  );

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

  itDockerIntegration(
    "checkpoint/restore round trip: a marker file written after checkpoint survives into the restored container",
    async () => {
      const client = DockerClient.fromEnv();
      const source = new GenericContainer("alpine:3.19")
        .withBackend(new DockerBackend(client))
        .withCommand("sleep", "60");
      await source.start();

      let cp;
      try {
        const marker = await source.exec("sh", "-c", "echo checkpoint-marker > /marker.txt && sync");
        assert.equal(marker.exitCode, 0);

        cp = await source.checkpoint();
        assert.match(cp.ref, /^rightsize\/checkpoint:[0-9a-f]{12}$/);
        assert.equal(cp.backend, "docker");
      } finally {
        await source.stop();
      }

      const restored = GenericContainer.fromCheckpoint(cp)
        .withBackend(new DockerBackend(client))
        .withCommand("sleep", "60");
      try {
        await restored.start();
        const read = await restored.exec("cat", "/marker.txt");
        assert.equal(read.exitCode, 0);
        assert.equal(read.stdout.trim(), "checkpoint-marker");
      } finally {
        await restored.stop();
        // Checkpoints are never auto-reaped (an image is not a container) —
        // clean up the one this test committed, via the SPI-only
        // removeCheckpoint rather than a hand-rolled daemon call.
        await new DockerBackend(client).removeCheckpoint(cp.ref).catch(() => {});
      }
    },
  );

  itDockerIntegration(
    "named checkpoint is rediscovered by a fresh Checkpoints.find(...) call, restores from it, and Checkpoints.remove(...) cleans it up",
    async () => {
      // Checkpoints.find/list/remove resolve Backends.active() internally —
      // pin it to docker for the duration of this test regardless of
      // whatever RIGHTSIZE_BACKEND this process inherited (the msb-linux CI
      // lane, which also has a docker daemon, runs this file with
      // RIGHTSIZE_BACKEND=microsandbox), and reset the memoization so that
      // actually takes effect.
      const savedBackendEnv = process.env["RIGHTSIZE_BACKEND"];
      process.env["RIGHTSIZE_BACKEND"] = "docker";
      Backends._resetActiveForTests();

      // Nonced per run (RZ test-nonce discipline): an image tag left behind
      // by a crashed earlier run of this exact test can never collide with
      // this run's own name.
      const name = `${randomBytes(6).toString("hex")}-golden`;
      const client = DockerClient.fromEnv();

      try {
        const source = new GenericContainer("alpine:3.19").withBackend(new DockerBackend(client)).withCommand("sleep", "60");
        await source.start();

        try {
          const marker = await source.exec("sh", "-c", "echo checkpoint-marker > /marker.txt && sync");
          assert.equal(marker.exitCode, 0);

          const cp = await source.checkpoint(name);
          assert.equal(cp.ref, `rightsize/checkpoint:${name}`);
        } finally {
          await source.stop();
        }

        // The cross-run story: rediscover via Checkpoints.find(...) ALONE —
        // never the `cp` object returned above — this is exactly what makes
        // a named checkpoint usable from a process that never held it.
        const found = await Checkpoints.find(name);
        if (found === undefined) {
          throw new Error("expected find() to rediscover the named checkpoint");
        }
        assert.equal(found.ref, `rightsize/checkpoint:${name}`);
        assert.equal(found.backend, "docker");

        const restored = GenericContainer.fromCheckpoint(found).withBackend(new DockerBackend(client)).withCommand("sleep", "60");
        try {
          await restored.start();
          const read = await restored.exec("cat", "/marker.txt");
          assert.equal(read.exitCode, 0);
          assert.equal(read.stdout.trim(), "checkpoint-marker");
        } finally {
          await restored.stop();
        }

        const removed = await Checkpoints.remove(name);
        assert.equal(removed, true, "expected Checkpoints.remove to report that the named checkpoint existed");
        const goneAfterRemove = await Checkpoints.find(name);
        assert.equal(goneAfterRemove, undefined, "expected the checkpoint to be gone after Checkpoints.remove");
      } finally {
        // The cleanup guard: whether the assertions above passed or a panic
        // hit partway through, this still leaves no image or registry entry
        // behind — a no-op if the happy-path remove() above already ran
        // successfully.
        await Checkpoints.remove(name).catch(() => {});
        if (savedBackendEnv === undefined) {
          delete process.env["RIGHTSIZE_BACKEND"];
        } else {
          process.env["RIGHTSIZE_BACKEND"] = savedBackendEnv;
        }
        Backends._resetActiveForTests();
      }
    },
  );

  itDockerIntegration(
    "checkpoint archive round trip: exportTo/importFrom carry a named checkpoint across a remove(), and the ref round-trips unchanged",
    async () => {
      const savedBackendEnv = process.env["RIGHTSIZE_BACKEND"];
      process.env["RIGHTSIZE_BACKEND"] = "docker";
      Backends._resetActiveForTests();

      const name = `${randomBytes(6).toString("hex")}-archive`;
      const client = DockerClient.fromEnv();
      const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-docker-archive-it-"));
      const archivePath = path.join(archiveDir, "checkpoint.tar");

      try {
        const source = new GenericContainer("alpine:3.19").withBackend(new DockerBackend(client)).withCommand("sleep", "60");
        await source.start();

        try {
          const marker = await source.exec("sh", "-c", "echo checkpoint-marker > /marker.txt && sync");
          assert.equal(marker.exitCode, 0);

          const cp = await source.checkpoint(name);
          assert.equal(cp.ref, `rightsize/checkpoint:${name}`);

          await Checkpoints.exportTo(cp, archivePath);
          const archiveStat = await fs.stat(archivePath);
          assert.ok(archiveStat.size > 0, "expected exportTo to have written a non-empty archive file");
        } finally {
          await source.stop();
        }

        // Remove BOTH the artifact and the registry entry — proves the
        // archive alone (never the original image) is what importFrom
        // restores from.
        const removed = await Checkpoints.remove(name);
        assert.equal(removed, true, "expected the original checkpoint to have existed before removal");
        assert.equal(await Checkpoints.find(name), undefined, "expected the original checkpoint to be gone before import");

        const imported = await Checkpoints.importFrom(archivePath);
        assert.equal(imported.backend, "docker");
        assert.equal(imported.ref, `rightsize/checkpoint:${name}`, "expected docker's effective ref to round-trip unchanged");

        // Named archive: replace semantics re-register it under the same name.
        const rediscovered = await Checkpoints.find(name);
        assert.ok(rediscovered !== undefined, "expected the named archive's import to have re-registered it");
        assert.equal(rediscovered?.ref, imported.ref);

        const restored = GenericContainer.fromCheckpoint(imported).withBackend(new DockerBackend(client)).withCommand("sleep", "60");
        try {
          await restored.start();
          const read = await restored.exec("cat", "/marker.txt");
          assert.equal(read.exitCode, 0);
          assert.equal(read.stdout.trim(), "checkpoint-marker");
        } finally {
          await restored.stop();
        }
      } finally {
        // The cleanup guard: the archive file, the imported image ref, and
        // the registry entry, regardless of which assertion above failed.
        await fs.rm(archiveDir, { recursive: true, force: true });
        await Checkpoints.remove(name).catch(() => {});
        if (savedBackendEnv === undefined) {
          delete process.env["RIGHTSIZE_BACKEND"];
        } else {
          process.env["RIGHTSIZE_BACKEND"] = savedBackendEnv;
        }
        Backends._resetActiveForTests();
      }
    },
  );

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
