import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, assert, after, beforeEach } from "../../test/harness.js";
import { MsbCliBackend } from "./backend.js";
import { UnsupportedByBackendError } from "../core/errors.js";
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
});

describe("MsbCliBackend.capabilities", () => {
  it("each sandbox is its own microVM: hardwareIsolated true, checkpoint false", () => {
    // A property check needs no provisioned msb binary at all — never awaits
    // the promise it's constructed with.
    const backend = new MsbCliBackend(Promise.resolve("/unused/msb"));
    assert.deepEqual(backend.capabilities, { hardwareIsolated: true, checkpoint: false });
  });
});

describe("MsbCliBackend.commitToImage", () => {
  it("throws UnsupportedByBackendError defensively — unreachable via the generic layer, which gates on capabilities.checkpoint first", async () => {
    const backend = new MsbCliBackend(Promise.resolve("/unused/msb"));
    let thrown: unknown;
    try {
      await backend.commitToImage({ id: "fake-1", spec: baseSpec("fake-1") }, "rightsize/checkpoint:abcdef012345");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof UnsupportedByBackendError, `expected UnsupportedByBackendError, got: ${String(thrown)}`);
    assert.equal((thrown as UnsupportedByBackendError).backend, "microsandbox");
    assert.match((thrown as UnsupportedByBackendError).message, /docker/);
  });
});
