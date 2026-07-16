import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, assert, after, beforeEach } from "../../test/harness.js";
import { MsbCliBackend } from "./backend.js";
import { BackendError } from "../core/errors.js";
import type { ContainerSpec } from "../core/model.js";

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
    backend = new MsbCliBackend(Promise.resolve(FAKE_MSB));
  });

  after(async () => {
    delete process.env["RIGHTSIZE_FAKE_MSB_STATE"];
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

  it("createCheckpoint drives exactly stop -> snapshot create -> rm -> a reboot run from the snapshot, in order, leaving the sandbox Running", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-ckpt-1", {
      ports: [{ hostPort: 15999, guestPort: 80 }],
      env: [["FOO", "bar"]],
    });
    const handle = await backend.create(spec);
    await backend.start(handle);

    await backend.createCheckpoint(handle, "rz-ckpt-abcdef012345");

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      sandboxes: Record<string, { status: string }>;
      snapshots: Record<string, { from: string }>;
      callLog: Array<{ cmd: string; args: string[] }>;
    };
    assert.equal(state.snapshots["rz-ckpt-abcdef012345"]?.from, handle.id, "expected the snapshot recorded FROM this sandbox");
    assert.equal(state.sandboxes[handle.id]?.status, "Running", "expected the sandbox to be running again after the cycle");

    // The initial backend.start() above already logged its own "run" call;
    // only the last four calls belong to the checkpoint cycle itself.
    const cycle = state.callLog.slice(-4);
    assert.deepEqual(
      cycle.map((c) => c.cmd),
      ["stop", "snapshotCreate", "rm", "run"],
      "expected the checkpoint cycle to drive exactly stop -> snapshot create -> rm -> run, in order",
    );
    assert.deepEqual(
      cycle[3]?.args,
      ["run", "--name", handle.id, "-p", "15999:80", "-e", "FOO=bar", "--snapshot", "rz-ckpt-abcdef012345"],
      "expected the reboot's run to carry --snapshot <ref> plus every other flag from the original spec",
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

  it("createCheckpoint throws a typed error naming the checkpoint ref when the post-snapshot reboot fails", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-ckpt-rebootfail");
    const handle = await backend.create(spec);
    await backend.start(handle);

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
    seeded.failRunsWithStateDbError = 1;
    await fs.writeFile(statePath, JSON.stringify(seeded));

    let thrown: unknown;
    try {
      await backend.createCheckpoint(handle, "rz-ckpt-rebootwillfail");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof BackendError, `expected BackendError, got: ${String(thrown)}`);
    assert.match((thrown as Error).message, /rz-ckpt-rebootwillfail/, "expected the error to name the checkpoint ref");
    assert.match(
      (thrown as Error).message,
      /fromCheckpoint/,
      "expected the error to name fromCheckpoint() as the recovery path",
    );

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      sandboxes: Record<string, unknown>;
      snapshots: Record<string, { from: string }>;
    };
    assert.equal(
      state.snapshots["rz-ckpt-rebootwillfail"]?.from,
      handle.id,
      "expected the snapshot to have been created before the reboot failed",
    );
    assert.equal(
      handle.id in state.sandboxes,
      false,
      "expected the sandbox to already have been removed by the time the reboot failed",
    );

    await backend.remove(handle);
    await backend.removeCheckpoint("rz-ckpt-rebootwillfail");
  });

  it("removeCheckpoint is a best-effort msb snapshot rm, silent on a name that never existed", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-ckpt-rm");
    const handle = await backend.create(spec);
    await backend.start(handle);
    await backend.createCheckpoint(handle, "rz-ckpt-toremove");

    await backend.removeCheckpoint("rz-ckpt-toremove");
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as { snapshots?: Record<string, unknown> };
    assert.equal("rz-ckpt-toremove" in (state.snapshots ?? {}), false);

    await backend.removeCheckpoint("rz-ckpt-never-existed");

    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("hasCheckpoint resolves true for a snapshot that exists and false for one that doesn't", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-ckpt-inspect");
    const handle = await backend.create(spec);
    await backend.start(handle);
    await backend.createCheckpoint(handle, "rz-ckpt-exists");

    assert.equal(await backend.hasCheckpoint("rz-ckpt-exists"), true);
    assert.equal(await backend.hasCheckpoint("rz-ckpt-never-existed"), false);

    await backend.removeCheckpoint("rz-ckpt-exists");
    assert.equal(await backend.hasCheckpoint("rz-ckpt-exists"), false, "expected hasCheckpoint to reflect a removed snapshot as absent");

    await backend.stop(handle);
    await backend.remove(handle);
  });

  it("hasCheckpoint throws instead of resolving false when msb fails for a reason other than 'snapshot not found'", async () => {
    if (skipOnWindows()) {
      return;
    }
    const spec = baseSpec("rz-testrun1-ckpt-inspect-fail");
    const handle = await backend.create(spec);
    await backend.start(handle);
    await backend.createCheckpoint(handle, "rz-ckpt-probeerr");

    const seeded = JSON.parse(await fs.readFile(statePath, "utf8"));
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

    await backend.stop(handle);
    await backend.remove(handle);
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
