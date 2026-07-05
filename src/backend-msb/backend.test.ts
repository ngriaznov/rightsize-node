import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, assert, after, beforeEach } from "../../test/harness.js";
import { MsbCliBackend } from "./backend.js";
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
});
