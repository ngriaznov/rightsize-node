import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import { describe, itIntegration, assert } from "../harness.js";
import { GenericContainer } from "../../src/core/generic-container.js";
import { Wait } from "../../src/core/wait.js";
import { MountableFile } from "../../src/core/mountable-file.js";
import type { SandboxBackend } from "../../src/core/backend.js";
import { IsolationRequiredError } from "../../src/core/errors.js";
import { diagnostics } from "../../src/core/diagnostics.js";
import { MsbCliBackend } from "../../src/backend-msb/backend.js";
import { ensureInstalled } from "../../src/backend-msb/provisioner.js";
import { DockerBackend } from "../../src/backend-docker/backend.js";
import { DockerClient } from "../../src/backend-docker/client.js";
// Side-effect imports: registers both providers with the core registry so
// the sweep test below can drive a real `Backends.reaperReady()` bring-up
// for whichever backend this file is currently parameterized on.
import "../../src/backend-msb/index.js";
import "../../src/backend-docker/index.js";
import { Backends } from "../../src/core/backends.js";
import { cacheDir } from "../../src/core/cache-dir.js";
import { deleteRunRecordFiles, writeRunRecord, appendSandboxName } from "../../src/core/reaper/ledger.js";
import { recordPath, type RunRecord } from "../../src/core/reaper/run-record.js";
import { reuseHash, reuseName } from "../../src/core/reuse/hash.js";
import { readRegistry, removeRegistry } from "../../src/core/reuse/registry.js";

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

  // Runtime copy against an ALREADY-RUNNING container — distinct from
  // withCopyFileToContainer's start-time mount above. Same alpine + sleep
  // workload on both backends; each case proves the destination's parent
  // directory did not pre-exist, so a passing assertion also proves the
  // generic layer's own mkdir -p pre-step actually ran.
  itIntegration("copyFileToContainer copies a host file in; exec cat returns the exact content", async () => {
    await using c = await new GenericContainer("alpine:3.19").withBackend(makeBackend()).withCommand("sleep", "60").start();

    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "rightsize-runtime-copy-in-"));
    const hostFilePath = path.join(hostDir, "runtime.txt");
    fs.writeFileSync(hostFilePath, "runtime-copy-content");

    await c.copyFileToContainer(hostFilePath, "/data/nested/runtime.txt");

    const read = await c.exec("cat", "/data/nested/runtime.txt");
    assert.equal(read.exitCode, 0);
    assert.equal(read.stdout.trim(), "runtime-copy-content");
  });

  itIntegration("copyContentToContainer copies in-memory content in; exec cat returns the exact content", async () => {
    await using c = await new GenericContainer("alpine:3.19").withBackend(makeBackend()).withCommand("sleep", "60").start();

    await c.copyContentToContainer("in-memory-content", "/data/from-memory/greeting.txt");

    const read = await c.exec("cat", "/data/from-memory/greeting.txt");
    assert.equal(read.exitCode, 0);
    assert.equal(read.stdout.trim(), "in-memory-content");
  });

  itIntegration("copyFileToContainer copies a directory in; a nested file is readable at <dst>/<nested>", async () => {
    await using c = await new GenericContainer("alpine:3.19").withBackend(makeBackend()).withCommand("sleep", "60").start();

    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "rightsize-runtime-copy-dir-"));
    fs.mkdirSync(path.join(hostDir, "sub"));
    fs.writeFileSync(path.join(hostDir, "sub", "nested.txt"), "nested-content");

    await c.copyFileToContainer(hostDir, "/data/copied-dir");

    const read = await c.exec("cat", "/data/copied-dir/sub/nested.txt");
    assert.equal(read.exitCode, 0);
    assert.equal(read.stdout.trim(), "nested-content");
  });

  itIntegration("copyFileFromContainer copies a guest file out; host content matches", async () => {
    await using c = await new GenericContainer("alpine:3.19").withBackend(makeBackend()).withCommand("sleep", "60").start();

    const write = await c.exec("sh", "-c", "mkdir -p /out && echo guest-written-content > /out/result.txt");
    assert.equal(write.exitCode, 0);

    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "rightsize-runtime-copy-out-"));
    const hostFilePath = path.join(hostDir, "not-yet-existing", "result.txt");

    await c.copyFileFromContainer("/out/result.txt", hostFilePath);

    const content = fs.readFileSync(hostFilePath, "utf8");
    assert.equal(content.trim(), "guest-written-content");
  });

  itIntegration("copyFileFromContainer copies a guest directory out; a nested host file matches", async () => {
    await using c = await new GenericContainer("alpine:3.19").withBackend(makeBackend()).withCommand("sleep", "60").start();

    const write = await c.exec("sh", "-c", "mkdir -p /outdir/sub && echo nested-guest-content > /outdir/sub/nested.txt");
    assert.equal(write.exitCode, 0);

    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "rightsize-runtime-copy-outdir-"));
    const hostDestPath = path.join(hostDir, "copied-out-dir");

    await c.copyFileFromContainer("/outdir", hostDestPath);

    const content = fs.readFileSync(path.join(hostDestPath, "sub", "nested.txt"), "utf8");
    assert.equal(content.trim(), "nested-guest-content");
  });

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

  // The reaping ledger and sweep only ever address a sandbox by NAME —
  // never a SandboxHandle — because a sweep runs in a different process
  // (possibly a different rightsize language implementation entirely) that
  // never held one. Both backends must honor that contract identically:
  // exercised directly against `create`/`start`/`removeByName` here, below
  // `GenericContainer`, the same way the per-backend IT suites do.
  itIntegration("removeByName stops and removes a sandbox created directly through this backend, identified only by its name", async () => {
    const backend = makeBackend();
    const name = `rz-contract-it-removebyname-${Date.now()}`;
    const spec: import("../../src/core/model.js").ContainerSpec = {
      name,
      image: "alpine:3.19",
      env: [],
      command: ["sleep", "60"],
      ports: [],
      mounts: [],
      networkId: undefined,
      aliases: [],
      runId: "contractit",
      memoryLimitMb: undefined,
      keepAlive: false,
      checkpointRef: undefined,
    };
    const handle = await backend.create(spec);
    await backend.start(handle);

    await backend.removeByName(name);

    // No handle-based lookup exists to assert "gone" generically across
    // both backends here — exec-against-the-dead-handle is the one probe
    // both implementations can answer, but they don't necessarily answer it
    // the same way (docker's HTTP call rejects on a 404; msb's `invoke()`
    // never rejects on a nonzero exit code, only on spawn failure or
    // timeout — see invoke.ts). Either "it threw" or "it resolved with a
    // failing exit code" proves the sandbox is actually gone; a clean
    // exitCode 0 would not.
    let exitCode: number | undefined;
    try {
      exitCode = (await backend.exec(handle, ["true"])).exitCode;
    } catch {
      exitCode = undefined; // threw outright — also proof enough
    }
    assert.ok(exitCode !== 0, "expected exec against a removed sandbox to fail, not silently succeed");
  });

  itIntegration(
    "removeByName: a name that was never created (or already removed) is a silent no-op on both backends",
    async () => {
      const backend = makeBackend();
      await backend.removeByName(`rz-contract-it-never-existed-${Date.now()}`);
    },
  );

  // The init-time sweep (core/reaper/sweep.ts) is only ever exercised
  // end-to-end against the msb backend in test/it/reaper.test.ts — this is
  // the parallel proof for docker, run from the SAME parameterized suite so
  // both backends are held to the identical fabricated-dead-run contract.
  itIntegration(
    "a dead run's real sandbox, fabricated under a fake run id, is reaped by this process's own init-time sweep",
    async () => {
      const scratchBackend = makeBackend();
      const fakeRunId = `deadit${Date.now().toString(16).slice(-10)}`;
      const name = `rz-${fakeRunId}-1`;
      const spec: import("../../src/core/model.js").ContainerSpec = {
        name,
        image: "alpine:3.19",
        env: [],
        command: ["sleep", "60"],
        ports: [],
        mounts: [],
        networkId: undefined,
        aliases: [],
        runId: fakeRunId,
        memoryLimitMb: undefined,
        keepAlive: false,
        checkpointRef: undefined,
      };
      const handle = await scratchBackend.create(spec);
      await scratchBackend.start(handle);

      const dir = cacheDir();
      // A pid essentially guaranteed not to be a live process on any CI
      // runner, paired with a start time far enough in the past that even a
      // pid collision would fail the ±2s liveness match.
      const record: RunRecord =
        BACKEND_NAME === "docker"
          ? { pid: 999_999, startedIso: "2000-01-01T00:00:00.000Z", backend: "docker" }
          : { pid: 999_999, startedIso: "2000-01-01T00:00:00.000Z", backend: "msb", msbPath: await ensureInstalled() };
      await writeRunRecord(dir, fakeRunId, record);
      await appendSandboxName(dir, fakeRunId, name);

      // A fresh reaper bring-up in THIS process: real Backends.active() +
      // Backends.reaperReady() against a genuinely registered provider for
      // this suite's backend (the "internal reset hook" the feature spec
      // allows as an alternative to spawning a whole new process).
      process.env["RIGHTSIZE_BACKEND"] = BACKEND_NAME;
      Backends._resetActiveForTests();
      try {
        await Backends.reaperReady();
      } finally {
        delete process.env["RIGHTSIZE_BACKEND"];
      }

      // No handle-based lookup exists to assert "gone" generically across
      // both backends — the same exec-against-the-dead-handle probe the
      // removeByName contract test above uses is the one both
      // implementations can answer identically.
      const gone = await waitUntil(async () => {
        try {
          const result = await scratchBackend.exec(handle, ["true"]);
          return result.exitCode !== 0;
        } catch {
          return true;
        }
      }, 30_000);
      assert.ok(gone, `expected the init-time sweep to have reaped fabricated dead run '${fakeRunId}'s sandbox within 30s`);

      const ledgerStillThere = fs.existsSync(recordPath(dir, fakeRunId));
      assert.equal(ledgerStillThere, false, "expected the sweep to have deleted the dead run's ledger files");

      if (!gone) {
        // Test-failure-path cleanup only: don't leave a real sandbox running
        // on the CI runner just because this assertion failed.
        await scratchBackend.removeByName(name).catch(() => {});
      }
      await deleteRunRecordFiles(dir, fakeRunId);
    },
  );

  // Reuse (02-reuse.md's own "Testing requirements" names this suite
  // explicitly: gating, hash vector, adopt, stop semantics). The fake-backend
  // unit suite (generic-container.reuse.test.ts) already covers the full
  // state machine in isolation; these entries hold both real backends to the
  // identical observable contract end to end.
  itIntegration(
    "reuse hash: the pinned cross-language contract vector matches on this backend's own runtime",
    async () => {
      const hash = await reuseHash({
        image: "redis:7-alpine",
        env: [["A", "1"], ["B", "2"]],
        command: undefined,
        exposedPorts: [6379],
        memoryLimitMb: undefined,
        copies: [],
      });
      assert.equal(hash, "799aad5a3338ce3d36999c7ff2733d4673c0592d417563f334544693ec1907a5");
      assert.equal(reuseName(hash), "rz-reuse-799aad5a3338");
    },
  );

  itIntegration(
    "reuse gating: withReuse() alone (RIGHTSIZE_REUSE unset) starts an ordinary, non-reused container",
    async () => {
      const savedReuseEnv = process.env["RIGHTSIZE_REUSE"];
      delete process.env["RIGHTSIZE_REUSE"];
      const dir = cacheDir();
      const hash = await reuseHash({
        image: "alpine:3.19",
        env: [],
        command: ["sleep", "60"],
        exposedPorts: [],
        memoryLimitMb: undefined,
        copies: [],
      });
      try {
        const container = new GenericContainer("alpine:3.19")
          .withBackend(makeBackend())
          .withReuse()
          .withCommand("sleep", "60");
        await container.start();
        try {
          assert.equal(container.isRunning, true);
          // The one observable, backend-agnostic proxy for "took the
          // ordinary ephemeral path, not the reuse one": no registry entry
          // gets written — only startReuse()'s adopt-or-create ever writes
          // reuse/<hash>.json.
          const registry = await readRegistry(dir, hash);
          assert.equal(registry.kind, "missing", "expected no reuse registry entry when RIGHTSIZE_REUSE is unset");
        } finally {
          await container.stop();
        }
      } finally {
        if (savedReuseEnv === undefined) {
          delete process.env["RIGHTSIZE_REUSE"];
        } else {
          process.env["RIGHTSIZE_REUSE"] = savedReuseEnv;
        }
      }
    },
  );

  itIntegration(
    "reuse adopt: a second equivalent GenericContainer adopts the first's sandbox — same name, same mapped port, one create",
    async () => {
      const savedReuseEnv = process.env["RIGHTSIZE_REUSE"];
      process.env["RIGHTSIZE_REUSE"] = "true";
      const dir = cacheDir();
      // A unique identity per run: env is part of the reuse hash, so a
      // random nonce here mints a fresh `rz-reuse-<hash12>` name every time
      // this test executes — a sandbox left running by an earlier, failed
      // run of this same test can never collide with this run's own name.
      const nonce = randomBytes(8).toString("hex");
      const hash = await reuseHash({
        image: "python:3.12-alpine",
        env: [["RZ_TEST_NONCE", nonce]],
        command: ["python3", "-m", "http.server", "8000"],
        exposedPorts: [8000],
        memoryLimitMb: undefined,
        copies: [],
      });
      const name = reuseName(hash);

      let first: GenericContainer | undefined;
      let second: GenericContainer | undefined;
      try {
        first = await new GenericContainer("python:3.12-alpine")
          .withBackend(makeBackend())
          .withReuse()
          .withEnv("RZ_TEST_NONCE", nonce)
          .withCommand("python3", "-m", "http.server", "8000")
          .withExposedPorts(8000)
          .waitingFor(Wait.forHttp("/").forPort(8000).withStartupTimeout(30_000))
          .start();

        const afterFirst = await readRegistry(dir, hash);
        assert.equal(afterFirst.kind, "found", "expected the first start() to have written the reuse registry");
        const firstPort = first.getMappedPort(8000);

        second = await new GenericContainer("python:3.12-alpine")
          .withBackend(makeBackend())
          .withReuse()
          .withEnv("RZ_TEST_NONCE", nonce)
          .withCommand("python3", "-m", "http.server", "8000")
          .withExposedPorts(8000)
          .waitingFor(Wait.forHttp("/").forPort(8000).withStartupTimeout(30_000))
          .start();

        assert.equal(second.getMappedPort(8000), firstPort, "expected the adopting instance to report the SAME mapped port");

        const afterSecond = await readRegistry(dir, hash);
        assert.equal(afterSecond.kind, "found");
        if (afterFirst.kind === "found" && afterSecond.kind === "found") {
          // Adoption never rewrites the registry — same createdIso proves
          // the second start() never re-created (and re-registered) it,
          // i.e. backend create was called exactly once across both starts.
          assert.equal(afterSecond.entry.createdIso, afterFirst.entry.createdIso);
          assert.equal(afterSecond.entry.name, name);
        }

        const stillRunning = await makeBackend().findRunning({
          name,
          image: "python:3.12-alpine",
          env: [["RZ_TEST_NONCE", nonce]],
          command: ["python3", "-m", "http.server", "8000"],
          ports: [],
          mounts: [],
          networkId: undefined,
          aliases: [],
          runId: "contractit",
          memoryLimitMb: undefined,
          keepAlive: true,
          checkpointRef: undefined,
        });
        assert.ok(stillRunning !== undefined, "expected the reuse sandbox to be running under its deterministic name");
      } finally {
        // stop() deliberately leaves the sandbox running (that's the
        // feature) — this test removes it itself so CI never leaks it.
        await first?.stop();
        await second?.stop();
        await makeBackend().removeByName(name).catch(() => {});
        await removeRegistry(dir, hash);
        if (savedReuseEnv === undefined) {
          delete process.env["RIGHTSIZE_REUSE"];
        } else {
          process.env["RIGHTSIZE_REUSE"] = savedReuseEnv;
        }
      }
    },
  );

  // The ledger-append claim ("never appended to .sandboxes") is exercised
  // against the real Backends.active() ledger wiring in the fake-backend
  // unit suite (generic-container.reuse.test.ts) — that mechanism is core
  // logic, not backend-specific, so it isn't re-asserted per-backend here.
  // This entry holds the part that IS backend-specific to the contract:
  // the backend-native sandbox is genuinely still running after stop().
  itIntegration(
    "reuse stop semantics: stop() leaves the sandbox genuinely running on the backend-native side",
    async () => {
      const savedReuseEnv = process.env["RIGHTSIZE_REUSE"];
      process.env["RIGHTSIZE_REUSE"] = "true";
      const dir = cacheDir();
      // A unique identity per run — see the "reuse adopt" test above for
      // why: a leftover sandbox from an earlier, failed run of this same
      // test can never collide with this run's own deterministic name.
      const nonce = randomBytes(8).toString("hex");
      const hash = await reuseHash({
        image: "alpine:3.19",
        env: [["RZ_TEST_NONCE", nonce]],
        command: ["sleep", "60"],
        exposedPorts: [],
        memoryLimitMb: undefined,
        copies: [],
      });
      const name = reuseName(hash);

      let container: GenericContainer | undefined;
      try {
        container = await new GenericContainer("alpine:3.19")
          .withBackend(makeBackend())
          .withReuse()
          .withEnv("RZ_TEST_NONCE", nonce)
          .withCommand("sleep", "60")
          .waitingFor(Wait.forLogMessage(".*", 0))
          .start();

        await container.stop();
        assert.equal(container.isRunning, false, "in-process bookkeeping must clear");

        const stillRunning = await makeBackend().findRunning({
          name,
          image: "alpine:3.19",
          env: [["RZ_TEST_NONCE", nonce]],
          command: ["sleep", "60"],
          ports: [],
          mounts: [],
          networkId: undefined,
          aliases: [],
          runId: "contractit",
          memoryLimitMb: undefined,
          keepAlive: true,
          checkpointRef: undefined,
        });
        assert.ok(stillRunning !== undefined, "expected the backend-native sandbox to still be running after stop()");
      } finally {
        await makeBackend().removeByName(name).catch(() => {});
        await removeRegistry(dir, hash);
        if (savedReuseEnv === undefined) {
          delete process.env["RIGHTSIZE_REUSE"];
        } else {
          process.env["RIGHTSIZE_REUSE"] = savedReuseEnv;
        }
      }
    },
  );

  itIntegration(
    `capabilities: hardwareIsolated is ${BACKEND_NAME === "docker" ? "false" : "true"} for this backend; both backends support checkpoint today`,
    async () => {
      const backend = makeBackend();
      if (BACKEND_NAME === "docker") {
        assert.deepEqual(backend.capabilities, { hardwareIsolated: false, checkpoint: true, checkpointRestartsWorkload: false });
      } else {
        assert.deepEqual(backend.capabilities, { hardwareIsolated: true, checkpoint: true, checkpointRestartsWorkload: true });
      }
    },
  );

  itIntegration(
    `requireIsolation: ${BACKEND_NAME === "docker" ? "docker rejects before any create call" : "msb honors it and starts normally"}`,
    async () => {
      if (BACKEND_NAME === "docker") {
        let thrown: unknown;
        try {
          await new GenericContainer("alpine:3.19").withBackend(makeBackend()).withRequireIsolation().withCommand("sleep", "60").start();
        } catch (err) {
          thrown = err;
        }
        assert.ok(thrown instanceof IsolationRequiredError, `expected IsolationRequiredError, got: ${String(thrown)}`);
      } else {
        await using c = await new GenericContainer("alpine:3.19")
          .withBackend(makeBackend())
          .withRequireIsolation()
          .withCommand("sleep", "60")
          .start();
        assert.equal(c.isRunning, true);
      }
    },
  );

  // The full checkpoint→restore round trip (exec a marker file, checkpoint,
  // restore, assert the marker survived, clean up via removeCheckpoint) is
  // backend-specific and lives in docker-backend.test.ts / msb-backend.test.ts
  // — what belongs HERE, identically across both backends, is the gating
  // contract itself: checkpoint() succeeds on a running container on BOTH
  // real backends today, minting the backend-appropriate ref shape and
  // naming itself as the creator.
  itIntegration(
    `checkpoint gating: checkpoint() succeeds on a running container and mints a ${BACKEND_NAME === "docker" ? "rightsize/checkpoint:<12-hex> image ref" : "rz-ckpt-<12-hex> snapshot ref"}`,
    async () => {
      const container = new GenericContainer("alpine:3.19").withBackend(makeBackend()).withCommand("sleep", "60");
      await container.start();
      try {
        const cp = await container.checkpoint();
        assert.equal(cp.backend, BACKEND_NAME);
        assert.equal(cp.spec.image, "alpine:3.19");
        if (BACKEND_NAME === "docker") {
          assert.match(cp.ref, /^rightsize\/checkpoint:[0-9a-f]{12}$/);
        } else {
          assert.match(cp.ref, /^rz-ckpt-[0-9a-f]{12}$/);
          // msb's stop/snapshot/reboot cycle restarts the workload — the
          // container must come back up and answer exec normally.
          const probe = await container.exec("true");
          assert.equal(probe.exitCode, 0, "expected the sandbox to be running again after the checkpoint cycle");
        }
        await makeBackend().removeCheckpoint(cp.ref);
      } finally {
        await container.stop();
      }
    },
  );

  itIntegration("diagnostics() reports a live container's name, image, ports, and a log tail", async () => {
    await using c = await new GenericContainer("alpine:3.19")
      .withBackend(makeBackend())
      .withCommand("sh", "-c", "echo diagnostics-marker; sleep 60")
      .waitingFor(Wait.forLogMessage("diagnostics-marker").withStartupTimeout(30_000))
      .start();

    const report = await diagnostics();
    assert.match(report, /^== rightsize diagnostics: \d+ running container\(s\) ==/);
    assert.ok(report.includes("(alpine:3.19)"));
    assert.ok(report.includes("state: running   host: 127.0.0.1   ports:"));
    assert.ok(report.includes("diagnostics-marker"));
  });
});
