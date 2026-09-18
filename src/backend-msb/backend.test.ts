import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, assert, after, beforeEach } from "../../test/harness.js";
import { MsbCliBackend } from "./backend.js";
import { BackendError, TmpfsRootCheckpointError, CheckpointWorkloadCommandMissingError } from "../core/errors.js";
import type { ContainerSpec } from "../core/model.js";
import { GenericContainer } from "../core/generic-container.js";
import {
  readCheckpointRegistry,
  writeCheckpointRegistryAtomic,
  toCheckpointRegistrySpec,
  fromCheckpointRegistryEntry,
  type CheckpointRegistryEntry,
} from "../core/checkpoint/registry.js";
import { cacheDir } from "../core/cache-dir.js";
import type { WaitStrategy } from "../core/wait.js";
import { ensureReaperInitialized, trackSandbox, _resetReaperForTests } from "../core/reaper/init.js";
import { readSandboxNames } from "../core/reaper/ledger.js";
import { invoke } from "./invoke.js";
import type { RestoreBrokerLauncher } from "./restore-broker.js";

/** A no-op readiness check — this suite never runs a real workload, only the fake-msb double. */
function instantReady(): WaitStrategy {
  return {
    waitUntilReady: async () => {},
    withStartupTimeout(): WaitStrategy {
      return this;
    },
  };
}

// Resolved relative to THIS module's own compiled location (dist-test or
// src, depending on which runtime is executing it), never process.cwd() —
// node:url's fileURLToPath, not new URL().pathname, per house style.
const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FAKE_MSB = path.join(FIXTURE_DIR, "fixtures", "fake-msb-wrapper.sh");

function baseSpec(name: string, overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name,
    image: "fake:latest",
    env: [],
    command: undefined,
    ports: [],
    mounts: [],
    networkId: undefined,
    aliases: [],
    runId: "testrun1",
    memoryLimitMb: undefined,
    keepAlive: false,
    checkpointRef: undefined,
    diskLimitMb: undefined,
    tmpfsRootMb: undefined,
    networkDisabled: false,
    ...overrides,
  };
}

