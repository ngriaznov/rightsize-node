#!/usr/bin/env node
// A stand-in for the real `msb` binary, driven entirely by a JSON state file
// (path from RIGHTSIZE_FAKE_MSB_STATE) so a test can inspect/steer what
// "sandboxes" exist without spawning a real microVM. Supports just enough of
// the CLI surface MsbCliBackend actually calls: run, stop, rm,
// ls --format json, exec, logs [--tail N | -f], snapshot create/rm, copy.
// `callLog` records every stop/run/rm/snapshot-create invocation (cmd + full
// argv) so a test can assert the checkpoint stop/snapshot/reboot cycle's
// exact call order and the reboot `run`'s exact argv, not just its end state.
import * as fs from "node:fs";
import * as crypto from "node:crypto";

const statePath = process.env.RIGHTSIZE_FAKE_MSB_STATE;
const args = process.argv.slice(2);

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { sandboxes: {} };
  }
}
function logCall(state, cmd, args) {
  state.callLog = [...(state.callLog ?? []), { cmd, args }];
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
  logCall(state, "run", args);
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
  logCall(state, "stop", args);
  // Reproduces the real msb binary's state-database failure on a stop/rm
  // invocation, the same way "run" above does — so removeByName's own
  // retry-once-on-db-error path (mirroring the boot path's classifier) can
  // be driven without a real concurrent-migration race.
  if ((state.failRemovesWithStateDbError ?? 0) > 0) {
    state.failRemovesWithStateDbError -= 1;
    writeState(state);
    process.stderr.write(
      "error: database error: Execution Error: error returned from database: " +
        "(code: 1) index idx_manifest_layers_unique already exists\n",
    );
    process.exit(1);
  }
  if (state.sandboxes[name]) {
    state.sandboxes[name].status = "Stopped";
  }
  writeState(state);
  process.exit(0);
} else if (cmd === "rm") {
  const name = args[1];
  const state = readState();
  logCall(state, "rm", args);
  if ((state.failRemovesWithStateDbError ?? 0) > 0) {
    state.failRemovesWithStateDbError -= 1;
    writeState(state);
    process.stderr.write(
      "error: database error: Execution Error: error returned from database: " +
        "(code: 1) index idx_manifest_layers_unique already exists\n",
    );
    process.exit(1);
  }
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
} else if (cmd === "snapshot" && args[1] === "create") {
  // snapshot create --from <sandbox> <name>
  const fromIdx = args.indexOf("--from");
  const from = args[fromIdx + 1];
  const name = args[args.length - 1];
  const state = readState();
  logCall(state, "snapshotCreate", args);
  if ((state.failSnapshotCreate ?? 0) > 0) {
    state.failSnapshotCreate -= 1;
    writeState(state);
    process.stderr.write(`error: snapshot create failed: sandbox '${from}' is not stopped\n`);
    process.exit(1);
  }
  state.snapshots = { ...(state.snapshots ?? {}), [name]: { from } };
  writeState(state);
  process.exit(0);
} else if (cmd === "snapshot" && args[1] === "inspect") {
  // snapshot inspect <name> — exit 0 if the snapshot exists, exit 1
  // otherwise. hasCheckpoint's backend call. Checks BOTH maps — snapshots
  // created via `snapshot create` and ones brought in via `snapshot
  // import` — reproducing the real msb 0.6.6 binary verified live: the
  // digest-dir name resolves for inspect regardless of how the snapshot
  // got onto disk. This is the exact probe importCheckpoint's returned ref
  // must satisfy, so an effective ref this can't find here (e.g. a full
  // `sha256:` digest instead of the digest-dir name) reproduces the
  // Checkpoints.find eviction bug this fixture exists to catch.
  const name = args[2];
  const state = readState();
  // Reproduces a genuine, non-"not found" probe failure on demand (an
  // unrelated msb error shape, e.g. its state-database failure) so tests can
  // drive hasCheckpoint's must-throw path without a real msb crash/db
  // corruption underneath.
  if ((state.failSnapshotInspectWithError ?? 0) > 0) {
    state.failSnapshotInspectWithError -= 1;
    writeState(state);
    process.stderr.write(
      "error: database error: Execution Error: error returned from database: " +
        "(code: 1) index idx_manifest_layers_unique already exists\n",
    );
    process.exit(1);
  }
  if ((state.snapshots && name in state.snapshots) || (state.importedSnapshots && name in state.importedSnapshots)) {
    process.stdout.write(JSON.stringify({ name }));
    process.exit(0);
  }
  // Wording captured verbatim from the real msb 0.6.6 binary — the exact
  // framing isSnapshotNotFoundError matches against.
  process.stderr.write(`error: snapshot not found: ${name}\n`);
  process.exit(1);
} else if (cmd === "snapshot" && args[1] === "rm") {
  // Best-effort: a missing snapshot name is still a clean exit, matching the
  // real command's "not found" contract removeCheckpoint relies on.
  const name = args[2];
  const state = readState();
  if (state.snapshots) {
    delete state.snapshots[name];
  }
  writeState(state);
  process.exit(0);
} else if (cmd === "snapshot" && args[1] === "export") {
  // snapshot export <ref> <dest> — exportCheckpoint's backend call. Writes a
  // recognizable payload file naming the source ref, so a test can assert
  // byte-identity through the archive round trip without a real .tar.zst.
  const ref = args[2];
  const dest = args[3];
  const state = readState();
  logCall(state, "snapshotExport", args);
  if (!(state.snapshots && ref in state.snapshots)) {
    writeState(state);
    process.stderr.write(`error: snapshot not found: ${ref}\n`);
    process.exit(1);
  }
  if ((state.failSnapshotExport ?? 0) > 0) {
    state.failSnapshotExport -= 1;
    writeState(state);
    process.stderr.write("error: export failed: no space left on device\n");
    process.exit(1);
  }
  fs.writeFileSync(dest, `fake-msb-artifact-for:${ref}`);
  writeState(state);
  process.exit(0);
} else if (cmd === "snapshot" && args[1] === "import") {
  // snapshot import <archive> — importCheckpoint's backend call. The
  // effective ref is content-addressed (a digest-dir name derived from the
  // archive's own bytes), reproducing the real binary's "re-importing the
  // same digest is success, not failure" behavior: state.importedSnapshots
  // is keyed by that digest-dir name, so importing byte-identical content
  // twice hits the already-exists branch below both times after the first.
  const archive = args[2];
  const state = readState();
  logCall(state, "snapshotImport", args);
  let content;
  try {
    content = fs.readFileSync(archive);
  } catch {
    writeState(state);
    process.stderr.write(`error: could not read archive: ${archive}\n`);
    process.exit(1);
  }
  if ((state.failSnapshotImportWithError ?? 0) > 0) {
    state.failSnapshotImportWithError -= 1;
    writeState(state);
    process.stderr.write(
      "error: database error: Execution Error: error returned from database: " +
        "(code: 1) index idx_manifest_layers_unique already exists\n",
    );
    process.exit(1);
  }
  // Two distinct shapes, matching the real msb 0.6.6 binary: the digest-dir
  // NAME (short, what the filesystem and `snapshot list`'s `name` field
  // use — and the only shape that resolves as a snapshot ref) versus the
  // FULL `sha256:<64hex>` digest (only ever surfaced in `snapshot list`'s
  // `digest` field, and does NOT resolve as a ref). Deliberately kept
  // different strings here so a test that accidentally asserted on the
  // wrong one would fail instead of passing by coincidence.
  const fullDigest = `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
  const digestDirName = `sha256-${crypto.createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
  const artifactPath = `/fake/home/.microsandbox/snapshots/${digestDirName}`;
  state.importedSnapshots = state.importedSnapshots ?? {};
  if (digestDirName in state.importedSnapshots) {
    writeState(state);
    // Wording captured verbatim from the real msb 0.6.6 binary — the exact
    // framing isSnapshotAlreadyExistsError matches against. The printed line
    // still ends with the artifact path, same as the success case below.
    process.stderr.write(`error: snapshot already exists: ${artifactPath}\n`);
    process.exit(1);
  }
  state.importedSnapshots[digestDirName] = { fullDigest, artifactPath, importedFrom: archive };
  writeState(state);
  process.stdout.write(`imported snapshot to ${artifactPath}\n`);
  process.exit(0);
} else if (cmd === "snapshot" && args[1] === "list") {
  // snapshot list --format json — digest/name/artifact_path entries. `name`
  // (and artifact_path's basename) carry the digest-dir NAME; `digest`
  // carries the unrelated-looking FULL digest, which importCheckpoint must
  // never treat as the effective ref (see confirmDigestDirNamePresent).
  const state = readState();
  if ((state.failSnapshotListWithError ?? 0) > 0) {
    state.failSnapshotListWithError -= 1;
    process.stderr.write(
      "error: database error: Execution Error: error returned from database: " +
        "(code: 1) index idx_manifest_layers_unique already exists\n",
    );
    process.exit(1);
  }
  const entries = Object.entries(state.importedSnapshots ?? {}).map(([digestDirName, s]) => ({
    digest: s.fullDigest,
    name: digestDirName,
    artifact_path: s.artifactPath,
    image_ref: null,
  }));
  process.stdout.write(JSON.stringify(entries));
  process.exit(0);
} else if (cmd === "copy") {
  // copy -q <src> <dst> — records the call so a test can assert the exact
  // argv this backend produced; a demand flag reproduces a failing transfer
  // (missing guest source, permission, ...) without a real tool underneath.
  const rest = args.slice(1).filter((a) => a !== "-q");
  const state = readState();
  if ((state.failCopyWithError ?? 0) > 0) {
    state.failCopyWithError -= 1;
    writeState(state);
    process.stderr.write("error: copy failed: no such file or directory\n");
    process.exit(1);
  }
  state.copyCalls = [...(state.copyCalls ?? []), rest];
  writeState(state);
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
