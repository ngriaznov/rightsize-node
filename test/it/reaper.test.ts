import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { describe, itMsbIntegration as itIntegration, assert } from "../harness.js";
import "../../src/backend-msb/index.js";
import { ensureInstalled } from "../../src/backend-msb/provisioner.js";
import { MsbCliBackend } from "../../src/backend-msb/backend.js";
import { invoke } from "../../src/backend-msb/invoke.js";
import { MsbCommands } from "../../src/backend-msb/commands.js";
import { runningNames } from "../../src/backend-msb/ls-json.js";
import { Backends } from "../../src/core/backends.js";
import { cacheDir } from "../../src/core/cache-dir.js";
import { writeRunRecord, appendSandboxName, readSandboxNames } from "../../src/core/reaper/ledger.js";
import { recordPath } from "../../src/core/reaper/run-record.js";
import { watchdogDebugPaths, watchdogTracePath } from "../../src/core/reaper/watchdog.js";
import type { ContainerSpec } from "../../src/core/model.js";

/**
 * On a SIGKILL-wait timeout with RIGHTSIZE_REAPER_DEBUG=1, dumps whatever the
 * watchdog itself managed to log (see watchdogDebugPaths — normally the
 * watchdog's stdout/stderr are just "ignore"d) plus a live process-existence
 * probe for its pid, parsed out of the meta log's own "spawn ... pid=<n>"
 * line. Best-effort and print-only: never throws, so a debug dump can never
 * itself mask the real assertion failure below it.
 */
function dumpWatchdogDebugState(dir: string, runId: string): void {
  if (process.env["RIGHTSIZE_REAPER_DEBUG"] !== "1") {
    return;
  }
  const paths = watchdogDebugPaths(dir, runId);
  let pid: number | undefined;
  for (const [label, filePath] of [
    ["meta", paths.meta],
    ["stdout", paths.out],
    ["stderr", paths.err],
  ] as const) {
    let content: string;
    try {
      content = fsSync.readFileSync(filePath, "utf8");
    } catch (err) {
      content = `<unreadable: ${err instanceof Error ? err.message : String(err)}>`;
    }
    console.error(`--- watchdog debug ${label} (${filePath}) ---\n${content}`);
    if (label === "meta") {
      const m = /pid=(\d+)/.exec(content);
      if (m !== null) {
        pid = Number(m[1]);
      }
    }
  }
  if (pid !== undefined) {
    const probe =
      process.platform === "win32"
        ? spawnSync("tasklist", ["/FI", `PID eq ${pid}`], { encoding: "utf8" })
        : spawnSync("ps", ["-p", String(pid)], { encoding: "utf8" });
    console.error(
      `--- watchdog process-existence probe for pid ${pid} ---\n${probe.stdout ?? ""}${probe.stderr ?? ""}`,
    );

    const tracePath = watchdogTracePath(recordPath(dir, runId), pid);
    let traceContent: string;
    try {
      traceContent = fsSync.readFileSync(tracePath, "utf8");
    } catch (err) {
      traceContent = `<unreadable: ${err instanceof Error ? err.message : String(err)}>`;
    }
    console.error(`--- watchdog in-script trace (${tracePath}) ---\n${traceContent}`);
  } else {
    console.error("--- watchdog process-existence probe: no pid found in meta log ---");
  }

  // Raw directory listings so a wrong-filename guess (a naming mismatch
  // between what this test expects and what the script/watchdog actually
  // wrote) is visible directly instead of re-guessed at over another CI
  // round — every "unreadable" above is exactly that kind of guess.
  for (const listedDir of [path.dirname(recordPath(dir, runId)), path.dirname(paths.meta)]) {
    let entries: string[];
    try {
      entries = fsSync.readdirSync(listedDir);
    } catch (err) {
      entries = [`<unreadable: ${err instanceof Error ? err.message : String(err)}>`];
    }
    console.error(`--- directory listing (${listedDir}) ---\n${entries.join("\n")}`);
  }
}

/**
 * Two ends of the reaper's contract, both against the real msb 0.6.6 binary:
 * a process that dies via SIGKILL gets its sandbox reaped by its OWN
 * watchdog (the prompt-layer backstop); a dead run's leftovers get reaped by
 * a FRESH process's init-time sweep (the always-on backstop). Both use the
 * real, shared cache dir (never an isolated temp override) so msb's own
 * provisioning — potentially a real download — only ever has to happen once
 * for this whole suite, the same way every other msb IT file already
 * assumes.
 */

