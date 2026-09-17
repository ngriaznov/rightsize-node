#!/usr/bin/env node
// A stand-in for the real `msb` binary, driven entirely by a JSON state file
// (path from RIGHTSIZE_FAKE_MSB_STATE) so a test can inspect/steer what
// "sandboxes" exist without spawning a real microVM. Supports just enough of
// the CLI surface MsbCliBackend actually calls: run, restore, stop, rm,
// ls --format json, exec, logs [--tail N | -f], snapshot create/rm, copy.
// `callLog` records every stop/run/restore/rm/snapshot-create invocation
// (cmd + full argv) so a test can assert the checkpoint stop/snapshot/reboot
// cycle's exact call order and the reboot `restore`'s exact argv, not just
// its end state.
import * as fs from "node:fs";
import * as path from "node:path";
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
// Shared boot-failure knobs, reproducing msb's own transient failure shapes
// on demand for whichever CLI surface actually boots a sandbox — `run` and,
// since msb 0.7.1, `restore` (the checkpoint reboot's own boot command, see
// commands.ts). `bootClassified`'s install-lock poll and one-shot
// state-db/image-cache retries must keep working across a checkpoint reboot
// exactly like an ordinary boot, so both CLI surfaces drive the same knobs.
// Mutates and persists `state` and exits the process when a knob fires;
// otherwise returns normally and does nothing.
function maybeFailBoot(state) {
  if ((state.failRunsWithCacheError ?? 0) > 0) {
    state.failRunsWithCacheError -= 1;
    writeState(state);
    process.stderr.write(
      "error: image error: cache error at /tmp/fake-msb/cache/layers/sha256_deadbeef.tar.gz: " +
        "No such file or directory (os error 2)\n",
    );
    process.exit(1);
  }
  if ((state.failRunsWithInstallLock ?? 0) > 0) {
    state.failRunsWithInstallLock -= 1;
    writeState(state);
    process.stderr.write(
      "error: runtime error: microsandbox install operation in progress until " +
        "2026-08-20 15:51:16.869758300; retry after it completes\n",
    );
    process.exit(1);
  }
  if ((state.failRunsWithStateDbError ?? 0) > 0) {
    state.failRunsWithStateDbError -= 1;
    writeState(state);
    process.stderr.write(
      "error: database error: Execution Error: error returned from database: " +
        "(code: 1) index idx_manifest_layers_unique already exists\n",
    );
    process.exit(1);
  }
}
function writeState(state) {
  // A test that never inspects state may spawn this fixture without
  // RIGHTSIZE_FAKE_MSB_STATE — persisting would then target the literal
  // path "undefined" (and leak its tmp file into the cwd), so skip.
  if (statePath === undefined) {
    return;
  }
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
  // Reproduces the real msb binary's image-cache-corruption/install-lock/
  // state-db failures on demand — see maybeFailBoot's own doc.
  maybeFailBoot(state);
  // Reproduces msb 0.6.16's fast-exit workload shape on demand: the attached
  // `run` process exits 0 immediately, without ever entering the watch loop
  // below (so state never shows "Running" to a poller, mirroring 0.6.16's
  // convergent-lifecycle rework where a fast-completing workload is only
  // ever observed "Starting"). `fastExitFinalStatus` and `fastExitWriteMarker`
  // are independently steerable so a test can drive both the success
  // classification and each of its negative gates from the same knob:
  // the default (status "Stopped", marker written) is the success case;
  // setting fastExitWriteMarker: false reproduces the agentless-death shape
  // (clean exit, Stopped, but the guest agent never came up to write the
  // marker); setting fastExitFinalStatus to anything other than "Stopped"
  // reproduces a settle that never completed cleanly.
  if ((state.fastExitRuns ?? 0) > 0) {
    state.fastExitRuns -= 1;
    const finalStatus = state.fastExitFinalStatus ?? "Stopped";
    const writeMarker = state.fastExitWriteMarker !== false;
    const systemLog = ["boot diagnostics for " + name];
    if (writeMarker) {
      systemLog.push("--- sandbox started ---");
    }
    state.sandboxes[name] = { status: finalStatus, logs: [`booting ${name}`], systemLog };
    writeState(state);
    process.stdout.write(`booting ${name}\n`);
    process.exit(0);
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
} else if (cmd === "restore") {
  // restore <SNAPSHOT-OR-ARCHIVE-PATH> --name <NAME> [-m SIZE] [--no-net]
  // [-p HOST:GUEST]... [--volume SRC:GUEST:OPTS]... — msb 0.7.1's
  // replacement for `run --from-snapshot`, the checkpoint cycle's reboot
  // command (see MsbCommands.restore and MsbCliBackend.bootRestoreOnce).
  // Reproduces the real binary's actual shape, confirmed against its own
  // source and doc (crates/cli/lib/commands/restore.rs — "Restore a
  // snapshot into a new detached sandbox"): the restore CLI process exits
  // the INSTANT activation succeeds, success or failure, and NEVER itself
  // sets the sandbox's status to "Running" — that only happens later, once
  // a caller's own SUBSEQUENT `msb ls` observes the background boot having
  // caught up (see the "ls" branch below). Unlike `run`, this never runs a
  // watch-interval — `restore`'s own CLI process is never the sandbox's
  // supervisor, msb itself is (out of process, invisible to this fixture).
  const ref = args[1];
  const nameIdx = args.indexOf("--name");
  const name = args[nameIdx + 1];
  const state = readState();
  logCall(state, "restore", args);
  // Reproduces the real msb binary's image-cache-corruption/install-lock/
  // state-db failures on demand — see maybeFailBoot's own doc; a checkpoint
  // reboot is exposed to the same transients as any other boot.
  maybeFailBoot(state);
  // Reproduces an ordinary, UNCLASSIFIED restore failure on demand — msb's
  // own detached activation itself refusing, distinct from the three
  // named-transient shapes maybeFailBoot covers above. Never touches
  // sandbox state, matching a real activation failure that never created
  // anything.
  if ((state.failRestoreWithGenericError ?? 0) > 0) {
    state.failRestoreWithGenericError -= 1;
    writeState(state);
    process.stderr.write(`error: failed to restore snapshot '${ref}': destination disk is full\n`);
    process.exit(1);
  }
  if (state.restoreSettlesAsStopped) {
    // Drives MsbCliBackend.bootRestoreOnce's Stopped/disappearance fast-fail
    // path on demand: the sandbox never progresses past a settled "Stopped"
    // — the exact shape a genuinely failed background boot (as opposed to
    // one still in flight) leaves behind, so a poller must fail fast on it
    // rather than wait out the rest of the readiness budget.
    state.sandboxes[name] = {
      status: "Stopped",
      logs: [`restoring ${name} from ${ref}`],
      systemLog: [`boot diagnostics for ${name}`, "background boot never completed"],
    };
  } else {
    // The realistic shape: not yet Running when this process exits — only
    // `msb ls` (below) advances it, after `restoreLsPollsBeforeRunning`
    // (default 2, so the success path genuinely exercises more than one
    // poll iteration) subsequent polls, reproducing the background boot
    // that continues after this CLI process has already gone away.
    state.sandboxes[name] = {
      status: "Starting",
      logs: [`restoring ${name} from ${ref}`],
      restorePollsUntilRunning: state.restoreLsPollsBeforeRunning ?? 2,
    };
  }
  writeState(state);
  process.stdout.write(`restoring ${name} from ${ref}\nready\n`);
  process.exit(0);
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
  // Advances every sandbox left mid-restore by the "restore" branch above:
  // each `ls` poll is one tick of the background boot MsbCliBackend's own
  // subsequent polling observes, reproducing a detached restore reaching
  // Running only some time after its own CLI process already exited.
  let advanced = false;
  for (const sandbox of Object.values(state.sandboxes)) {
    if (typeof sandbox.restorePollsUntilRunning === "number") {
      sandbox.restorePollsUntilRunning -= 1;
      if (sandbox.restorePollsUntilRunning <= 0) {
        sandbox.status = "Running";
        delete sandbox.restorePollsUntilRunning;
      }
      advanced = true;
    }
  }
  if (advanced) {
    writeState(state);
  }
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
  // snapshot create --from-sandbox <sandbox> <name> [--dest-dir <dir>] — msb
  // 0.7.1's own snapshot-store layout (EMPIRICALLY VERIFIED against a real
  // 0.7.1 binary): the artifact ALWAYS lands nested under
  // <destDir-or-default>/<sandbox>/snap_<32-hex-digest>, never at
  // <destDir>/<name> — `name` never determines the path (it only ends up in
  // msb's own index, keyed by `<sandbox>:<name>`, which this fixture doesn't
  // bother modeling since nothing here reads it back that way). The
  // artifact path is printed as the LAST stdout line, after a snapshot-id
  // line — the exact shape `parseSnapshotCreateArtifactPath` parses.
  const fromIdx = args.indexOf("--from-sandbox");
  const from = args[fromIdx + 1];
  const name = args[fromIdx + 2];
  const destDirIdx = args.indexOf("--dest-dir");
  const state = readState();
  logCall(state, "snapshotCreate", args);
  if ((state.failSnapshotCreate ?? 0) > 0) {
    state.failSnapshotCreate -= 1;
    writeState(state);
    process.stderr.write(`error: snapshot create failed: sandbox '${from}' is not stopped\n`);
    process.exit(1);
  }
  // No --dest-dir: msb's own default snapshot store. Rooted under the fake
  // state file's own directory (a real, writable per-test tmp dir) rather
  // than a literal fake path, so this fixture can actually mkdirSync it —
  // unlike the fake paths `snapshot load`'s digest-dir naming below uses,
  // which nothing here ever creates on disk.
  const destDir =
    destDirIdx !== -1 ? args[destDirIdx + 1] : path.join(path.dirname(statePath ?? "."), "msb-default-snapshots");
  const digest = crypto.randomBytes(16).toString("hex");
  const snapId = `snap_${digest}`;
  const artifactPath = path.join(destDir, from, snapId);
  fs.mkdirSync(artifactPath, { recursive: true });
  fs.writeFileSync(path.join(artifactPath, "snapshot.json"), JSON.stringify({ from, name }));
  state.snapshots = { ...(state.snapshots ?? {}), [artifactPath]: { from, name } };
  writeState(state);
  if ((state.failSnapshotCreateBadOutput ?? 0) > 0) {
    // Reproduces an msb output this backend cannot parse — a last stdout
    // line that is not an absolute path — so a test can drive
    // MsbCliBackend.createCheckpoint's defensive parse-failure path without
    // a real msb binary ever actually misbehaving this way. The artifact is
    // still created (msb itself succeeded; this is purely about the stdout
    // this fixture chooses to print), matching the fact that a real such
    // failure would be a parsing bug in this library, not an msb failure.
    state.failSnapshotCreateBadOutput -= 1;
    writeState(state);
    process.stdout.write(`Created snapshot ${snapId}\nnot-an-absolute-path\n`);
    process.exit(0);
  }
  process.stdout.write(`Created snapshot ${snapId}\n${artifactPath}\n`);
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
  // snapshot rm <ref> -f — best-effort: a missing ref is still a clean exit,
  // matching the real command's "not found" contract removeCheckpoint
  // relies on. `ref` is the FULL artifact path since msb 0.7.1 (name-based
  // removal does not resolve for real — see MsbCommands.snapshotRemove's
  // own doc), and this fixture's `state.snapshots` is keyed the same way
  // (see the "create" branch above).
  const ref = args[2];
  const state = readState();
  logCall(state, "snapshotRemove", args);
  if ((state.failSnapshotRmWithHeadRefusal ?? 0) > 0) {
    // Reproduces msb's own "this is still the current head of older
    // siblings from the same source sandbox" refusal on demand — captured
    // verbatim (see isSnapshotHeadRemovalRefused) — so a test can drive
    // removeCheckpoint's must-propagate path without needing a real second,
    // older sibling snapshot underneath.
    state.failSnapshotRmWithHeadRefusal -= 1;
    writeState(state);
    const from = (state.snapshots ?? {})[ref]?.from ?? "unknown-sandbox";
    process.stderr.write(
      `error: invalid config: cannot remove current head ${path.basename(ref)}; first select another ` +
        `snapshot with 'msb snapshot head ${from}:${path.basename(ref)}'\n`,
    );
    process.exit(1);
  }
  if (state.snapshots) {
    delete state.snapshots[ref];
  }
  writeState(state);
  process.exit(0);
} else if (cmd === "snapshot" && args[1] === "save") {
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
} else if (cmd === "snapshot" && args[1] === "load") {
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
  // --source system reads the boot-diagnostics channel `systemLog` populates
  // (currently only the fast-exit scenario above writes to it) rather than
  // the workload's own `logs` array; no --source flag (or any other value)
  // keeps today's default of the workload log, unchanged.
  const sourceIdx = args.indexOf("--source");
  const source = sourceIdx !== -1 ? args[sourceIdx + 1] : "workload";
  const lines = source === "system" ? (sandbox?.systemLog ?? []) : (sandbox?.logs ?? []);
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
