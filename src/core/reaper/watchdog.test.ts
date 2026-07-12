import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert, beforeEach, afterEach } from "../../../test/harness.js";
import { ensureWatchdogScript, spawnWatchdog, watchdogDir, watchdogScriptFilename, type ReaperKillCommand } from "./watchdog.js";

const RECORDER_ENV_KEY = "RIGHTSIZE_TEST_RECORDER_LOG";

const RECORDER_SCRIPT = `#!/bin/sh
printf '%s\\n' "$*" >> "$${RECORDER_ENV_KEY}"
`;

const DB_ERROR_RECORDER_SCRIPT = `#!/bin/sh
printf '%s\\n' "$*" >> "$${RECORDER_ENV_KEY}"
echo "error: database error: fake migration race"
`;

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content);
  await fs.chmod(filePath, 0o755);
}

async function readLog(logPath: string): Promise<string[]> {
  try {
    const text = await fs.readFile(logPath, "utf8");
    return text.split("\n").filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function waitForExit(child: import("node:child_process").ChildProcess): Promise<void> {
  return new Promise((resolveExit) => {
    child.once("exit", () => resolveExit());
  });
}

describe("watchdog (POSIX host only — Windows correctness is covered by the msb-windows integration lane)", () => {
  let cacheDir: string;
  let savedEnv: string | undefined;

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "rightsize-watchdog-test-"));
    savedEnv = process.env[RECORDER_ENV_KEY];
  });

  afterEach(async () => {
    if (savedEnv === undefined) {
      delete process.env[RECORDER_ENV_KEY];
    } else {
      process.env[RECORDER_ENV_KEY] = savedEnv;
    }
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it("ensureWatchdogScript writes an executable POSIX script and is idempotent to call twice", async () => {
    if (process.platform === "win32") {
      return;
    }
    const first = await ensureWatchdogScript(cacheDir);
    const second = await ensureWatchdogScript(cacheDir);
    assert.equal(first, second);
    assert.ok(first.startsWith(watchdogDir(cacheDir)));
    const stat = await fs.stat(first);
    assert.ok((stat.mode & 0o100) !== 0, "expected the script to be owner-executable");
  });

  it("names the script by its content hash so differing scripts can never collide", () => {
    const a = watchdogScriptFilename("#!/bin/sh\necho a\n");
    const b = watchdogScriptFilename("#!/bin/sh\necho b\n");
    assert.match(a, /^watchdog-[0-9a-f]{12}\.(sh|js)$/);
    assert.ok(a !== b, "distinct content must yield distinct filenames");
    assert.equal(a, watchdogScriptFilename("#!/bin/sh\necho a\n"));
  });

  it("on stdin EOF, reaps every sandbox (stop then remove) and every network, then deletes the ledger files", async () => {
    if (process.platform === "win32") {
      return;
    }
    const recorderPath = path.join(cacheDir, "recorder.sh");
    await writeExecutable(recorderPath, RECORDER_SCRIPT);
    const logPath = path.join(cacheDir, "recorder.log");
    process.env[RECORDER_ENV_KEY] = logPath;

    const sandboxesPath = path.join(cacheDir, "run1.sandboxes");
    const networksPath = path.join(cacheDir, "run1.networks");
    const recordPath = path.join(cacheDir, "run1.json");
    await fs.writeFile(sandboxesPath, "sbx-1\nsbx-2\n");
    await fs.writeFile(networksPath, "net-1\n");
    await fs.writeFile(recordPath, "{}");

    const killCommand: ReaperKillCommand = {
      stop: [recorderPath, "STOP"],
      remove: [recorderPath, "REMOVE"],
      removeNetwork: [recorderPath, "NET"],
    };

    const handle = await spawnWatchdog({ cacheDir, sandboxesPath, networksPath, recordPath, killCommand, ownerPid: process.pid });
    handle.closeForTests();
    // Production code deliberately unref()s the watchdog so it never keeps
    // this process's event loop alive — ref() it back here so the test can
    // observe its exit instead of racing the test runner's own idle exit.
    handle.process.ref();
    await waitForExit(handle.process);

    const log = await readLog(logPath);
    assert.deepEqual(log, ["STOP sbx-1", "REMOVE sbx-1", "STOP sbx-2", "REMOVE sbx-2", "NET net-1"]);

    assert.equal(fsSync.existsSync(sandboxesPath), false);
    assert.equal(fsSync.existsSync(networksPath), false);
    assert.equal(fsSync.existsSync(recordPath), false);
  });

  it("empty/missing .sandboxes and .networks: just deletes the record files and exits, no recorder invocations", async () => {
    if (process.platform === "win32") {
      return;
    }
    const recorderPath = path.join(cacheDir, "recorder.sh");
    await writeExecutable(recorderPath, RECORDER_SCRIPT);
    const logPath = path.join(cacheDir, "recorder.log");
    process.env[RECORDER_ENV_KEY] = logPath;

    const sandboxesPath = path.join(cacheDir, "run2.sandboxes"); // never created
    const networksPath = path.join(cacheDir, "run2.networks"); // never created
    const recordPath = path.join(cacheDir, "run2.json");
    await fs.writeFile(recordPath, "{}");

    const killCommand: ReaperKillCommand = {
      stop: [recorderPath, "STOP"],
      remove: [recorderPath, "REMOVE"],
      removeNetwork: [recorderPath, "NET"],
    };

    const handle = await spawnWatchdog({ cacheDir, sandboxesPath, networksPath, recordPath, killCommand, ownerPid: process.pid });
    handle.closeForTests();
    // Production code deliberately unref()s the watchdog so it never keeps
    // this process's event loop alive — ref() it back here so the test can
    // observe its exit instead of racing the test runner's own idle exit.
    handle.process.ref();
    await waitForExit(handle.process);

    assert.deepEqual(await readLog(logPath), []);
    assert.equal(fsSync.existsSync(recordPath), false);
  });

  it("a docker-shaped kill command (empty stop prefix) never invokes the stop step", async () => {
    if (process.platform === "win32") {
      return;
    }
    const recorderPath = path.join(cacheDir, "recorder.sh");
    await writeExecutable(recorderPath, RECORDER_SCRIPT);
    const logPath = path.join(cacheDir, "recorder.log");
    process.env[RECORDER_ENV_KEY] = logPath;

    const sandboxesPath = path.join(cacheDir, "run3.sandboxes");
    const networksPath = path.join(cacheDir, "run3.networks");
    const recordPath = path.join(cacheDir, "run3.json");
    await fs.writeFile(sandboxesPath, "sbx-1\n");
    await fs.writeFile(recordPath, "{}");

    const killCommand: ReaperKillCommand = {
      stop: [],
      remove: [recorderPath, "RM"],
      removeNetwork: [],
    };

    const handle = await spawnWatchdog({ cacheDir, sandboxesPath, networksPath, recordPath, killCommand, ownerPid: process.pid });
    handle.closeForTests();
    // Production code deliberately unref()s the watchdog so it never keeps
    // this process's event loop alive — ref() it back here so the test can
    // observe its exit instead of racing the test runner's own idle exit.
    handle.process.ref();
    await waitForExit(handle.process);

    assert.deepEqual(await readLog(logPath), ["RM sbx-1"]);
  });

  it("retries once on msb's 'error: database error:' output", async () => {
    if (process.platform === "win32") {
      return;
    }
    const recorderPath = path.join(cacheDir, "recorder.sh");
    await writeExecutable(recorderPath, DB_ERROR_RECORDER_SCRIPT);
    const logPath = path.join(cacheDir, "recorder.log");
    process.env[RECORDER_ENV_KEY] = logPath;

    const sandboxesPath = path.join(cacheDir, "run4.sandboxes");
    const networksPath = path.join(cacheDir, "run4.networks");
    const recordPath = path.join(cacheDir, "run4.json");
    await fs.writeFile(sandboxesPath, "sbx-1\n");
    await fs.writeFile(recordPath, "{}");

    const killCommand: ReaperKillCommand = {
      stop: [],
      remove: [recorderPath, "RM"],
      removeNetwork: [],
    };

    const handle = await spawnWatchdog({ cacheDir, sandboxesPath, networksPath, recordPath, killCommand, ownerPid: process.pid });
    handle.closeForTests();
    // Production code deliberately unref()s the watchdog so it never keeps
    // this process's event loop alive — ref() it back here so the test can
    // observe its exit instead of racing the test runner's own idle exit.
    handle.process.ref();
    await waitForExit(handle.process);

    // Every call's output carries the database-error signature, so every
    // call is retried exactly once: two recorded invocations for one name.
    assert.deepEqual(await readLog(logPath), ["RM sbx-1", "RM sbx-1"]);
  });
});