function sigkillFixturePath(): string {
  return path.join(process.cwd(), "dist-test", "test", "it", "fixtures", "reaper-sigkill-child.js");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("orphan reaping: SIGKILL end-to-end (msb backend)", () => {
  itIntegration(
    "a process SIGKILLed right after booting a real sandbox has it reaped by its own watchdog, and its ledger files deleted",
    async () => {
      const fixture = sigkillFixturePath();
      if (!fsSync.existsSync(fixture)) {
        throw new Error(
          `reaper SIGKILL fixture not found at ${fixture} — this test spawns the compiled test tree's own ` +
            `output, so run the full 'npm run test:node:it' (which compiles it) at least once first; a bare ` +
            `'npm run test:bun:it' run alone will not produce it`,
        );
      }
      // Provisioned up front in THIS process so a real cold download never
      // races the fixture's own 60s readiness budget below.
      await ensureInstalled();

      const child = spawn("node", [fixture], {
        env: { ...process.env, RIGHTSIZE_BACKEND: "microsandbox" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      const runId = await new Promise<string>((resolveReady, rejectReady) => {
        const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        const timer = setTimeout(() => {
          rl.close();
          rejectReady(new Error(`reaper-sigkill-child never printed READY within 60s; stderr so far:\n${stderr}`));
        }, 60_000);
        rl.on("line", (line) => {
          const m = /^READY (\S+)$/.exec(line);
          if (m !== null) {
            clearTimeout(timer);
            rl.close();
            resolveReady(m[1] as string);
          }
        });
      });

      if (process.env["RIGHTSIZE_REAPER_DEBUG"] === "1") {
        // The fixture's own pre-SIGKILL watchdog precheck (see
        // WATCHDOG_PRECHECK in reaper-sigkill-child.ts) — printed
        // unconditionally, pass or fail, so a failure that predates the
        // SIGKILL entirely is visible without waiting for the 60s timeout
        // path below to also dump state.
        console.error(`--- fixture stderr (pre-SIGKILL precheck included) ---\n${stderr}`);
      }

      try {
        const dir = cacheDir();
        const sandboxNames = await readSandboxNames(dir, runId);
        assert.equal(sandboxNames.length, 1, `expected exactly one tracked sandbox for run ${runId}, got: ${JSON.stringify(sandboxNames)}`);
        const sandboxName = sandboxNames[0] as string;

        const killTimestamp = Date.now();
        const killResult = child.kill("SIGKILL");

        if (process.env["RIGHTSIZE_REAPER_DEBUG"] === "1") {
          // Directly settles whether the fixture itself is actually gone —
          // as opposed to the watchdog polling a pid that's somehow still
          // alive. Two probes (right after kill, and again a couple
          // seconds later) since TerminateProcess is not necessarily
          // instantaneous from an external observer's point of view.
          console.error(`--- fixture kill() call: pid=${child.pid ?? "unknown"} returned=${killResult} ---`);
          for (const delayMs of [0, 3000]) {
            await sleep(delayMs);
            const probe =
              process.platform === "win32"
                ? spawnSync("tasklist", ["/FI", `PID eq ${child.pid ?? -1}`], { encoding: "utf8" })
                : spawnSync("ps", ["-p", String(child.pid ?? -1)], { encoding: "utf8" });
            console.error(
              `--- fixture process-existence probe (pid=${child.pid ?? "unknown"}, +${delayMs}ms after kill) ---\n` +
                `${probe.stdout ?? ""}${probe.stderr ?? ""}exitCode=${child.exitCode ?? "null"} killed=${child.killed}`,
            );
          }
        }

        const msbPath = await ensureInstalled();
        const deadline = Date.now() + 60_000;
        let sandboxGone = false;
        let ledgerGone = false;
        while (Date.now() < deadline && !(sandboxGone && ledgerGone)) {
          if (!sandboxGone) {
            const ls = await invoke(msbPath, MsbCommands.ls(), 30_000);
            sandboxGone = !runningNames(ls.stdout).has(sandboxName);
          }
          ledgerGone = !fsSync.existsSync(recordPath(dir, runId));
          if (!(sandboxGone && ledgerGone)) {
            await sleep(500);
          }
        }

        if (process.env["RIGHTSIZE_REAPER_DEBUG"] === "1") {
          // Control experiment: two ordinary `node -e` children of the
          // fixture (see spawnCanary in reaper-sigkill-child.ts) have
          // nothing to do with PowerShell/msb/Add-Type at all. If the
          // non-detached one stops heartbeating right around
          // killTimestamp while the detached one keeps going, that
          // settles "the OS kills non-detached descendants alongside a
          // torn-down parent, but detached:true escapes it for an
          // ORDINARY process" directly, independent of anything
          // watchdog/PowerShell-specific.
          for (const detached of [false, true]) {
            const heartbeatPath = path.join(path.dirname(recordPath(dir, runId)), `canary-${detached ? "detached" : "attached"}-${runId}.log`);
            let heartbeatContent: string;
            try {
              heartbeatContent = fsSync.readFileSync(heartbeatPath, "utf8");
            } catch (err) {
              heartbeatContent = `<unreadable: ${err instanceof Error ? err.message : String(err)}>`;
            }
            const lines = heartbeatContent.split("\n").filter((l) => l.length > 0);
            const lastBeat = lines.length > 0 ? Number(lines[lines.length - 1]) : undefined;
            console.error(
              `--- canary heartbeat (detached=${detached}, ${heartbeatPath}) ---\n` +
                `killTimestamp=${killTimestamp}, beats=${lines.length}, lastBeat=${lastBeat ?? "none"} ` +
                `(${lastBeat !== undefined ? lastBeat - killTimestamp : "n/a"}ms relative to kill)`,
            );
          }
        }

        if (!(sandboxGone && ledgerGone)) {
          dumpWatchdogDebugState(dir, runId);
        }
        assert.ok(sandboxGone, `expected the watchdog to have stopped+removed sandbox '${sandboxName}' within 60s of SIGKILL`);
        assert.ok(ledgerGone, `expected the watchdog to have deleted run ${runId}'s ledger files within 60s of SIGKILL`);

        if (!sandboxGone) {
          // Test-failure-path cleanup only: don't leave a real sandbox
          // running on the CI runner just because this assertion failed.
          await invoke(msbPath, MsbCommands.stop(sandboxName), 30_000).catch(() => {});
          await invoke(msbPath, MsbCommands.rm(sandboxName), 30_000).catch(() => {});
        }
      } finally {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }
    },
  );
});

describe("orphan reaping: sweep end-to-end (msb backend)", () => {
  itIntegration(
    "a dead run's real sandbox, fabricated under a fake run id, is reaped by this process's own init-time sweep",
    async () => {
      const msbPath = await ensureInstalled();
      const scratchBackend = new MsbCliBackend(Promise.resolve(msbPath));
      const fakeRunId = `deadit${Date.now().toString(16).slice(-10)}`;
      const name = `rz-${fakeRunId}-1`;
      const spec: ContainerSpec = {
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
      await writeRunRecord(dir, fakeRunId, {
        pid: 999_999,
        startedIso: "2000-01-01T00:00:00.000Z",
        backend: "msb",
        msbPath,
      });
      await appendSandboxName(dir, fakeRunId, name);

      // A fresh reaper bring-up in THIS process: real Backends.active() +
      // Backends.reaperReady() against a genuinely registered msb provider
      // (the "internal reset hook" the feature spec allows as an
      // alternative to spawning a whole new process for this assertion).
      process.env["RIGHTSIZE_BACKEND"] = "microsandbox";
      Backends._resetActiveForTests();
      try {
        await Backends.reaperReady();
      } finally {
        delete process.env["RIGHTSIZE_BACKEND"];
      }

      const deadline = Date.now() + 30_000;
      let gone = false;
      while (Date.now() < deadline) {
        const ls = await invoke(msbPath, MsbCommands.ls(), 30_000);
        if (!runningNames(ls.stdout).has(name)) {
          gone = true;
          break;
        }
        await sleep(500);
      }
      assert.ok(gone, `expected the init-time sweep to have reaped fabricated dead run '${fakeRunId}'s sandbox within 30s`);

      const ledgerStillThere = fsSync.existsSync(recordPath(dir, fakeRunId));
      assert.equal(ledgerStillThere, false, "expected the sweep to have deleted the dead run's ledger files");

      if (!gone) {
        await scratchBackend.removeByName(name).catch(() => {});
      }
      await fs.rm(recordPath(dir, fakeRunId)).catch(() => {});
    },
  );
});