describe("MsbCliBackend against a scripted fake msb binary", () => {
  let statePath: string;
  let backend: MsbCliBackend;

  beforeEach(async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-msb-backend-test-"));
    statePath = path.join(tmpDir, "state.json");
    await fs.writeFile(statePath, JSON.stringify({ sandboxes: {} }));
    process.env["RIGHTSIZE_FAKE_MSB_STATE"] = statePath;
    // importCheckpoint derives its `--dest` from cacheDir() — pin it to this
    // test's own temp dir so an imported artifact's fake files land there
    // instead of the real host's checkpoints cache.
    process.env["RIGHTSIZE_CACHE_DIR"] = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-msb-backend-cache-test-"));
    backend = new MsbCliBackend(Promise.resolve(FAKE_MSB));
  });

  after(async () => {
    delete process.env["RIGHTSIZE_FAKE_MSB_STATE"];
    delete process.env["RIGHTSIZE_CACHE_DIR"];
  });

  // fake-msb-wrapper.sh is a POSIX `sh` script run directly as the "msb
  // binary" via spawn(path, args) — there is no shebang-based interpreter
  // dispatch on a bare Windows runner, so spawn() there fails structurally
  // (EFTYPE: not a recognized executable), independent of anything
  // MsbCliBackend itself does. The real msb-Windows attached-mode/exec/
  // follow-logs behavior is covered by the msb backend's own IT suite
  // (test/it/contract.test.ts, test/it/msb-backend.test.ts) against the
  // real msb.exe, not by this file's shell-script double.
  function skipOnWindows(): boolean {
    return process.platform === "win32";
  }

  it("start reaches Running by polling ls, then stop and remove tear it down", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-1");
    const handle = await backend.create(spec);
    await backend.start(handle);

    const logs = await backend.logs(handle);
    assert.match(logs, /ready/);

    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("removeByName stops and removes a sandbox identified only by its name, not a handle", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-byname");
    const handle = await backend.create(spec);
    await backend.start(handle);

    await backend.removeByName(handle.id);

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as { sandboxes: Record<string, unknown> };
    assert.equal(handle.id in state.sandboxes, false, "expected removeByName to have deleted the sandbox from state");
  });

  it("removeByName on a name that was never created is a silent no-op", async () => {
    if (skipOnWindows()) {
      return;
    }
    await backend.removeByName("rz-testrun1-never-existed");
  });

  it("findRunning returns a handle carrying the caller's own spec when the name is Running", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-findrunning");
    const handle = await backend.create(spec);
    await backend.start(handle);

    const found = await backend.findRunning(spec);
    assert.ok(found !== undefined, "expected findRunning to report the sandbox as running");
    assert.equal(found?.id, spec.name);
    assert.equal(found?.spec, spec, "the returned handle must embed the caller's spec verbatim, not a re-derived one");

    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("findRunning returns undefined for a name that was never created", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-findrunning-never-existed");
    const found = await backend.findRunning(spec);
    assert.equal(found, undefined);
  });

  it("reaperKillCommand names the provisioned msb binary's stop/rm subcommands, with an empty removeNetwork prefix", async () => {
    const command = await backend.reaperKillCommand();
    assert.deepEqual(command, { stop: [FAKE_MSB, "stop"], remove: [FAKE_MSB, "rm"], removeNetwork: [] });
  });

  it("removeByName retries once when a stop/rm step hits msb's state-database error, same classifier as the boot path", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-removedbfail");
    const handle = await backend.create(spec);
    await backend.start(handle);

    // Only the NEXT stop/rm invocation fails once — removeByName makes two
    // invocations (stop, then rm), so this proves the retry lands on
    // whichever one hits it (the stop step here) without over-retrying the rm step.
    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failRemovesWithStateDbError = 1;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    await backend.removeByName(handle.id);

    const after = JSON.parse(await fs.readFile(statePath, "utf8")) as { sandboxes: Record<string, unknown> };
    assert.equal(handle.id in after.sandboxes, false, "expected the retried stop+the rm step to have removed the sandbox");
  });

  it("close() removes every started sandbox except keepAlive ones (addendum item 6, own-run cleanup)", async () => {
    if (skipOnWindows()) {
      return;
    }
    const normalSpec = baseSpec("rz-testrun1-close-normal");
    const normalHandle = await backend.create(normalSpec);
    await backend.start(normalHandle);

    const keepAliveSpec = baseSpec("rz-testrun1-close-keepalive", { keepAlive: true });
    const keepAliveHandle = await backend.create(keepAliveSpec);
    await backend.start(keepAliveHandle);

    await backend.close();

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as { sandboxes: Record<string, unknown> };
    assert.equal(
      normalHandle.id in state.sandboxes,
      false,
      "close() must have removed the non-keepAlive sandbox via its own-run cleanup sweep",
    );
    assert.equal(
      keepAliveHandle.id in state.sandboxes,
      true,
      "close() must never remove a keepAlive sandbox — it stays alive for reuse by a later run",
    );

    // Clean up the sandbox close() correctly left running, so the fake msb
    // process doesn't leak past this test.
    await backend.removeByName(keepAliveHandle.id);
  });

  it("stop() completes quickly on the normal path: the attached child stays alive until `msb stop` ends it", async () => {
    if (skipOnWindows()) {
      return;
    }
    // The fake's `run` process stays alive (msb's own supervisor model —
    // confirmed against the real msb binary) until something ends it: here
    // that's the `msb stop` call stop() itself issues. This asserts the
    // common case is fast — stop() doesn't need to fall back to a timeout or
    // a SIGKILL when the child exits promptly in response to its own stop.
    const spec = baseSpec("rz-testrun1-regression");
    const handle = await backend.create(spec);
    await backend.start(handle);

    const startedAt = Date.now();
    await backend.stop(handle);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 3000, `stop() took ${elapsedMs}ms — expected well under the 10s timeout fallback`);

    await backend.remove(handle);
  });

  it("stop() does not hang when the attached child is already dead before stop() is called", async () => {
    if (skipOnWindows()) {
      return;
    }
    // Covers the scenario state.attachedExited genuinely guards against:
    // the attached child dying before stop() ever runs (crashed, or killed
    // by something external) rather than as a result of stop()'s own `msb
    // stop` call. Node never replays a past "exit" event to a listener
    // attached after the fact, so if stop() didn't check attachedExited
    // first, it would attach a fresh listener for an event that already
    // happened and wait out the full ATTACHED_PROC_STOP_TIMEOUT_MS.
    const spec = baseSpec("rz-testrun1-alreadydead");
    const handle = await backend.create(spec);
    await backend.start(handle);

    const state = (backend as unknown as { handles: Map<string, { attached?: { kill(sig: string): void } }> })
      .handles.get(handle.id);
    const attached = state?.attached;
    if (attached === undefined) {
      throw new Error("expected start() to have recorded the attached child");
    }
    attached.kill("SIGKILL");
    // Give the child's own "exit" listener (registered in start()) a moment
    // to run and flip attachedExited before stop() ever checks it.
    await new Promise((r) => setTimeout(r, 300));

    const startedAt = Date.now();
    await backend.stop(handle);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 3000, `stop() took ${elapsedMs}ms — expected well under the 10s timeout fallback`);

    await backend.remove(handle);
  });

  it("exec returns the fake's echoed result", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-2");
    const handle = await backend.create(spec);
    await backend.start(handle);
    const result = await backend.exec(handle, ["echo", "hi"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /exec-ok:echo hi/);
    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("followLogs delivers the fake's boot lines and close() halts delivery without hanging", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-3");
    const handle = await backend.create(spec);
    await backend.start(handle);

    const delivered: string[] = [];
    const follow = await backend.followLogs(handle, (line) => delivered.push(line));
    // Give the follow child a moment to deliver the two seeded log lines
    // before this test asks it to stop.
    await new Promise((r) => setTimeout(r, 300));
    await follow.close();

    assert.ok(delivered.some((l) => l.includes("ready")));
    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("followLogs watchdog quiesces and replays undelivered lines once the sandbox stops", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-4");
    const handle = await backend.create(spec);
    await backend.start(handle);

    const delivered: string[] = [];
    const follow = await backend.followLogs(handle, (line) => delivered.push(line));

    // Stop the sandbox out from under the follow stream — the fake's `logs
    // -f` never exits on its own (reproducing the real msb defect),
    // so only the watchdog noticing "no longer Running" can end this.
    await backend.stop(handle);

    // Give the watchdog's poll loop a chance to observe the stop and run
    // its quiesce+replay.
    await new Promise((r) => setTimeout(r, 700));
    await follow.close();

    assert.ok(delivered.includes("ready"));
    await backend.remove(handle);
  });

  it("start self-heals a first boot that fails with msb's image-cache corruption signature", async () => {
    if (skipOnWindows()) {
      return;
    }
    // Seed the fake to fail exactly one `run` with the captured cache-error
    // shape; the backend must classify it, remove the affected image's cache
    // entry, retry once, and reach Running — all without surfacing an error.
    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failRunsWithCacheError = 1;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    const spec = baseSpec("rz-testrun1-heal");
    const handle = await backend.create(spec);
    await backend.start(handle);

    const after = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.deepEqual(
      after.imageRemoves,
      ["fake:latest"],
      "the heal must have removed exactly the affected image's cache entry, once",
    );
    const logs = await backend.logs(handle);
    assert.match(logs, /ready/);

    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("start surfaces an actionable error when the cache corruption repeats after the heal", async () => {
    if (skipOnWindows()) {
      return;
    }
    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failRunsWithCacheError = 2;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    const spec = baseSpec("rz-testrun1-heal-twice");
    const handle = await backend.create(spec);
    let thrown: Error | undefined;
    try {
      await backend.start(handle);
    } catch (e) {
      thrown = e as Error;
    }
    if (thrown === undefined) {
      throw new Error("start must reject after two identical cache failures");
    }
    assert.match(thrown.message, /twice in a row/);
    assert.match(thrown.message, /fake:latest/, "the error must name the affected image");
    assert.match(thrown.message, /image cache/, "the error must name the attempted heal");

    const after = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.deepEqual(after.imageRemoves, ["fake:latest"], "the heal must have run exactly once, not per failure");
    await backend.remove(handle);
  });

  it("start retries once when msb run hits msb's state-database error, with no heal step", async () => {
    if (skipOnWindows()) {
      return;
    }
    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failRunsWithStateDbError = 1;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    const spec = baseSpec("rz-testrun1-dbfail");
    const handle = await backend.create(spec);
    await backend.start(handle);

    const after = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.deepEqual(
      after.imageRemoves ?? [],
      [],
      "a state-db-error retry must not touch the image cache — that heal belongs to the corruption path",
    );
    const logs = await backend.logs(handle);
    assert.match(logs, /ready/);

    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("start surfaces an actionable error when the state-database error repeats after the retry", async () => {
    if (skipOnWindows()) {
      return;
    }
    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failRunsWithStateDbError = 2;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    const spec = baseSpec("rz-testrun1-dbfail-twice");
    const handle = await backend.create(spec);
    let thrown: Error | undefined;
    try {
      await backend.start(handle);
    } catch (e) {
      thrown = e as Error;
    }
    if (thrown === undefined) {
      throw new Error("start must reject after two state-database failures");
    }
    assert.match(thrown.message, /state-database error twice in a row/);
    assert.match(thrown.message, /already exists/, "the error must carry msb's own output");
    await backend.remove(handle);
  });

  it("start classifies a clean fast exit as success when ls reports Stopped and the system log carries the started marker", async () => {
    if (skipOnWindows()) {
      return;
    }
    // Reproduces msb 0.6.16's fast-exit shape: the attached `run` process
    // exits 0 before this backend's poll loop ever observes "Running" —
    // 0.6.16's convergent-lifecycle rework means a fast-completing workload
    // is only ever seen "Starting" first. Both required signals are present
    // here (the fixture's default fast-exit shape): the sandbox settles on
    // "Stopped" and the system log carries the boot-completion marker.
    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.fastExitRuns = 1;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    const spec = baseSpec("rz-testrun1-fastexit-ok");
    const handle = await backend.create(spec);
    await backend.start(handle); // must not throw

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      sandboxes: Record<string, { status: string }>;
    };
    assert.equal(
      state.sandboxes[handle.id]?.status,
      "Stopped",
      "expected the completed sandbox to remain Stopped, not be revived",
    );

    const running = await backend.findRunning(spec);
    assert.equal(running, undefined, "a completed fast-exit sandbox must report as not running");

    // stop() must remain safe on an already-finished sandbox.
    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("start still fails the ordinary way when the fast exit's system log never carries the started marker", async () => {
    if (skipOnWindows()) {
      return;
    }
    // Same clean exit and Stopped state as the success case, but the guest
    // agent never came up to write the marker — the agentless-death shape
    // (msb 0.6.10-0.6.13 on Windows also exited 0 before Running). This must
    // NOT be classified as success: a clean exit plus Stopped alone is not
    // enough.
    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.fastExitRuns = 1;
    seeded.fastExitWriteMarker = false;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    const spec = baseSpec("rz-testrun1-fastexit-nomarker");
    const handle = await backend.create(spec);
    let thrown: Error | undefined;
    try {
      await backend.start(handle);
    } catch (e) {
      thrown = e as Error;
    }
    if (thrown === undefined) {
      throw new Error("start must reject when the started marker is absent, even with a clean exit and Stopped state");
    }
    assert.match(
      thrown.message,
      /exited \(code 0\) before reaching/,
      "expected the existing boot-failure message, unchanged",
    );
    await backend.remove(handle);
  });

  it("start still fails the ordinary way when ls does not report the fast-exited sandbox as Stopped", async () => {
    if (skipOnWindows()) {
      return;
    }
    // Clean exit and the started marker present, but the sandbox's own state
    // never settled on "Stopped". The marker alone must not be enough to
    // classify this as success.
    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.fastExitRuns = 1;
    seeded.fastExitFinalStatus = "Starting";
    await fs.writeFile(statePath, JSON.stringify(seeded));

    const spec = baseSpec("rz-testrun1-fastexit-notstopped");
    const handle = await backend.create(spec);
    let thrown: Error | undefined;
    try {
      await backend.start(handle);
    } catch (e) {
      thrown = e as Error;
    }
    if (thrown === undefined) {
      throw new Error(
        "start must reject when the sandbox never settled on Stopped, even with a clean exit and the marker present",
      );
    }
    assert.match(
      thrown.message,
      /exited \(code 0\) before reaching/,
      "expected the existing boot-failure message, unchanged",
    );
    await backend.remove(handle);
  });

  it("createCheckpoint refuses a tmpfs-root sandbox with TmpfsRootCheckpointError before stopping it", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-ckpt-tmpfs", { tmpfsRootMb: 256 });
    const handle = await backend.create(spec);
    await backend.start(handle);

    let thrown: unknown;
    try {
      await backend.createCheckpoint(handle, "rz-ckpt-tmpfsblocked");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof TmpfsRootCheckpointError, `expected TmpfsRootCheckpointError, got: ${String(thrown)}`);

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as { sandboxes: Record<string, { status: string }> };
    assert.equal(state.sandboxes[handle.id]?.status, "Running", "expected the sandbox to never have been stopped");

    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("GenericContainer.checkpoint(name) hoists the tmpfs-root refusal ahead of replace semantics — a refused re-checkpoint leaves the prior artifact and registry entry intact", async () => {
    if (skipOnWindows()) {
      return;
    }
    const cacheDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-msb-tmpfs-hoist-test-"));
    const savedCacheDir = process.env["RIGHTSIZE_CACHE_DIR"];
    process.env["RIGHTSIZE_CACHE_DIR"] = cacheDirPath;
    try {
      // First, an ordinary container checkpoints under the name "seeded" —
      // this is the artifact + registry entry a later refused re-checkpoint
      // must not touch.
      const ordinary = new GenericContainer("fake:latest")
        .withBackend(backend)
        .withCommand("sleep", "60")
        .waitingFor(instantReady());
      await ordinary.start();
      const first = await ordinary.checkpoint("seeded");
      await ordinary.stop();

      assert.equal(await backend.hasCheckpoint(first.ref), true, "expected the first checkpoint's artifact to exist");

      // A second, tmpfs-root container tries to checkpoint under the SAME
      // name — same deterministic ref. Before the hoist, checkpoint() would
      // have already best-effort-removed the artifact under that ref
      // (replace semantics) before ever reaching the backend's own
      // tmpfs-root guard inside createCheckpoint.
      const tmpfsContainer = new GenericContainer("fake:latest")
        .withBackend(backend)
        .withTmpfsRoot(256)
        .waitingFor(instantReady());
      await tmpfsContainer.start();

      let thrown: unknown;
      try {
        await tmpfsContainer.checkpoint("seeded");
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof TmpfsRootCheckpointError, `expected TmpfsRootCheckpointError, got: ${String(thrown)}`);

      assert.equal(
        await backend.hasCheckpoint(first.ref),
        true,
        "expected the refused re-checkpoint to have left the prior artifact under 'seeded' untouched",
      );
      const read = await readCheckpointRegistry(cacheDirPath, "seeded");
      assert.equal(read.kind, "found", "expected the registry entry under 'seeded' to still exist");
      if (read.kind === "found") {
        assert.equal(read.entry.ref, first.ref, "expected the registry entry to still point at the original artifact");
      }

      await tmpfsContainer.stop();
    } finally {
      if (savedCacheDir === undefined) {
        delete process.env["RIGHTSIZE_CACHE_DIR"];
      } else {
        process.env["RIGHTSIZE_CACHE_DIR"] = savedCacheDir;
      }
      await fs.rm(cacheDirPath, { recursive: true, force: true });
    }
  });

  it("GenericContainer.checkpoint(name) re-checkpointing the same name on msb actually removes the PRIOR checkpoint's real content-addressed artifact, not just the never-real nominal ref", async () => {
    if (skipOnWindows()) {
      return;
    }
    const cacheDirPath = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-msb-replace-artifact-test-"));
    const savedCacheDir = process.env["RIGHTSIZE_CACHE_DIR"];
    process.env["RIGHTSIZE_CACHE_DIR"] = cacheDirPath;
    try {
      const container = new GenericContainer("fake:latest")
        .withBackend(backend)
        .withCommand("sleep", "60")
        .waitingFor(instantReady());
      await container.start();

      const first = await container.checkpoint("seeded");
      assert.equal(await backend.hasCheckpoint(first.ref), true, "expected the first checkpoint's artifact to exist");

      // The nominal ref this same name would mint is never where msb 0.7.1
      // actually put the artifact — see checkpoint/ref.ts and
      // MsbCliBackend.createCheckpoint's own doc — so this is the ref the
      // UNFIXED pre-removal step would have (uselessly) targeted instead.
      const nominalRef = path.join(cacheDirPath, "checkpoints", "rz-ckpt-seeded");
      assert.ok(first.ref !== nominalRef, "expected the msb-shaped effective ref to differ from the nominal one");

      // Re-checkpointing under the SAME name mints a second, different
      // content-addressed artifact (a fresh snap_<digest> each time — see
      // the fake fixture's own snapshot-create branch).
      const second = await container.checkpoint("seeded");
      assert.ok(second.ref !== first.ref, "expected a fresh effective ref on the second checkpoint too");

      // The actual fix, end to end: the FIRST checkpoint's real artifact is
      // gone — both from msb's own index and from disk — not merely
      // orphaned. This is the assertion that fails against the pre-fix
      // code, which only ever best-effort-removed `nominalRef` (a path that
      // was never real on this backend).
      assert.equal(
        await backend.hasCheckpoint(first.ref),
        false,
        "expected the prior checkpoint's real artifact to be gone after a same-name re-checkpoint",
      );
      await assert.rejects(fs.access(first.ref), "expected the prior checkpoint's artifact directory to have been deleted from disk");

      const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
        snapshots?: Record<string, unknown>;
        callLog: Array<{ cmd: string; args: string[] }>;
      };
      assert.equal(first.ref in (state.snapshots ?? {}), false, "expected msb's own index to no longer carry the prior artifact");
      const removalCall = state.callLog.find((c) => c.cmd === "snapshotRemove" && c.args.includes(first.ref));
      assert.ok(removalCall !== undefined, "expected an 'msb snapshot rm' call against the PRIOR entry's recorded effective ref");

      // The SECOND checkpoint's own artifact must survive untouched.
      assert.equal(await backend.hasCheckpoint(second.ref), true, "expected the latest checkpoint's own artifact to remain");

      const read = await readCheckpointRegistry(cacheDirPath, "seeded");
      assert.equal(read.kind, "found");
      if (read.kind === "found") {
        assert.equal(read.entry.ref, second.ref, "expected the registry to hold the latest checkpoint's ref");
      }

      await container.stop();
    } finally {
      if (savedCacheDir === undefined) {
        delete process.env["RIGHTSIZE_CACHE_DIR"];
      } else {
        process.env["RIGHTSIZE_CACHE_DIR"] = savedCacheDir;
      }
      await fs.rm(cacheDirPath, { recursive: true, force: true });
    }
  });

  it("createCheckpoint's reboot polls past an install-lock refusal instead of failing the checkpoint", async () => {
    if (skipOnWindows()) {
      return;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-msb-ckpt-lock-test-"));
    try {
      const ref = path.join(dir, "checkpoints", "rz-ckpt-lockretry1");
      const spec = baseSpec("rz-testrun1-ckpt-lock", { command: ["sleep", "60"] });
      const handle = await backend.create(spec);
      await backend.start(handle);

      // Refuse exactly the NEXT `restore` — which is the checkpoint cycle's
      // post-snapshot reboot — with msb's install-lock message. The reboot
      // must go through the same classified poll the ordinary boot path
      // uses and succeed on its retry, not fail the whole checkpoint.
      const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
      seeded.failRunsWithInstallLock = 1;
      await fs.writeFile(statePath, JSON.stringify(seeded));

      await backend.createCheckpoint(handle, ref);

      const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
        sandboxes: Record<string, { status: string }>;
        callLog: Array<{ cmd: string; args: string[] }>;
      };
      assert.equal(state.sandboxes[handle.id]?.status, "Running", "expected the reboot retry to bring the sandbox back up");
      const rebootRuns = state.callLog.filter((c) => c.cmd === "restore");
      assert.equal(rebootRuns.length, 2, "expected the refused reboot plus one retried reboot");

      await backend.stop(handle);
      await backend.remove(handle);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("createCheckpoint on a path ref mkdirs the parent, emits --dest-dir, and reboots from the DISCOVERED artifact path — never the nominal ref", async () => {
    if (skipOnWindows()) {
      return;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-msb-pathref-create-test-"));
    try {
      const checkpointsDir = path.join(dir, "checkpoints");
      const ref = path.join(checkpointsDir, "rz-ckpt-pathref01");
      const spec = baseSpec("rz-testrun1-ckpt-pathref", { command: ["sleep", "60"] });
      const handle = await backend.create(spec);
      await backend.start(handle);
      const originalName = handle.id;

      const effectiveRef = await backend.createCheckpoint(handle, ref);

      // The msb 0.7.1 ref shape: absolute, the checkpoints dir is an
      // ANCESTOR (never necessarily the direct parent), basename matches
      // snap_<hex> — never the nominal rz-ckpt-<name> this method was asked
      // to checkpoint under.
      assert.equal(path.isAbsolute(effectiveRef), true, "expected an absolute effective ref");
      assert.ok(
        effectiveRef.split(path.sep).includes("checkpoints"),
        `expected 'checkpoints' to be an ancestor of ${effectiveRef}`,
      );
      assert.match(path.basename(effectiveRef), /^snap_[0-9a-f]+$/i);
      assert.ok(effectiveRef !== ref, "expected the effective ref to differ from the nominal one this method was asked to use");

      const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
        sandboxes: Record<string, { status: string }>;
        callLog: Array<{ cmd: string; args: string[] }>;
      };
      const snapshotCall = state.callLog.find((c) => c.cmd === "snapshotCreate");
      assert.deepEqual(snapshotCall?.args, [
        "snapshot",
        "create",
        "--from-sandbox",
        originalName,
        "rz-ckpt-pathref01",
        "--dest-dir",
        checkpointsDir,
      ]);
      assert.ok(handle.id !== originalName, "expected the reboot to have rebooted under a FRESH name, in place on the handle");
      assert.equal(state.sandboxes[handle.id]?.status, "Running", "expected the fresh-name sandbox to be running again after the cycle");
      assert.equal(
        await backend.hasCheckpoint(effectiveRef),
        true,
        "expected the artifact directory to hold a snapshot.json",
      );

      const rebootCall = state.callLog.filter((c) => c.cmd === "restore").at(-1);
      assert.ok(rebootCall !== undefined, "expected a reboot 'restore' call after the snapshot/rm cycle");
      assert.equal(
        rebootCall?.args[1],
        effectiveRef,
        "expected the reboot restore's positional to be the DISCOVERED artifact path, not the nominal ref",
      );
      assert.equal(rebootCall?.args[3], handle.id, "expected the reboot restore's --name to be the fresh name, matching the mutated handle");

      // Subsequent stop()/remove() must target the FRESH name — the same
      // handle reference, mutated in place, is all a caller ever needs.
      await backend.stop(handle);
      await backend.remove(handle);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("createCheckpoint drives exactly stop -> snapshot create -> rm -> a reboot run from the snapshot under a FRESH name, leaving the sandbox Running", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-ckpt-1", {
      ports: [{ hostPort: 15999, guestPort: 80 }],
      env: [["FOO", "bar"]],
      command: ["sleep", "60"],
    });
    const handle = await backend.create(spec);
    await backend.start(handle);
    const originalName = handle.id;

    const effectiveRef = await backend.createCheckpoint(handle, "rz-ckpt-abcdef012345");

    // FRESH-NAME RED-PROOF (a) (distinct from this suite's other lettered
    // reviveWorkload red-proofs below): the reboot happens under a
    // DIFFERENT name than the original, and that new identity is published
    // onto the SAME handle reference in place — a caller never needs a
    // second handle.
    const freshName = handle.id;
    assert.ok(freshName !== originalName, "expected createCheckpoint's reboot to mint a FRESH sandbox name, not reuse the original");
    // rz-<RunId.value>-<seq> — RunId.value is THIS PROCESS's own real run id
    // (8 lowercase hex, see core/run-id.ts), never the fake spec's own
    // `runId: "testrun1"` field (a label baseSpec sets for docker/msb
    // diagnostics, unrelated to the name generator).
    assert.match(freshName, /^rz-[0-9a-f]{8}-\d+$/, "expected the fresh name to follow the same rz-<RunId.value>-<seq> generator every ordinary boot uses");

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      sandboxes: Record<string, { status: string }>;
      snapshots: Record<string, { from: string }>;
      callLog: Array<{ cmd: string; args: string[] }>;
    };
    assert.equal(state.snapshots[effectiveRef]?.from, originalName, "expected the snapshot recorded FROM the original sandbox");
    assert.equal(state.sandboxes[originalName], undefined, "expected the original name to have been rm'd, not left behind");
    assert.equal(state.sandboxes[freshName]?.status, "Running", "expected the FRESH-name sandbox to be running again after the cycle");

    // The initial backend.start() above already logged its own "run" call;
    // only the last five calls belong to the checkpoint cycle itself — the
    // reboot's own restore, THEN reviveWorkload's workload-revival exec
    // (msb restore boots the reboot idle; this backend restarts the
    // captured workload itself — see MsbCliBackend.bootRestoreOnce's own
    // doc).
    const cycle = state.callLog.slice(-5);
    assert.deepEqual(
      cycle.map((c) => c.cmd),
      ["stop", "snapshotCreate", "rm", "restore", "execWorkload"],
      "expected the checkpoint cycle to drive exactly stop -> snapshot create -> rm -> restore -> the " +
        "workload-revival exec, in order",
    );
    assert.deepEqual(
      cycle[3]?.args,
      ["restore", effectiveRef, "--name", freshName, "-p", "15999:80"],
      "expected the reboot's restore to carry the DISCOVERED artifact ref positional, the FRESH name (never " +
        "the original), and the ports from the original spec — never --disk-only (a disk-scope snapshot " +
        "rejects it) and never -e: msb restore has no env flag at all (see MsbCommands.restore)",
    );
    assert.deepEqual(
      cycle[4]?.args,
      ["exec", "-e", "FOO=bar", freshName, "--", "sleep", "60"],
      "expected the workload-revival exec to target the FRESH name, carrying the original spec's env as -e " +
        "pairs and its explicit command as the trailing argv",
    );

    // FRESH-NAME RED-PROOF (a), continued: subsequent stop()/remove() — using the SAME
    // handle reference createCheckpoint mutated in place — target the new
    // name, never the original.
    await backend.stop(handle);
    await backend.remove(handle);
    const afterTeardown = JSON.parse(await fs.readFile(statePath, "utf8")) as { callLog: Array<{ cmd: string; args: string[] }> };
    const teardownTail = afterTeardown.callLog.slice(-2);
    assert.deepEqual(
      teardownTail.map((c) => c.cmd),
      ["stop", "rm"],
      "expected the final stop()/remove() to have driven exactly one more stop and one more rm",
    );
    assert.equal(teardownTail[0]?.args[1], freshName, "expected the final stop() to target the FRESH name");
    assert.equal(teardownTail[1]?.args[1], freshName, "expected the final remove() to target the FRESH name");
  });

  it("createCheckpoint's reboot re-emits the original sandbox's mounts and network-isolation flag, not just ports", async () => {
    if (skipOnWindows()) {
      return;
    }
    // Mirrors `new GenericContainer(image).withCopyFileToContainer(...).withNetworkDisabled().start()`
    // followed by `.checkpoint()`: the reboot's `handle.spec` is the ORIGINAL
    // sandbox's own live mounts/networkDisabled, not anything carried over
    // from a captured spec (see MsbCommands.restore's own doc) — so both
    // must reach the reboot's `restore` call unchanged, the same way ports
    // already do above, or a `.withNetworkDisabled()` sandbox would silently
    // regain public network access, and a `.withCopyFileToContainer()`
    // sandbox would either silently lose its mount or hard-fail under msb's
    // own require-complete restore-resource check.
    const spec = baseSpec("rz-testrun1-ckpt-mounts", {
      ports: [{ hostPort: 15998, guestPort: 80 }],
      mounts: [{ hostPath: "/host/config.json", guestPath: "/guest/config.json", readOnly: true }],
      networkDisabled: true,
      command: ["sleep", "60"],
    });
    const handle = await backend.create(spec);
    await backend.start(handle);
    const originalName = handle.id;

    const effectiveRef = await backend.createCheckpoint(handle, "rz-ckpt-mountsandnet");
    assert.ok(handle.id !== originalName, "expected the reboot to have rebooted under a FRESH name, in place on the handle");

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      callLog: Array<{ cmd: string; args: string[] }>;
    };
    const rebootCall = state.callLog.filter((c) => c.cmd === "restore").at(-1);
    assert.ok(rebootCall !== undefined, "expected a reboot 'restore' call after the snapshot/rm cycle");
    assert.deepEqual(
      rebootCall?.args,
      [
        "restore",
        effectiveRef,
        "--name",
        handle.id,
        "--no-net",
        "-p",
        "15998:80",
        "--volume",
        "/host/config.json:/guest/config.json:ro,nodev",
      ],
      "expected the reboot's restore to re-emit --no-net (networkDisabled) and --volume (mounts) from the " +
        "original spec, exactly like it already does for ports — and never --disk-only, which a " +
        "disk-scope snapshot rejects",
    );

    await backend.stop(handle);
    await backend.remove(handle);
  });

  // The tests below exercise MsbCliBackend.bootRestoreOnce directly at the
  // start() level, on a handle whose spec already carries checkpointRef —
  // the exact same code path BOTH the internal checkpoint()
  // stop/snapshot/reboot cycle above and GenericContainer.fromCheckpoint()
  // .start() drive (fromCheckpoint() only ever sets spec.checkpointRef the
  // same way baseSpec's override does here), so covering it here covers
  // both callers without standing up the full checkpoint registry machinery.

  // RED-PROOF (a): restore + explicit-command spec => exec child spawned
  // with the right argv and -e pairs, wait strategy satisfied, stop() reaps.
  it("start() on a checkpointRef spec supervises msb restore as the detached boot it is, THEN revives its captured workload as a genuine attached exec child", async () => {
    if (skipOnWindows()) {
      return;
    }
    // The fake's "restore" branch never sets Running itself — by default it
    // takes two subsequent 'ls' polls (see fake-msb.mjs) before the
    // sandbox is reported Running, reproducing a real detached restore
    // whose own CLI process has already exited before the background boot
    // catches up. A one-shot check right after that exit must not be
    // mistaken for either success or failure.
    const spec = baseSpec("rz-testrun1-restore-detached", {
      checkpointRef: "/fake/checkpoints/snap_deadbeef",
      env: [["A", "1"], ["B", "2"]],
      command: ["redis-server", "--port", "6379"],
    });
    const handle = await backend.create(spec);

    await backend.start(handle);

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      sandboxes: Record<string, { status: string }>;
      callLog: Array<{ cmd: string; args: string[] }>;
    };
    assert.equal(state.sandboxes[handle.id]?.status, "Running", "expected the restored sandbox to reach Running");

    // `msb restore` itself boots the sandbox idle (see
    // MsbCliBackend.bootRestoreOnce's own doc) — this backend must have
    // revived the captured workload itself via a genuine attached `msb
    // exec` child, with the spec's env as -e pairs and its explicit command
    // as the trailing argv, in that order.
    const execCall = state.callLog.filter((c) => c.cmd === "execWorkload").at(-1);
    assert.deepEqual(
      execCall?.args,
      ["exec", "-e", "A=1", "-e", "B=2", handle.id, "--", "redis-server", "--port", "6379"],
      "expected the workload-revival exec's argv to carry -e KEY=VALUE pairs then the sandbox name then " +
        "-- <explicit command>",
    );

    const internal = (backend as unknown as { handles: Map<string, { attached: unknown }> }).handles.get(handle.id);
    assert.ok(
      internal?.attached !== undefined,
      "expected the restored sandbox's handle to carry the workload-revival exec child as its attached " +
        "process — the same slot bootRunOnce's own attached `msb run` child fills for an ordinary boot",
    );

    // stop() must reap this attached child exactly like any other: no hang,
    // no throw, no leftover process.
    const startedAt = Date.now();
    await backend.stop(handle);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 3000, `stop() took ${elapsedMs}ms — expected the revived workload to be reaped promptly`);
    await backend.remove(handle);
  });

  // RED-PROOF (b): no-command spec + captured-cmdline registry field => exec
  // uses the captured argv.
  it("createCheckpoint captures the guest workload cmdline before stopping a no-command sandbox, and a later registry-mediated restore uses it", async () => {
    if (skipOnWindows()) {
      return;
    }
    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.cmdlineCaptureArgv = ["redis-server", "--appendonly", "yes"];
    await fs.writeFile(statePath, JSON.stringify(seeded));

    // The source spec carries NO explicit command — the image's own default
    // entrypoint was "running" — so createCheckpoint's pre-stop capture is
    // the only source for a workload argv.
    const spec = baseSpec("rz-testrun1-ckpt-capture", { env: [["MODE", "prod"]] });
    const handle = await backend.create(spec);
    await backend.start(handle);

    const effectiveRef = await backend.createCheckpoint(handle, "rz-ckpt-capture-entry");
    const capturedCommand = backend.capturedWorkloadCommand(handle);
    if (capturedCommand === undefined) {
      throw new Error("expected createCheckpoint to have captured the guest's own workload cmdline before stopping it");
    }
    assert.deepEqual(capturedCommand, ["redis-server", "--appendonly", "yes"]);

    // Persist the registry entry the way GenericContainer.checkpoint(name)
    // would: spec.command stays null (the source truly had none),
    // capturedCommand carries the fallback as its own additive field.
    const entry: CheckpointRegistryEntry = {
      name: "captured-entrypoint",
      ref: effectiveRef,
      backend: "microsandbox",
      createdIso: new Date().toISOString(),
      spec: toCheckpointRegistrySpec(handle.spec),
      capturedCommand,
    };
    await writeCheckpointRegistryAtomic(cacheDir(), "captured-entrypoint", entry);

    // A LATER restore, registry-mediated: fromCheckpointRegistryEntry's own
    // merge (see its own doc) resolves `command` from capturedCommand, since
    // the registry's own spec.command is null.
    const read = await readCheckpointRegistry(cacheDir(), "captured-entrypoint");
    assert.equal(read.kind, "found");
    if (read.kind !== "found") {
      return;
    }
    const restoredSpec = fromCheckpointRegistryEntry(read.entry);
    assert.deepEqual(
      restoredSpec.command,
      capturedCommand,
      "expected the reconstructed spec's command to fall back to the captured cmdline",
    );

    const restoredHandle = await backend.create(restoredSpec);
    await backend.start(restoredHandle);

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as { callLog: Array<{ cmd: string; args: string[] }> };
    const execCall = state.callLog.filter((c) => c.cmd === "execWorkload").at(-1);
    assert.deepEqual(
      execCall?.args,
      ["exec", "-e", "MODE=prod", restoredHandle.id, "--", "redis-server", "--appendonly", "yes"],
      "expected the workload-revival exec to use the CAPTURED cmdline as its argv, with the checkpoint's own env",
    );

    await backend.stop(restoredHandle);
    await backend.remove(restoredHandle);
    await backend.stop(handle);
    await backend.remove(handle);
    await backend.removeCheckpoint(effectiveRef);
  });

  // RED-PROOF (c): no-command + no captured field => typed error, no idle boot.
  it("a restore whose spec has no command and no captured cmdline throws CheckpointWorkloadCommandMissingError — never boots idle", async () => {
    if (skipOnWindows()) {
      return;
    }
    // No command override (baseSpec's default is undefined) and nothing
    // scripted for state.cmdlineCaptureArgv/cmdlineCaptureFails — the
    // fixture's own capture-script branch falls through to its "no matching
    // child" exit 1, exactly like a genuine capture miss.
    const spec = baseSpec("rz-testrun1-restore-nocapture", { checkpointRef: "/fake/checkpoints/snap_nocapture" });
    const handle = await backend.create(spec);

    let thrown: unknown;
    try {
      await backend.start(handle);
    } catch (err) {
      thrown = err;
    }
    assert.ok(
      thrown instanceof CheckpointWorkloadCommandMissingError,
      `expected CheckpointWorkloadCommandMissingError, got: ${String(thrown)}`,
    );
    assert.match((thrown as Error).message, /predates workload-cmdline capture/);

    // Never registered as started — a caller must not treat this as a
    // successful (if idle) boot.
    const started = (backend as unknown as { startedNames: Set<string> }).startedNames;
    assert.equal(started.has(handle.id), false, "expected the failed revival to never register the sandbox as started");

    // The msb-level sandbox itself DID reach Running (msb restore succeeded
    // — this backend simply refuses to treat that as a usable boot); stop()
    // must still be a safe no-op over it.
    await backend.stop(handle);
    await backend.remove(handle);
  });

  // RED-PROOF (d): restore access-denied once then success => boot succeeds
  // with exactly 2 restore invocations, each under a DIFFERENT `--name` (the
  // ordinary start()/fromCheckpoint() path's own fresh-naming retry,
  // MsbCliBackend.retryRestoreAfterAccessDenied — see its own doc on why a
  // same-name retry would instead collide with the stopped record the first
  // attempt leaves behind). `handle.id`/`handle.spec.name` must end up
  // mutated to the WINNING attempt's own name, and the failed first
  // attempt's name must get a best-effort `msb rm`.
  it("msb restore's Windows access-denied failure on its own snapshot artifact is retried under a fresh name — boot succeeds with exactly 2 restore invocations", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-restore-accessdenied", {
      checkpointRef: "/fake/checkpoints/snap_accessdenied",
      command: ["sleep", "60"],
    });
    const handle = await backend.create(spec);
    const originalName = handle.id;

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failRestoreWithAccessDenied = 1;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    await backend.start(handle);
    const freshName = handle.id;
    assert.ok(freshName !== originalName, "expected the retry to mint a fresh sandbox name, not reuse the one that hit access-denied");

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      sandboxes: Record<string, { status: string }>;
      callLog: Array<{ cmd: string; args: string[] }>;
    };
    assert.equal(state.sandboxes[freshName]?.status, "Running", "expected the retried restore to bring the FRESH-name sandbox up");
    const restoreCalls = state.callLog.filter((c) => c.cmd === "restore");
    assert.equal(restoreCalls.length, 2, "expected the refused restore plus exactly one retried restore");
    const restoreNames = restoreCalls.map((c) => c.args[3]);
    assert.ok(
      restoreNames[0] !== restoreNames[1],
      "expected the retried attempt to target a DIFFERENT name, not the one that just hit access-denied",
    );
    assert.equal(restoreNames[0], originalName, "expected the first (failed) attempt to target the original name");
    assert.equal(restoreNames[1], freshName, "expected the WINNING attempt's own name to end up as the handle's new id");

    const rmCalls = state.callLog.filter((c) => c.cmd === "rm");
    assert.ok(
      rmCalls.some((c) => c.args[1] === originalName),
      "expected a best-effort 'msb rm' of the access-denied attempt's own failed (original) name",
    );

    await backend.stop(handle);
    await backend.remove(handle);
  });

  // FRESH-NAME RED-PROOF (e): createCheckpoint's own reboot treats a
  // Windows access-denied refusal the same way retryRestoreAfterAccessDenied
  // (the ordinary start() path's own retry, exercised above) does — mint a
  // NEW name, best-effort `msb rm` the failed one, never a same-name retry —
  // because the live-verified dossier this policy is built from is
  // precisely this signature: a restore that fails PAST msb's own
  // validation leaves its `--name` behind as a stopped sandbox record a
  // same-name retry would only collide with.
  it("createCheckpoint's reboot treats a Windows access-denied refusal the same as 'already exists' — a fresh name per attempt, with a best-effort rm of the failed one", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-ckpt-accessdenied", { command: ["sleep", "60"] });
    const handle = await backend.create(spec);
    await backend.start(handle);
    const originalName = handle.id;

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failRestoreWithAccessDenied = 1;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    await backend.createCheckpoint(handle, "rz-ckpt-accessdenied1");
    const freshName = handle.id;
    assert.ok(freshName !== originalName, "expected a fresh name even on a checkpoint whose reboot hit access-denied");

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      sandboxes: Record<string, { status: string }>;
      callLog: Array<{ cmd: string; args: string[] }>;
    };
    assert.equal(state.sandboxes[freshName]?.status, "Running", "expected the retried reboot to bring the FRESH-name sandbox up");
    const restoreCalls = state.callLog.filter((c) => c.cmd === "restore");
    assert.equal(restoreCalls.length, 2, "expected the access-denied attempt plus exactly one succeeding retry");
    const restoreNames = restoreCalls.map((c) => c.args[3]);
    assert.ok(
      restoreNames[0] !== restoreNames[1],
      "expected the retried attempt to target a DIFFERENT name, not the one that just hit access-denied",
    );
    assert.equal(restoreNames[1], freshName, "expected the WINNING attempt's own name to end up as the handle's new id");

    const rmCalls = state.callLog.filter((c) => c.cmd === "rm");
    assert.ok(
      rmCalls.some((c) => c.args[1] === restoreNames[0]),
      "expected a best-effort 'msb rm' of the access-denied attempt's own failed name",
    );

    await backend.stop(handle);
    await backend.remove(handle);
  });

  // FRESH-NAME RED-PROOF (c): createCheckpoint's own reboot retries msb's
  // "sandbox already exists" refusal (fake-forced 5 times in a row) on a
  // bounded budget (rebootUnderFreshName) — per the fresh-naming policy, EACH
  // attempt (the 5 failures and the succeeding retry) must mint and restore
  // under its OWN, never-before-used name, with a best-effort `msb rm` of
  // every failed attempt's own name — never a same-name retry, which is
  // exactly the shape that collided for the whole budget on live Windows CI.
  it("createCheckpoint's reboot retries msb's 'sandbox already exists' refusal, minting a NEW name and rm'ing the failed one on each attempt — succeeds with exactly 6 restore invocations after 5 failures", async () => {
    if (skipOnWindows()) {
      return;
    }
    // Shrink the retry budget/delay so 5 failures-then-success runs in a few
    // seconds instead of the real ~30s — the same unsafe-cast seam this
    // suite already uses elsewhere in this file to reach other private state
    // (`handles`/`startedNames`). Generous relative to the 6 real child
    // processes (5 failed restores + the succeeding one, each now paired
    // with its own best-effort `rm`) this drives, so a loaded machine still
    // reaches attempt 6 well inside the budget.
    const seam = backend as unknown as {
      checkpointRebootAlreadyExistsRetryBudgetMs: number;
      checkpointRebootAlreadyExistsRetryDelayMs: number;
    };
    seam.checkpointRebootAlreadyExistsRetryBudgetMs = 4_000;
    seam.checkpointRebootAlreadyExistsRetryDelayMs = 20;

    const spec = baseSpec("rz-testrun1-ckpt-alreadyexists", { command: ["sleep", "60"] });
    const handle = await backend.create(spec);
    await backend.start(handle);
    const originalName = handle.id;

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failRestoresWithAlreadyExists = 5;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    await backend.createCheckpoint(handle, "rz-ckpt-alreadyexists1");
    const freshName = handle.id;
    assert.ok(freshName !== originalName, "expected a fresh name even on a checkpoint whose reboot needed retries");

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      sandboxes: Record<string, { status: string }>;
      callLog: Array<{ cmd: string; args: string[] }>;
    };
    assert.equal(state.sandboxes[freshName]?.status, "Running", "expected the retried reboot to bring the FRESH-name sandbox up");
    const restoreCalls = state.callLog.filter((c) => c.cmd === "restore");
    assert.equal(restoreCalls.length, 6, "expected the 5 refused reboots plus exactly one succeeding retry");
    const restoreNames = restoreCalls.map((c) => c.args[3]);
    assert.equal(
      new Set(restoreNames).size,
      6,
      "expected every attempt — each of the 5 failures and the succeeding retry — to target its OWN name, never a reused one",
    );
    assert.equal(restoreNames.at(-1), freshName, "expected the WINNING attempt's own name to end up as the handle's new id");

    const rmCalls = state.callLog.filter((c) => c.cmd === "rm");
    const failedNames = restoreNames.slice(0, -1);
    assert.equal(failedNames.length, 5);
    for (const failedName of failedNames) {
      assert.ok(
        rmCalls.some((c) => c.args[1] === failedName),
        `expected a best-effort 'msb rm ${failedName}' for the failed attempt's own name`,
      );
    }

    await backend.stop(handle);
    await backend.remove(handle);
  });

  // RED-PROOF: createCheckpoint's own reboot exhausts its "sandbox already
  // exists" retry budget and surfaces a clear, typed error naming the
  // sandbox and the preserved checkpoint ref — never an infinite retry.
  it("createCheckpoint's reboot surfaces a clear error once its 'sandbox already exists' retry budget is exhausted", async () => {
    if (skipOnWindows()) {
      return;
    }
    // Shrink the budget so exhausting it runs in a few seconds instead of
    // the real ~30s — same seam as the success-path red-proof above. Each
    // attempt now spawns TWO real child processes (the failed `restore` plus
    // its best-effort `rm`), not just one, so the budget needs enough room
    // for at least a couple of full attempts even on a loaded machine —
    // too tight a budget makes this a flaky "gave up after exactly one
    // attempt" failure instead of a genuine retry-then-exhaust proof.
    const seam = backend as unknown as {
      checkpointRebootAlreadyExistsRetryBudgetMs: number;
      checkpointRebootAlreadyExistsRetryDelayMs: number;
    };
    seam.checkpointRebootAlreadyExistsRetryBudgetMs = 3_000;
    seam.checkpointRebootAlreadyExistsRetryDelayMs = 20;

    const spec = baseSpec("rz-testrun1-ckpt-alreadyexists-stuck", { command: ["sleep", "60"] });
    const handle = await backend.create(spec);
    await backend.start(handle);

    // Never clears — msb keeps refusing "already exists" for every restore
    // attempt the shrunk budget could possibly fit.
    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failRestoresWithAlreadyExists = 1000;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    let thrown: unknown;
    try {
      await backend.createCheckpoint(handle, "rz-ckpt-alreadyexists-stuck1");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof BackendError, `expected BackendError, got: ${String(thrown)}`);
    assert.match((thrown as Error).message, /already exists/);
    assert.match(
      (thrown as Error).message,
      /fromCheckpoint/,
      "expected the error to name fromCheckpoint() as the recovery path, same as any other failed reboot",
    );

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      sandboxes: Record<string, unknown>;
      callLog: Array<{ cmd: string; args: string[] }>;
    };
    // The old sandbox was already rm'd before the reboot was ever attempted
    // — an exhausted retry must never leave a half-recreated sandbox behind.
    assert.equal(state.sandboxes[handle.id], undefined, "expected the sandbox to have been removed, not restored");
    const restoreCalls = state.callLog.filter((c) => c.cmd === "restore");
    assert.ok(restoreCalls.length >= 2, `expected more than one retried restore attempt before giving up, got ${restoreCalls.length}`);
    const restoreNames = restoreCalls.map((c) => c.args[3]);
    assert.equal(
      new Set(restoreNames).size,
      restoreNames.length,
      "expected every exhausted attempt to have targeted its own name — never a reused one, even while giving up",
    );
    const rmCalls = state.callLog.filter((c) => c.cmd === "rm");
    for (const failedName of restoreNames) {
      assert.ok(
        rmCalls.some((c) => c.args[1] === failedName),
        `expected a best-effort 'msb rm ${failedName}' for every exhausted attempt's own name, not just the original sandbox`,
      );
    }
  });

  // FRESH-NAME RED-PROOF (b): the fresh reboot name is appended to the reaper ledger
  // BEFORE the restore is even attempted — exactly like an ordinary
  // create() — and the OLD name's own ledger entry is left in place for the
  // ledger's existing not-found-tolerant sweep, never removed by
  // createCheckpoint itself. This suite drives MsbCliBackend directly (never
  // through GenericContainer.start()), so the reaper is initialized by hand
  // here, via the same test seams core/reaper/init.test.ts uses.
  it("createCheckpoint's reboot tracks the fresh name in the reaper ledger before restoring, leaving the old name's entry for the sweep", async () => {
    if (skipOnWindows()) {
      return;
    }
    const savedReaperEnv = process.env["RIGHTSIZE_REAPER"];
    // "sweep": exercises trackSandbox/untrackSandbox without also spawning a
    // real watchdog child process against this test's fake msb binary.
    process.env["RIGHTSIZE_REAPER"] = "sweep";
    _resetReaperForTests();
    try {
      await ensureReaperInitialized(backend);
      const runsDirEntries = await fs.readdir(path.join(cacheDir(), "runs"));
      const jsonFile = runsDirEntries.find((f) => f.endsWith(".json"));
      assert.ok(jsonFile !== undefined, "expected ensureReaperInitialized to have written a run record");
      const runId = (jsonFile as string).slice(0, -".json".length);

      const spec = baseSpec("rz-testrun1-ckpt-ledger", { command: ["sleep", "60"] });
      const handle = await backend.create(spec);
      await backend.start(handle);
      const originalName = handle.id;

      // What GenericContainer.start() itself does before backend.create() —
      // done by hand here since this suite never goes through it — so the
      // ledger is in the state createCheckpoint's own reboot expects to
      // find it in.
      await trackSandbox(originalName);
      assert.deepEqual(await readSandboxNames(cacheDir(), runId), [originalName]);

      await backend.createCheckpoint(handle, "rz-ckpt-ledger-entry");
      const freshName = handle.id;
      assert.ok(freshName !== originalName, "expected the reboot to have minted a fresh name");

      assert.deepEqual(
        await readSandboxNames(cacheDir(), runId),
        [originalName, freshName],
        "expected the fresh name appended alongside the old name's own entry, which createCheckpoint never " +
          "removes — that's left for the ledger's existing not-found-tolerant sweep",
      );

      await backend.stop(handle);
      await backend.remove(handle);
    } finally {
      _resetReaperForTests();
      if (savedReaperEnv === undefined) {
        delete process.env["RIGHTSIZE_REAPER"];
      } else {
        process.env["RIGHTSIZE_REAPER"] = savedReaperEnv;
      }
    }
  });

  // The failure-path sibling of the red-proof above: a reboot that never
  // comes up must not leave the ledger permanently listing a name nothing
  // will ever retry under.
  it("createCheckpoint's reboot untracks the fresh name again if the reboot itself fails", async () => {
    if (skipOnWindows()) {
      return;
    }
    const savedReaperEnv = process.env["RIGHTSIZE_REAPER"];
    process.env["RIGHTSIZE_REAPER"] = "sweep";
    _resetReaperForTests();
    try {
      await ensureReaperInitialized(backend);
      const runsDirEntries = await fs.readdir(path.join(cacheDir(), "runs"));
      const jsonFile = runsDirEntries.find((f) => f.endsWith(".json"));
      assert.ok(jsonFile !== undefined, "expected ensureReaperInitialized to have written a run record");
      const runId = (jsonFile as string).slice(0, -".json".length);

      const spec = baseSpec("rz-testrun1-ckpt-ledger-fail", { command: ["sleep", "60"] });
      const handle = await backend.create(spec);
      await backend.start(handle);
      const originalName = handle.id;
      await trackSandbox(originalName);

      const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
      seeded.failRunsWithStateDbError = 2; // exhausts the boot classifier's one-shot state-db retry too
      await fs.writeFile(statePath, JSON.stringify(seeded));

      let thrown: unknown;
      try {
        await backend.createCheckpoint(handle, "rz-ckpt-ledger-fail-entry");
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof BackendError, `expected BackendError, got: ${String(thrown)}`);
      assert.equal(handle.id, originalName, "expected a failed reboot to leave the handle's own identity untouched");

      assert.deepEqual(
        await readSandboxNames(cacheDir(), runId),
        [originalName],
        "expected the fresh name's own ledger entry to have been removed again after the reboot failed, " +
          "leaving only the original name — never a permanently-stale entry for a name nothing will retry under",
      );

      await backend.remove(handle);
    } finally {
      _resetReaperForTests();
      if (savedReaperEnv === undefined) {
        delete process.env["RIGHTSIZE_REAPER"];
      } else {
        process.env["RIGHTSIZE_REAPER"] = savedReaperEnv;
      }
    }
  });

  // RED-PROOF (e): exec child early-nonzero => classified failure (plus the
  // exit-0 sibling shapes the same "mirror bootRunOnce" classification has).
  it("the revived workload exec exiting quickly with nonzero is a classified boot failure carrying its output", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-revive-failfast", {
      checkpointRef: "/fake/checkpoints/snap_revivefail",
      command: ["bad-command"],
    });
    const handle = await backend.create(spec);

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.execWorkloadExitCode = 127;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    let thrown: unknown;
    try {
      await backend.start(handle);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof BackendError, `expected BackendError, got: ${String(thrown)}`);
    assert.match((thrown as Error).message, /exited \(code 127\)/);
    assert.match(
      (thrown as Error).message,
      /workload exited 127/,
      "expected the exec child's own output to be surfaced",
    );

    const started = (backend as unknown as { startedNames: Set<string> }).startedNames;
    assert.equal(started.has(handle.id), false, "expected a failed workload revival to never register the sandbox as started");

    await backend.remove(handle);
  });

  it("a revived workload exec exiting 0 quickly is STILL a failure unless the sandbox itself confirms a completed fast exit", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-revive-exit0-nomarker", {
      checkpointRef: "/fake/checkpoints/snap_exit0nomarker",
      command: ["true"],
    });
    const handle = await backend.create(spec);

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.execWorkloadExitCode = 0;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    let thrown: unknown;
    try {
      await backend.start(handle);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof BackendError, `expected BackendError, got: ${String(thrown)}`);
    assert.match((thrown as Error).message, /exited \(code 0\)/);

    await backend.remove(handle);
  });

  it("a revived workload exec exiting 0 quickly succeeds when the sandbox itself confirms a completed fast exit (the repo's existing fast-exit-completion semantics)", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-revive-exit0-fastexit", {
      checkpointRef: "/fake/checkpoints/snap_exit0fastexit",
      command: ["true"],
    });
    const handle = await backend.create(spec);

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.execWorkloadExitCode = 0;
    seeded.execWorkloadFastExitStopsSandbox = true;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    await backend.start(handle); // must not throw

    const internal = (backend as unknown as { handles: Map<string, { attached: unknown }> }).handles.get(handle.id);
    assert.equal(
      internal?.attached,
      undefined,
      "expected no live child left to hold onto for a completed fast exit — same as bootRunOnce's own fast-exit branch",
    );

    const started = (backend as unknown as { startedNames: Set<string> }).startedNames;
    assert.equal(started.has(handle.id), true, "expected the fast-exit-completed sandbox to still be registered as started");

    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("start() on a checkpointRef spec classifies a nonzero msb restore exit as a boot failure carrying the output", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-restore-failexit", { checkpointRef: "/fake/checkpoints/snap_baadf00d" });
    const handle = await backend.create(spec);

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failRestoreWithGenericError = 1;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    let thrown: unknown;
    try {
      await backend.start(handle);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof BackendError, `expected BackendError, got: ${String(thrown)}`);
    assert.match((thrown as Error).message, /exited \(code 1\)/);
    assert.match(
      (thrown as Error).message,
      /destination disk is full/,
      "expected the failed restore process's own output to be surfaced verbatim",
    );

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as { sandboxes: Record<string, unknown> };
    assert.equal(
      handle.id in state.sandboxes,
      false,
      "expected a failed restore activation to never have registered a sandbox",
    );

    await backend.remove(handle);
  });

  it("start() on a checkpointRef spec fails fast — not a hang — when the sandbox settles as Stopped instead of ever reaching Running", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-restore-neverrunning", { checkpointRef: "/fake/checkpoints/snap_c0ffee" });
    const handle = await backend.create(spec);

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.restoreSettlesAsStopped = true;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    const startedAt = Date.now();
    let thrown: unknown;
    try {
      await backend.start(handle);
    } catch (err) {
      thrown = err;
    }
    const elapsedMs = Date.now() - startedAt;

    assert.ok(thrown instanceof BackendError, `expected BackendError, got: ${String(thrown)}`);
    assert.match(
      (thrown as Error).message,
      /settled as 'Stopped'/,
      "expected the Stopped fast-fail message, not a generic timeout — a settled Stopped state must never " +
        "be waited out for the rest of the readiness budget",
    );
    assert.match(
      (thrown as Error).message,
      /background boot never completed/,
      "expected the 'msb logs --source system' diagnostics to be surfaced",
    );
    assert.ok(
      elapsedMs < 5000,
      `expected the Stopped fast-fail to short-circuit well under the full readiness budget, took ${elapsedMs}ms — this is the "not a hang" guarantee`,
    );

    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("createCheckpoint leaves the sandbox stopped when the snapshot step fails, without removing or rebooting it", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-ckpt-fail");
    const handle = await backend.create(spec);
    await backend.start(handle);

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failSnapshotCreate = 1;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    let thrown: unknown;
    try {
      await backend.createCheckpoint(handle, "rz-ckpt-willfail");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof BackendError, `expected BackendError, got: ${String(thrown)}`);
    assert.match((thrown as Error).message, /rz-ckpt-willfail/);
    assert.match(
      (thrown as Error).message,
      /msb start rz-testrun1-ckpt-fail/,
      "expected the by-hand remedy to be named",
    );

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      sandboxes: Record<string, { status: string }>;
      callLog: Array<{ cmd: string }>;
    };
    assert.equal(
      state.sandboxes[handle.id]?.status,
      "Stopped",
      "expected the sandbox to be left stopped rather than restarted",
    );
    const snapshotAttemptIdx = state.callLog.findIndex((c) => c.cmd === "snapshotCreate");
    assert.ok(snapshotAttemptIdx !== -1, "expected the snapshot create attempt to have been logged");
    assert.deepEqual(
      state.callLog.slice(snapshotAttemptIdx + 1),
      [],
      "expected no rm or run after a failed snapshot create — no best-effort restart",
    );

    await backend.remove(handle);
  });

  it("createCheckpoint throws a clear BackendError quoting the raw output when msb snapshot create's stdout doesn't end in a recognizable artifact path", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-ckpt-badoutput");
    const handle = await backend.create(spec);
    await backend.start(handle);

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failSnapshotCreateBadOutput = 1;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    let thrown: unknown;
    try {
      await backend.createCheckpoint(handle, "rz-ckpt-badoutput");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof BackendError, `expected BackendError, got: ${String(thrown)}`);
    assert.match(
      (thrown as Error).message,
      /did not print a recognizable artifact path/,
      "expected a clear, defensive parse-failure message",
    );
    assert.match(
      (thrown as Error).message,
      /not-an-absolute-path/,
      "expected the raw, unparsed msb output to be quoted verbatim",
    );

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      sandboxes: Record<string, { status: string }>;
    };
    assert.equal(
      state.sandboxes[handle.id]?.status,
      "Stopped",
      "expected the sandbox to be left stopped rather than restarted, same as an ordinary snapshot-create failure",
    );

    await backend.remove(handle);
  });

  it("createCheckpoint throws a typed error naming the checkpoint ref when the post-snapshot reboot fails", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-ckpt-rebootfail");
    const handle = await backend.create(spec);
    await backend.start(handle);

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    // Two consecutive failures, not one: the reboot goes through the same
    // classified-transient retries as any boot, so a single state-db error
    // is absorbed by design — the typed reboot failure only surfaces once
    // the retry is exhausted too.
    seeded.failRunsWithStateDbError = 2;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    let thrown: unknown;
    try {
      await backend.createCheckpoint(handle, "rz-ckpt-rebootwillfail");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof BackendError, `expected BackendError, got: ${String(thrown)}`);
    assert.match(
      (thrown as Error).message,
      /fromCheckpoint/,
      "expected the error to name fromCheckpoint() as the recovery path",
    );

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      sandboxes: Record<string, unknown>;
      snapshots: Record<string, { from: string }>;
    };
    // The reboot failed AFTER a successful snapshot create, so the thrown
    // error names the DISCOVERED artifact ref (never predictable ahead of
    // time — see createCheckpoint's own doc) — recovered here from the
    // fixture's own state rather than hard-coded.
    const createdRef = Object.keys(state.snapshots).find((ref) => state.snapshots[ref]?.from === handle.id);
    assert.ok(createdRef !== undefined, "expected the snapshot to have been created before the reboot failed");
    assert.ok(
      (thrown as Error).message.includes(createdRef as string),
      `expected the error to name the checkpoint ref '${createdRef}', got: ${(thrown as Error).message}`,
    );
    assert.equal(
      handle.id in state.sandboxes,
      false,
      "expected the sandbox to already have been removed by the time the reboot failed",
    );

    await backend.remove(handle);
    await backend.removeCheckpoint(createdRef as string);
  });

  it("removeCheckpoint is a best-effort msb snapshot rm -f, silent on a ref that never existed", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-ckpt-rm", { command: ["sleep", "60"] });
    const handle = await backend.create(spec);
    await backend.start(handle);
    const effectiveRef = await backend.createCheckpoint(handle, "rz-ckpt-toremove");

    await backend.removeCheckpoint(effectiveRef);
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as { snapshots?: Record<string, unknown> };
    assert.equal(effectiveRef in (state.snapshots ?? {}), false);

    await backend.removeCheckpoint(path.join(path.dirname(effectiveRef), "snap_never0000000000000000000000000"));

    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("removeCheckpoint propagates msb's head-removal refusal rather than swallowing it alongside 'not found'", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-ckpt-rm-head", { command: ["sleep", "60"] });
    const handle = await backend.create(spec);
    await backend.start(handle);
    const effectiveRef = await backend.createCheckpoint(handle, "rz-ckpt-head");

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failSnapshotRmWithHeadRefusal = 1;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    let thrown: unknown;
    try {
      await backend.removeCheckpoint(effectiveRef);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof BackendError, `expected BackendError, got: ${String(thrown)}`);
    assert.match((thrown as Error).message, /cannot remove current head/);

    // Never swallowed into a silent no-op: the artifact is still there.
    assert.equal(await backend.hasCheckpoint(effectiveRef), true, "expected the refused removal to have left the artifact intact");

    await backend.removeCheckpoint(effectiveRef);
    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("hasCheckpoint on a path ref checks the filesystem directly, never through msb: true only once snapshot.json exists", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-msb-pathref-has-test-"));
    try {
      const ref = path.join(dir, "rz-ckpt-fsonly");
      assert.equal(await backend.hasCheckpoint(ref), false, "expected a nonexistent artifact dir to resolve false");

      await fs.mkdir(ref, { recursive: true });
      assert.equal(await backend.hasCheckpoint(ref), false, "expected a dir without snapshot.json to still resolve false");

      await fs.writeFile(path.join(ref, "snapshot.json"), "{}");
      assert.equal(await backend.hasCheckpoint(ref), true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("removeCheckpoint on a path ref runs msb snapshot rm with the FULL artifact path (never just the basename) plus -f, then clears any leftover artifact directory", async () => {
    if (skipOnWindows()) {
      return;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-msb-pathref-remove-test-"));
    try {
      const ref = path.join(dir, "snap_abcdef0123456789abcdef0123456789");
      await fs.mkdir(ref, { recursive: true });
      await fs.writeFile(path.join(ref, "snapshot.json"), "{}");

      await backend.removeCheckpoint(ref);

      const state = JSON.parse(await fs.readFile(statePath, "utf8")) as { callLog: Array<{ cmd: string; args: string[] }> };
      const rmCall = state.callLog.filter((c) => c.cmd === "snapshotRemove").at(-1);
      assert.deepEqual(
        rmCall?.args,
        ["snapshot", "rm", ref, "-f"],
        "expected the full artifact path and -f — name-based removal does not resolve on msb 0.7.1",
      );

      await assert.rejects(fs.access(ref), "expected the leftover artifact directory to have been removed");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("removeCheckpoint never recursively deletes a path ref that doesn't look like a checkpoint artifact it wrote", async () => {
    if (skipOnWindows()) {
      return;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-msb-corrupt-ref-remove-test-"));
    try {
      // A corrupt/attacker-controlled ref: some arbitrary POPULATED directory
      // handed to removeCheckpoint as if it were a checkpoint artifact, but
      // it neither carries the snap_<hex> basename msb's own snapshot store
      // uses nor contains a snapshot.json — nothing this backend itself ever
      // wrote.
      const wrongPrefixRef = path.join(dir, "not-a-checkpoint-at-all");
      await fs.mkdir(wrongPrefixRef, { recursive: true });
      await fs.writeFile(path.join(wrongPrefixRef, "important.txt"), "do not delete me");

      await backend.removeCheckpoint(wrongPrefixRef);

      const wrongPrefixSurvived = await fs
        .access(path.join(wrongPrefixRef, "important.txt"))
        .then(() => true)
        .catch(() => false);
      assert.equal(wrongPrefixSurvived, true, "expected a non-snap_<hex>-basename directory to be left untouched");

      // Same guard, other half: the snap_<hex> basename shape alone isn't
      // enough — a directory under that name with no snapshot.json is just
      // as unverified (e.g. a stale/tampered registry entry pointing at a
      // directory this backend never actually wrote an artifact into).
      const noManifestRef = path.join(dir, "snap_deadbeefdeadbeefdeadbeefdeadbeef");
      await fs.mkdir(noManifestRef, { recursive: true });
      await fs.writeFile(path.join(noManifestRef, "important.txt"), "do not delete me either");

      await backend.removeCheckpoint(noManifestRef);

      const noManifestSurvived = await fs
        .access(path.join(noManifestRef, "important.txt"))
        .then(() => true)
        .catch(() => false);
      assert.equal(noManifestSurvived, true, "expected a snap_<hex> dir with no snapshot.json to be left untouched");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("hasCheckpoint (bare-name ref) resolves true for a snapshot the msb index carries and false for one it doesn't", async () => {
    if (skipOnWindows()) {
      return;
    }
    // A bare-name ref never comes out of createCheckpoint on msb 0.7.1 (its
    // effective ref is always an absolute artifact path — see
    // parseSnapshotCreateArtifactPath), so this exercises hasCheckpoint's
    // bare-name/msb-inspect branch directly by seeding the fixture's own
    // index, independent of createCheckpoint — the same way a caller-
    // supplied non-path ref would reach this branch.
    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.snapshots = { "rz-ckpt-exists": { from: "some-sandbox" } };
    await fs.writeFile(statePath, JSON.stringify(seeded));

    assert.equal(await backend.hasCheckpoint("rz-ckpt-exists"), true);
    assert.equal(await backend.hasCheckpoint("rz-ckpt-never-existed"), false);

    await backend.removeCheckpoint("rz-ckpt-exists");
    assert.equal(await backend.hasCheckpoint("rz-ckpt-exists"), false, "expected hasCheckpoint to reflect a removed snapshot as absent");
  });

  it("hasCheckpoint (bare-name ref) throws instead of resolving false when msb fails for a reason other than 'snapshot not found'", async () => {
    if (skipOnWindows()) {
      return;
    }
    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.snapshots = { "rz-ckpt-probeerr": { from: "some-sandbox" } };
    seeded.failSnapshotInspectWithError = 1;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    let thrown: unknown;
    try {
      await backend.hasCheckpoint("rz-ckpt-probeerr");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof BackendError, `expected BackendError, got: ${String(thrown)}`);
    assert.match((thrown as Error).message, /rz-ckpt-probeerr/);
    assert.match(
      (thrown as Error).message,
      /database error/,
      "expected the raw msb stderr to be carried in the thrown error, not collapsed to a bare false",
    );

    // Confirms the failure was genuinely swallowed by neither this call nor
    // a later one — the snapshot itself is untouched and still inspects true
    // once the demand-flag is spent.
    assert.equal(await backend.hasCheckpoint("rz-ckpt-probeerr"), true);
  });

  it("exportCheckpoint drives msb snapshot save <ref> <dest>, writing the payload file", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-ckpt-export", { command: ["sleep", "60"] });
    const handle = await backend.create(spec);
    await backend.start(handle);
    const effectiveRef = await backend.createCheckpoint(handle, "rz-ckpt-toexport");

    const dest = path.join(os.tmpdir(), `rightsize-msb-export-test-${Date.now()}.artifact`);
    try {
      await backend.exportCheckpoint(effectiveRef, dest);
      const content = await fs.readFile(dest, "utf8");
      assert.equal(content, `fake-msb-artifact-for:${effectiveRef}`);

      const state = JSON.parse(await fs.readFile(statePath, "utf8")) as { callLog: Array<{ cmd: string; args: string[] }> };
      const exportCall = state.callLog.find((c) => c.cmd === "snapshotExport");
      assert.deepEqual(exportCall?.args, ["snapshot", "save", effectiveRef, dest]);
    } finally {
      await fs.rm(dest, { force: true });
    }

    await backend.removeCheckpoint(effectiveRef);
    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("exportCheckpoint surfaces msb's own stderr for a ref that does not exist", async () => {
    if (skipOnWindows()) {
      return;
    }
    const dest = path.join(os.tmpdir(), `rightsize-msb-export-missing-test-${Date.now()}.artifact`);
    let thrown: unknown;
    try {
      await backend.exportCheckpoint("rz-ckpt-never-existed", dest);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof BackendError, `expected BackendError, got: ${String(thrown)}`);
    assert.match((thrown as Error).message, /rz-ckpt-never-existed/);
  });

  it("exportCheckpoint does not salvage a staging file when the failure is not msb's Windows fsync bug", async () => {
    if (skipOnWindows()) {
      return;
    }
    // A staging file shaped exactly like the one msb leaves behind when its
    // read-only fsync fails on Windows (see snapshot-save-fsync.ts), but a
    // failure that has nothing to do with that bug. The salvage must not fire:
    // msb's own error is what the caller needs, and the destination must not
    // be conjured out of a file this export did not write.
    //
    // On this host it is the `process.platform === "win32"` gate that decides
    // the outcome — the predicate and the salvage are never reached. What the
    // salvage itself does with a non-matching failure is pinned directly, and
    // platform-independently, by snapshot-save-fsync.test.ts.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-msb-export-nosalvage-test-"));
    try {
      const dest = path.join(dir, "artifact");
      const staged = path.join(dir, ".artifact.tmp.8980.1785507050813959600");
      await fs.writeFile(staged, "leftover-bytes");

      let thrown: unknown;
      try {
        await backend.exportCheckpoint("rz-ckpt-never-existed", dest);
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof BackendError, `expected BackendError, got: ${String(thrown)}`);
      assert.match((thrown as Error).message, /snapshot not found/);
      assert.deepEqual(await fs.readdir(dir), [path.basename(staged)]);
      assert.equal(await fs.readFile(staged, "utf8"), "leftover-bytes");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("importCheckpoint resolves the effective ref via the loaded artifact path msb's own 'snapshot load' prints, treating a re-import of the same bytes as success", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-ckpt-import", { command: ["sleep", "60"] });
    const handle = await backend.create(spec);
    await backend.start(handle);
    const checkpointRef = await backend.createCheckpoint(handle, "rz-ckpt-toimport");

    const artifactPath = path.join(os.tmpdir(), `rightsize-msb-import-test-${Date.now()}.artifact`);
    await backend.exportCheckpoint(checkpointRef, artifactPath);

    try {
      const effectiveRef = await backend.importCheckpoint(artifactPath, checkpointRef);
      // The loaded artifact path, not a bare digest-dir name: absolute,
      // nested under this backend's own checkpoints cache directory (never
      // msb's global default store — see MsbCommands.snapshotImport's own
      // doc on why --dest is always passed), basename shaped like any other
      // snapshot artifact.
      assert.ok(path.isAbsolute(effectiveRef), `expected an absolute path ref, got ${effectiveRef}`);
      assert.equal(path.dirname(path.dirname(effectiveRef)), path.join(cacheDir(), "checkpoints"));
      assert.match(path.basename(effectiveRef), /^snap_[0-9a-f]+$/i);
      assert.ok(effectiveRef !== checkpointRef, "expected the imported ref to be distinct from the original snapshot's own ref");

      // The exact regression this backend once had (pre-0.7.1): importCheckpoint
      // returning a ref `hasCheckpoint` could not actually probe (msb's full
      // `sha256:<64hex>` digest, which never resolves as a snapshot ref).
      // Asserting hasCheckpoint(effectiveRef) here pins that the returned
      // ref is one the backend can actually probe — now via a plain
      // filesystem check, since it is a path ref.
      assert.equal(await backend.hasCheckpoint(effectiveRef), true);

      // Re-importing the SAME bytes hits msb's own already-exists path
      // (content-addressed dedup) and must resolve to the SAME artifact
      // path, not throw — that's success, not failure, for identical content.
      const secondRef = await backend.importCheckpoint(artifactPath, checkpointRef);
      assert.equal(secondRef, effectiveRef);
    } finally {
      await fs.rm(artifactPath, { force: true });
    }

    await backend.removeCheckpoint(checkpointRef);
    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("importCheckpoint surfaces msb's own stderr for a non-already-exists failure", async () => {
    if (skipOnWindows()) {
      return;
    }
    const artifactPath = path.join(os.tmpdir(), `rightsize-msb-import-fail-test-${Date.now()}.artifact`);
    await fs.writeFile(artifactPath, "some-bytes");
    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failSnapshotImportWithError = 1;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    let thrown: unknown;
    try {
      await backend.importCheckpoint(artifactPath, "unused-ref");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof BackendError, `expected BackendError, got: ${String(thrown)}`);
    assert.match((thrown as Error).message, /database error/);

    await fs.rm(artifactPath, { force: true });
  });

  it("importCheckpoint throws a clear, red-proof error when msb's load output has no recognizable artifact path", async () => {
    if (skipOnWindows()) {
      return;
    }
    // Reproduces the exact shape that broke the pre-0.7.1 locate-via-list
    // logic: msb's own "group ... (Initialized)" status line with no
    // trailing absolute path — see fake-msb.mjs's failSnapshotImportBadOutput
    // knob and parseImportedArtifactPath's own doc.
    const artifactPath = path.join(os.tmpdir(), `rightsize-msb-import-badoutput-test-${Date.now()}.artifact`);
    await fs.writeFile(artifactPath, "some-bytes-for-bad-output-case");
    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failSnapshotImportBadOutput = 1;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    let thrown: unknown;
    try {
      await backend.importCheckpoint(artifactPath, "unused-ref");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof BackendError, `expected BackendError, got: ${String(thrown)}`);
    assert.match(
      (thrown as Error).message,
      /did not print a recognizable artifact path/,
      "expected a clear, actionable message rather than a misread ref or a crash",
    );
    assert.match((thrown as Error).message, /Initialized/, "expected the raw, unparsed msb output quoted verbatim");

    await fs.rm(artifactPath, { force: true });
  });

  it("copyToContainer invokes msb copy -q <hostPath> <name>:<containerPath>", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-copyin");
    const handle = await backend.create(spec);
    await backend.start(handle);

    await backend.copyToContainer(handle, "/host/data.txt", "/guest/data.txt");

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as { copyCalls: string[][] };
    assert.deepEqual(state.copyCalls, [["/host/data.txt", `${handle.id}:/guest/data.txt`]]);

    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("copyFromContainer invokes msb copy -q <name>:<containerPath> <hostPath>", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-copyout");
    const handle = await backend.create(spec);
    await backend.start(handle);

    await backend.copyFromContainer(handle, "/guest/data.txt", "/host/data.txt");

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as { copyCalls: string[][] };
    assert.deepEqual(state.copyCalls, [[`${handle.id}:/guest/data.txt`, "/host/data.txt"]]);

    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("a failed copy surfaces the tool's stderr in a BackendError", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-copyfail");
    const handle = await backend.create(spec);
    await backend.start(handle);

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failCopyWithError = 1;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    let thrown: unknown;
    try {
      await backend.copyToContainer(handle, "/host/missing.txt", "/guest/data.txt");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof BackendError, `expected BackendError, got: ${String(thrown)}`);
    assert.match((thrown as Error).message, /no such file or directory/);

    await backend.stop(handle);
    await backend.remove(handle);
  });
});

describe("MsbCliBackend.capabilities", () => {
  it("each sandbox is its own microVM: hardwareIsolated true, checkpoint true (disk snapshot), checkpointRestartsWorkload true", () => {
    // A property check needs no provisioned msb binary at all — never awaits
    // the promise it's constructed with.
    const backend = new MsbCliBackend(Promise.resolve("/unused/msb"));
    assert.deepEqual(backend.capabilities, { hardwareIsolated: true, checkpoint: true, checkpointRestartsWorkload: true });
  });
});

// POLICY v2: the Windows job-free restore broker escalation
// (`rebootUnderFreshName`/`retryRestoreAfterAccessDenied`'s own
// `RestoreLaunchMode` dispatch — see backend.ts's own doc and
// restore-broker.ts's module doc on the Windows job-object root cause this
// exists for). Own describe block, own beforeEach, rather than reusing the
// outer suite's — these tests each construct their OWN `MsbCliBackend` (to
// inject a stubbed `restoreBroker` per test), so there is no shared
// `backend` instance to hang off of, only the same fake-msb-double
// plumbing (statePath/cacheDir env) the outer suite's own beforeEach sets
// up identically.
describe("MsbCliBackend's Windows job-free restore broker escalation (POLICY v2)", () => {
  let statePath: string;

  beforeEach(async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-msb-broker-test-"));
    statePath = path.join(tmpDir, "state.json");
    await fs.writeFile(statePath, JSON.stringify({ sandboxes: {} }));
    process.env["RIGHTSIZE_FAKE_MSB_STATE"] = statePath;
    process.env["RIGHTSIZE_CACHE_DIR"] = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-msb-broker-cache-test-"));
  });

  after(async () => {
    delete process.env["RIGHTSIZE_FAKE_MSB_STATE"];
    delete process.env["RIGHTSIZE_CACHE_DIR"];
  });

  // Mirrors the outer suite's own skip: fake-msb-wrapper.sh is a POSIX `sh`
  // script spawned directly, which fails structurally (EFTYPE) on a native
  // Windows runner independent of anything the escalation logic itself
  // does — see that suite's own doc on `skipOnWindows`. These tests force
  // `isWindowsPlatform()` true via the seam below instead, which is what
  // actually exercises the escalation on any host.
  function skipOnWindows(): boolean {
    return process.platform === "win32";
  }

  function forcePlatform(backend: MsbCliBackend, platform: NodeJS.Platform): void {
    (backend as unknown as { platformOverrideForTests: NodeJS.Platform }).platformOverrideForTests = platform;
  }

  /**
   * A `RestoreBrokerLauncher` that performs the REAL restore against the
   * same fake msb double a direct attempt would spawn (via `invoke`,
   * exactly the way `realRestoreBroker`'s own WMI-launched process would
   * eventually reach a real `msb.exe`), and reports back its real exit
   * code/combined output — so a test can drive the exact same fixture
   * failure knobs (`failRestoreWithAccessDenied`, `failRestoresWithAlreadyExists`,
   * ...) through the BROKERED path that the existing suite already drives
   * through the direct one, proving brokered-output classification against
   * real classified text rather than a hand-typed fake. `calls` records
   * every argv this launcher was actually invoked with, for a test to
   * assert against directly (attempt count, the exact fresh name targeted,
   * argv shape).
   */
  function passthroughBroker(calls: Array<{ argv: readonly string[] }>): RestoreBrokerLauncher {
    return async (msbPath, argv, timeoutMs) => {
      calls.push({ argv });
      const result = await invoke(msbPath, argv, timeoutMs);
      const output = result.stderr.length > 0 ? `${result.stdout}\n${result.stderr}` : result.stdout;
      return { kind: "completed", exitCode: result.exitCode, output };
    };
  }

  it("retryRestoreAfterAccessDenied escalates to the broker only after its always-direct first attempt hits Windows access-denied, and the brokered attempt's own argv matches a direct restore's shape", async () => {
    if (skipOnWindows()) {
      return;
    }
    const brokerCalls: Array<{ argv: readonly string[] }> = [];
    const backend = new MsbCliBackend(Promise.resolve(FAKE_MSB), { restoreBroker: passthroughBroker(brokerCalls) });
    forcePlatform(backend, "win32");

    const spec = baseSpec("rz-testrun1-broker-trigger", {
      checkpointRef: "/fake/checkpoints/snap_brokertrigger",
      command: ["sleep", "60"],
    });
    const handle = await backend.create(spec);
    const originalName = handle.id;

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failRestoreWithAccessDenied = 1;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    await backend.start(handle);
    const freshName = handle.id;

    assert.ok(freshName !== originalName, "expected the retry to mint a fresh sandbox name");
    assert.equal(brokerCalls.length, 1, "expected exactly one brokered attempt — the retry after the always-direct first one");
    const brokeredCall = brokerCalls[0];
    assert.ok(brokeredCall !== undefined, "expected the recorded brokered call to exist");
    assert.equal(brokeredCall?.argv[0], "restore", "expected the brokered attempt's argv to be an ordinary restore invocation");
    const nameIdx = brokeredCall?.argv.indexOf("--name") ?? -1;
    assert.equal(
      brokeredCall?.argv[nameIdx + 1],
      freshName,
      "expected the brokered attempt's own argv to target the winning fresh name",
    );

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      sandboxes: Record<string, { status: string }>;
      callLog: Array<{ cmd: string; args: string[] }>;
    };
    assert.equal(state.sandboxes[freshName]?.status, "Running");
    const restoreCalls = state.callLog.filter((c) => c.cmd === "restore");
    assert.equal(restoreCalls.length, 2, "expected the direct first attempt plus exactly one brokered retry");

    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("rebootUnderFreshName (createCheckpoint's own reboot) escalates to the broker the same way, after its own always-direct first attempt", async () => {
    if (skipOnWindows()) {
      return;
    }
    const brokerCalls: Array<{ argv: readonly string[] }> = [];
    const backend = new MsbCliBackend(Promise.resolve(FAKE_MSB), { restoreBroker: passthroughBroker(brokerCalls) });
    forcePlatform(backend, "win32");

    const spec = baseSpec("rz-testrun1-broker-ckpt-trigger", { command: ["sleep", "60"] });
    const handle = await backend.create(spec);
    await backend.start(handle);
    const originalName = handle.id;

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failRestoreWithAccessDenied = 1;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    await backend.createCheckpoint(handle, "rz-ckpt-broker-trigger1");
    const freshName = handle.id;

    assert.ok(freshName !== originalName, "expected a fresh name even on a checkpoint whose reboot escalated to the broker");
    assert.equal(brokerCalls.length, 1, "expected exactly one brokered attempt — the retry after the always-direct first one");
    const brokeredCall = brokerCalls[0];
    assert.ok(brokeredCall !== undefined, "expected the recorded brokered call to exist");
    const nameIdx = brokeredCall?.argv.indexOf("--name") ?? -1;
    assert.equal(brokeredCall?.argv[nameIdx + 1], freshName);

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      sandboxes: Record<string, { status: string }>;
      callLog: Array<{ cmd: string; args: string[] }>;
    };
    assert.equal(state.sandboxes[freshName]?.status, "Running");
    const restoreCalls = state.callLog.filter((c) => c.cmd === "restore");
    assert.equal(restoreCalls.length, 2);

    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("once escalated, a brokered 'already exists' refusal is retried under yet another fresh name, still brokered — never downgrading back to direct", async () => {
    if (skipOnWindows()) {
      return;
    }
    const brokerCalls: Array<{ argv: readonly string[] }> = [];
    const backend = new MsbCliBackend(Promise.resolve(FAKE_MSB), { restoreBroker: passthroughBroker(brokerCalls) });
    forcePlatform(backend, "win32");
    const seam = backend as unknown as {
      checkpointRebootAlreadyExistsRetryBudgetMs: number;
      checkpointRebootAlreadyExistsRetryDelayMs: number;
    };
    seam.checkpointRebootAlreadyExistsRetryBudgetMs = 5_000;
    seam.checkpointRebootAlreadyExistsRetryDelayMs = 20;

    const spec = baseSpec("rz-testrun1-broker-ckpt-alreadyexists", { command: ["sleep", "60"] });
    const handle = await backend.create(spec);
    await backend.start(handle);

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    // attempt 1 (direct) hits access-denied — triggers the escalation.
    seeded.failRestoreWithAccessDenied = 1;
    // attempts 2 and 3 (both now brokered) hit "already exists"; attempt 4
    // (still brokered) succeeds.
    seeded.failRestoresWithAlreadyExists = 2;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    await backend.createCheckpoint(handle, "rz-ckpt-broker-alreadyexists1");
    const freshName = handle.id;

    assert.equal(brokerCalls.length, 3, "expected 3 brokered attempts: the 2 'already exists' failures plus the succeeding one");
    assert.equal(
      new Set(brokerCalls.map((c) => c.argv[c.argv.indexOf("--name") + 1])).size,
      3,
      "expected every brokered attempt to target its own freshly minted name",
    );

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      sandboxes: Record<string, { status: string }>;
      callLog: Array<{ cmd: string; args: string[] }>;
    };
    assert.equal(state.sandboxes[freshName]?.status, "Running");
    const restoreCalls = state.callLog.filter((c) => c.cmd === "restore");
    assert.equal(restoreCalls.length, 4, "expected the direct first attempt plus the 3 brokered attempts");

    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("a brokered attempt that itself hits Windows access-denied again is retried under a fresh name, still brokered", async () => {
    if (skipOnWindows()) {
      return;
    }
    const brokerCalls: Array<{ argv: readonly string[] }> = [];
    const backend = new MsbCliBackend(Promise.resolve(FAKE_MSB), { restoreBroker: passthroughBroker(brokerCalls) });
    forcePlatform(backend, "win32");

    const spec = baseSpec("rz-testrun1-broker-accessdenied-again", {
      checkpointRef: "/fake/checkpoints/snap_brokeraccessdeniedagain",
      command: ["sleep", "60"],
    });
    const handle = await backend.create(spec);
    const originalName = handle.id;

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    // attempt 1 (direct) and attempt 2 (brokered, after escalation) both hit
    // access-denied; attempt 3 (still brokered) succeeds.
    seeded.failRestoreWithAccessDenied = 2;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    await backend.start(handle);
    const freshName = handle.id;

    assert.ok(freshName !== originalName);
    assert.equal(brokerCalls.length, 2, "expected 2 brokered attempts: the access-denied-again failure plus the succeeding retry");

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      sandboxes: Record<string, { status: string }>;
      callLog: Array<{ cmd: string; args: string[] }>;
    };
    assert.equal(state.sandboxes[freshName]?.status, "Running");
    const restoreCalls = state.callLog.filter((c) => c.cmd === "restore");
    assert.equal(restoreCalls.length, 3, "expected the direct first attempt plus the 2 brokered attempts");

    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("a brokered 'unconfirmed' outcome (its own exit-code file never read back) still succeeds once the ls-poll phase confirms Running", async () => {
    if (skipOnWindows()) {
      return;
    }
    const brokerCalls: Array<{ argv: readonly string[] }> = [];
    const unconfirmedBroker: RestoreBrokerLauncher = async (msbPath, argv, timeoutMs) => {
      brokerCalls.push({ argv });
      // Performs the REAL restore as a side effect — exactly what a real
      // WMI-launched process would do — but deliberately reports
      // "unconfirmed" regardless of that real outcome, exercising
      // bootRestoreOnce's own "fall through to the ls-poll phase instead of
      // guessing" branch (see RestoreBrokerUnconfirmed's own doc).
      await invoke(msbPath, argv, timeoutMs);
      return { kind: "unconfirmed" };
    };
    const backend = new MsbCliBackend(Promise.resolve(FAKE_MSB), { restoreBroker: unconfirmedBroker });
    forcePlatform(backend, "win32");

    const spec = baseSpec("rz-testrun1-broker-unconfirmed", {
      checkpointRef: "/fake/checkpoints/snap_brokerunconfirmed",
      command: ["sleep", "60"],
    });
    const handle = await backend.create(spec);
    const originalName = handle.id;

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failRestoreWithAccessDenied = 1;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    await backend.start(handle);
    const freshName = handle.id;

    assert.ok(freshName !== originalName);
    assert.equal(brokerCalls.length, 1, "expected exactly one brokered (unconfirmed) attempt");

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as { sandboxes: Record<string, { status: string }> };
    assert.equal(
      state.sandboxes[freshName]?.status,
      "Running",
      "expected the ls-poll phase to confirm Running despite the broker's own unconfirmed report",
    );

    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("falls back to a direct attempt for that one retry when the real broker's own infrastructure fails (no powershell.exe on this host)", async () => {
    if (skipOnWindows()) {
      return;
    }
    // No `restoreBroker` override: exercises the REAL `realRestoreBroker`
    // default. This suite's own outer skip guarantees this test never runs
    // on an actual Windows host, so `powershell.exe` genuinely does not
    // exist on PATH here — `realRestoreBroker`'s own spawn fails with
    // ENOENT, which is exactly the "broker infrastructure failure" this
    // test means to exercise, through real production code rather than a
    // stub.
    const backend = new MsbCliBackend(Promise.resolve(FAKE_MSB));
    forcePlatform(backend, "win32");

    const spec = baseSpec("rz-testrun1-broker-infra-fallback", {
      checkpointRef: "/fake/checkpoints/snap_brokerinfra",
      command: ["sleep", "60"],
    });
    const handle = await backend.create(spec);
    const originalName = handle.id;

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failRestoreWithAccessDenied = 1;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    await backend.start(handle);
    const freshName = handle.id;

    assert.ok(freshName !== originalName);

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      sandboxes: Record<string, { status: string }>;
      callLog: Array<{ cmd: string; args: string[] }>;
    };
    assert.equal(state.sandboxes[freshName]?.status, "Running", "expected the direct fallback to have succeeded");
    const restoreCalls = state.callLog.filter((c) => c.cmd === "restore");
    assert.equal(
      restoreCalls.length,
      2,
      "expected the direct first attempt plus a direct-fallback retry — never a third attempt, since the " +
        "fallback itself succeeded",
    );

    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("never escalates to the broker on a non-Windows host, even after a classified access-denied hit", async () => {
    if (skipOnWindows()) {
      return;
    }
    const brokerCalls: Array<{ argv: readonly string[] }> = [];
    const backend = new MsbCliBackend(Promise.resolve(FAKE_MSB), { restoreBroker: passthroughBroker(brokerCalls) });
    // Explicit, even though it matches this dev/CI host's own default
    // platform — the point is that the escalation gate itself must read
    // "not Windows" and never call the broker seam at all, not merely that
    // nobody happened to flip it to "win32" here.
    forcePlatform(backend, "linux");

    const spec = baseSpec("rz-testrun1-broker-nonwindows", {
      checkpointRef: "/fake/checkpoints/snap_brokernonwindows",
      command: ["sleep", "60"],
    });
    const handle = await backend.create(spec);
    const originalName = handle.id;

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failRestoreWithAccessDenied = 1;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    await backend.start(handle);
    const freshName = handle.id;

    assert.ok(freshName !== originalName, "expected the ordinary fresh-name retry to still happen");
    assert.equal(brokerCalls.length, 0, "expected the broker seam to never be called on a non-Windows host");

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      sandboxes: Record<string, { status: string }>;
      callLog: Array<{ cmd: string; args: string[] }>;
    };
    assert.equal(state.sandboxes[freshName]?.status, "Running");
    const restoreCalls = state.callLog.filter((c) => c.cmd === "restore");
    assert.equal(restoreCalls.length, 2);

    await backend.stop(handle);
    await backend.remove(handle);
  });
});
