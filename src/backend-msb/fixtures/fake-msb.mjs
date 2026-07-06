#!/usr/bin/env node
// A stand-in for the real `msb` binary, driven entirely by a JSON state file
// (path from RIGHTSIZE_FAKE_MSB_STATE) so a test can inspect/steer what
// "sandboxes" exist without spawning a real microVM. Supports just enough of
// the CLI surface MsbCliBackend actually calls: run, stop, rm, ls --format
// json, exec, logs [--tail N | -f].
import * as fs from "node:fs";

const statePath = process.env.RIGHTSIZE_FAKE_MSB_STATE;
const args = process.argv.slice(2);

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { sandboxes: {} };
  }
}
function writeState(state) {
  // Several fixture processes (the long-lived `run`, and one-shot `ls`/
  // `stop`/`rm` invocations) read and write this same file concurrently
  // with no locking. A direct writeFileSync can be observed mid-write by a
  // concurrent readFileSync (a torn read that fails JSON.parse and falls
  // back to an empty state) — write to a temp file in the same directory
  // and rename over the real path instead, so every reader only ever sees
  // either the old complete content or the new complete content, never a
  // partial write.
  const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, statePath);
}

const cmd = args[0];

if (cmd === "run") {
  const nameIdx = args.indexOf("--name");
  const name = args[nameIdx + 1];
  const state = readState();
  // Reproduces the real msb binary's image-cache corruption failure on
  // demand: while the counter is positive, a `run` decrements it and exits
  // with the exact error shape a corrupted cache produces (captured verbatim
  // from msb 0.6.3, digest shortened), so tests can drive the backend's
  // classify-heal-retry path without a real cache race.
  if ((state.failRunsWithCacheError ?? 0) > 0) {
    state.failRunsWithCacheError -= 1;
    writeState(state);
    process.stderr.write(
    "error: image error: cache error at /tmp/fake-msb/cache/layers/sha256_deadbeef.tar.gz: " +
      "No such file or directory (os error 2)\n",
    );
    process.exit(1);
  }
  // Reproduces the real msb binary's state-database failure on demand (error
  // shape captured verbatim from msb 0.6.3 on Windows — the startup-migration
  // race), so tests can drive the backend's classify-retry path without real
  // concurrent msb invocations.
  if ((state.failRunsWithStateDbError ?? 0) > 0) {
    state.failRunsWithStateDbError -= 1;
    writeState(state);
    process.stderr.write(
      "error: database error: Execution Error: error returned from database: " +
        "(code: 1) index idx_manifest_layers_unique already exists\n",
    );
    process.exit(1);
  }
  state.sandboxes[name] = { status: "Running", logs: [`booting ${name}`, "ready"] };
  writeState(state);
  process.stdout.write(`booting ${name}\nready\n`);
  // Reproduces the real msb binary's actual behavior (confirmed by live-probing
  // the binary): the attached `msb run` process IS msb's own supervisor for
  // this sandbox for its whole lifetime. It does not exit on its own — it
  // stays alive as long as the microVM runs, SIGKILLing it transitions the
  // sandbox to Stopped, and it only exits once `msb stop` runs against this
  // same name. So this process just watches the shared state for that to
  // happen (or for an external kill, which ends the process the same way a
  // real SIGKILL would) rather than ever exiting under its own steam.
  const watchInterval = setInterval(() => {
    const current = readState();
    const sandbox = current.sandboxes[name];
    if (sandbox === undefined || sandbox.status !== "Running") {
      clearInterval(watchInterval);
      process.exit(0);
    }
  }, 50);
} else if (cmd === "stop") {
  const name = args[1];
  const state = readState();
  if (state.sandboxes[name]) {
    state.sandboxes[name].status = "Stopped";
  }
  writeState(state);
  process.exit(0);
} else if (cmd === "rm") {
  const name = args[1];
  const state = readState();
  delete state.sandboxes[name];
  writeState(state);
  process.exit(0);
} else if (cmd === "ls") {
  const state = readState();
  const entries = Object.entries(state.sandboxes).map(([name, s]) => ({
    name,
    status: s.status,
    image: "fake:latest",
    created_at: "2026-01-01T00:00:00Z",
  }));
  process.stdout.write(JSON.stringify(entries));
  process.exit(0);
} else if (cmd === "exec") {
  // exec [--stream] <name> -- <cmd...>
  const dashIdx = args.indexOf("--");
  const rest = args.slice(dashIdx + 1);
  if (rest[0] === "sh" && rest[1] === "-c" && rest[2] === "command -v nc") {
    process.stdout.write("/usr/bin/nc\n");
    process.exit(0);
  }
  process.stdout.write(`exec-ok:${rest.join(" ")}\n`);
  process.exit(0);
} else if (cmd === "image" && args[1] === "remove") {
  // Records the removal so tests can assert the heal targeted exactly the
  // affected image reference; always succeeds, like the real command does
  // for a present image.
  const ref = args[2];
  const state = readState();
  state.imageRemoves = [...(state.imageRemoves ?? []), ref];
  writeState(state);
  process.exit(0);
} else if (cmd === "logs") {
  const name = args[1];
  const state = readState();
  const sandbox = state.sandboxes[name];
  const lines = sandbox?.logs ?? [];
  if (args.includes("-f")) {
    for (const l of lines) {
      process.stdout.write(l + "\n");
    }
    // Reproduce the real msb's actual defect: `logs -f` never exits on its own
    // once the sandbox stops, it blocks on read forever — the whole reason
    // MsbCliBackend needs a watchdog. Only an external kill() ends this.
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write(lines.join("\n") + (lines.length > 0 ? "\n" : ""));
    process.exit(0);
  }
} else {
  process.stderr.write(`fake-msb: unknown command '${cmd}'\n`);
  process.exit(1);
}
