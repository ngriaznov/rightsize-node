import type { ContainerSpec } from "../core/model.js";

/**
 * Pure msb CLI argv construction. Every spelling here was checked against the
 * real `msb` binary, not guessed from `--help` text alone. ATTACHED mode (no
 * `-d`) is the whole ballgame for `run()`: `msb run -d` boots the microVM but
 * never runs the image's own ENTRYPOINT/CMD, only attached mode does — see
 * `MsbCliBackend.start` for the supervision this forces. `restore()` is a
 * different shape entirely — see its own doc and `MsbCliBackend.bootRestoreOnce`'s
 * for why: `msb restore` always detaches and exits once activation is
 * confirmed, well before the sandbox itself finishes booting, and it is
 * never held open as a supervisor the way `run` is.
 */
export const MsbCommands = {
  run(spec: ContainerSpec): string[] {
    const argv: string[] = ["run", "--name", spec.name];
    if (spec.memoryLimitMb !== undefined) {
      // `-m`/`--memory` immediately after `--name`: msb's parser accepts any
      // flag order, but the position matches captured real invocations so
      // the argv can be compared against them verbatim.
      argv.push("-m", `${spec.memoryLimitMb}M`);
    }
    // `--root-disk` right after memory, before ports — start()-time validation
    // (RootDiskConflictError) guarantees diskLimitMb and tmpfsRootMb are never
    // both set, so at most one of these two fires.
    if (spec.diskLimitMb !== undefined) {
      argv.push("--root-disk", `${spec.diskLimitMb}M`);
    }
    if (spec.tmpfsRootMb !== undefined) {
      argv.push("--root-disk", `tmpfs:${spec.tmpfsRootMb}M`);
    }
    if (spec.networkDisabled) {
      argv.push("--net", "private");
    }
    for (const port of spec.ports) {
      // "/udp" only for a udp binding — the plain "HOST:GUEST" spelling for
      // tcp is byte-identical to before this suffix existed, since msb (like
      // docker) treats an unmarked port publish as tcp by default.
      argv.push("-p", `${port.hostPort}:${port.guestPort}${port.protocol === "udp" ? "/udp" : ""}`);
    }
    for (const [key, value] of spec.env) {
      argv.push("-e", `${key}=${value}`);
    }
    // The option block is always spelled out, never left to msb's defaults, for two
    // reasons on top of each other. The access token (`ro`/`rw`) carries
    // FileMount.readOnly, which msb enforces as a genuine guest-side write block — and it
    // keeps OUR spec parseable on Windows: msb stages each mount into a temp directory
    // and canonicalizes it, which there yields the extended-length `\\?\C:\...` form, and
    // its splitter skips a drive prefix only for a bare drive letter, so a spec with no
    // option block splits at the drive's colon and rejects the path tail as options.
    // `nodev` exists because msb then rebuilds an INTERNAL `tag:staged_path[:opts]` spec
    // for the same mount, carrying over only NON-DEFAULT option tokens — `rw` is its
    // default and is dropped, which on Windows strips the internal spec's option block
    // and re-creates the same misparse one layer down (captured: `--mount
    // "fm_…:\\?\C:\…": expected flag or key=value option`). `nodev` always survives the
    // carry-over, and for a single-file mount it is meaningless (no device nodes to
    // block): verified against a real msb 0.6.8 — `rw,nodev` mounts `rw,nodev` and
    // accepts an in-guest write, `ro,nodev` rejects one with `Read-only file system`.
    for (const mount of spec.mounts) {
      argv.push("--mount-file", `${mount.hostPath}:${mount.guestPath}:${mount.readOnly ? "ro" : "rw"},nodev`);
    }
    // `checkpointRef` never reaches here: msb 0.7.1 removed `run --from-snapshot`
    // outright (clap rejects it as an unexpected argument now), so a spec that
    // carries a checkpointRef is routed to `restore()` below, one layer up in
    // `MsbCliBackend.bootOnce` — this function only ever builds an ordinary
    // image boot.
    argv.push(spec.image);
    if (spec.command !== undefined) {
      // undefined => the image's own ENTRYPOINT/CMD runs unmodified.
      argv.push("--", ...spec.command);
    }
    return argv;
  },

  /**
   * `msb restore <ref> --name <name> [-m SIZE] [--no-net] [--volume
   * SOURCE:GUEST:OPTS]... [-p HOST:GUEST]...` — the checkpoint-reboot argv,
   * replacing the removed `run --from-snapshot` (msb 0.7.1 moved restore to
   * this dedicated subcommand). NEVER emits `--disk-only`: EMPIRICALLY
   * VERIFIED against a real msb 0.7.1 binary, a disk-scope snapshot — the
   * only kind `msb snapshot create --from-sandbox` produces, and therefore
   * the only kind this library's checkpoints ever restore — REJECTS that
   * flag outright (`invalid config: disk_only requires a full snapshot with
   * checkpoint state`). Restoring a disk-scope snapshot is inherently a cold
   * boot of the captured disk with no processes/RAM resumed — the same
   * semantics the old `run --from-snapshot` boot and the removed
   * `--disk-only` flag both had, and the only restore mode this library's
   * checkpoint contract documents — so nothing observable changes for
   * callers; only the argv shrinks by one flag msb no longer accepts here.
   *
   * Deliberately narrower than `run()` in one respect only: `msb restore`
   * has no `-e`/`--env` flag at all, so env is never threaded through here —
   * a restore replays the sandbox's own captured configuration, which makes
   * re-passing env redundant (see `GenericContainer.fromCheckpoint`'s own
   * doc on why an env the caller has actually changed beyond the
   * checkpoint's own is refused before this is ever reached, rather than
   * silently dropped here). There is likewise no `--root-disk` equivalent —
   * the snapshot pins the root disk, and `withDiskLimit()` on a
   * `fromCheckpoint()` container is rejected at `start()` before any backend
   * call.
   *
   * Mounts and network are NOT in that category — they thread through here,
   * mirroring `run()`'s own `--mount-file`/`--net private`. Per msb's own
   * source (`sdk/rust/lib/sandbox/restore_builder.rs`'s `RestoreBuilder::new`),
   * every restore starts with `mounts`/`ports`/`vsock` CLEARED and
   * `restore_resources.require_complete` true — they are the destination's
   * OWN fresh bindings for this specific restore, not something msb
   * re-derives from the snapshot, and an un-resupplied captured external
   * mount is a hard failure, not a silent drop. `createCheckpoint`'s
   * stop/snapshot/reboot cycle (see `MsbCliBackend.createCheckpoint`) hands
   * this function `handle.spec` itself — the ORIGINAL sandbox's live
   * `mounts`/`networkDisabled` exactly as the caller set them via
   * `.withCopyFileToContainer()`/`.withNetworkDisabled()`, not anything
   * "carried over from a captured spec" — so they must be re-emitted here or
   * they silently vanish across the reboot (or, if msb classifies the
   * now-missing mount as a required external resource, throw instead).
   * `GenericContainer.fromCheckpoint()` is the unrelated case the checkpoints
   * guide's "network topology, mounts, and keepAlive are never carried over
   * from the source spec" actually describes: it never copies
   * `cp.spec.mounts`/`networkDisabled` onto the new container's own builder
   * state in the first place (see its own doc), so a `fromCheckpoint()`
   * container's `spec.mounts` is `[]` and `networkDisabled` is `false`
   * unless the caller adds them back explicitly via
   * `.withCopyFileToContainer()`/`.withNetworkDisabled()` on it directly —
   * in which case this function threads those through exactly the same as
   * for any other spec, as it should.
   *
   * `--volume SOURCE:GUEST[:OPTIONS]` is restore's own mount flag (`-v`
   * short form; `RestoreResourceArgs.volume` in
   * crates/cli/lib/commands/restore.rs) — spelled differently from `run()`'s
   * `--mount-file`, but parsed by the identical shared grammar
   * (`parse_cli_mount_spec`, confirmed in crates/cli/lib/commands/common.rs:
   * `--volume`'s `parse_restore_volume` and `--mount-file`'s
   * `apply_explicit_file_mount` both call it with the same
   * `CliMountOptionSupport`), so `run()`'s own comment on why the option
   * block (`ro`/`rw,nodev`) is always spelled out rather than left to
   * defaults applies here verbatim. `--no-net` is restore's equivalent of
   * `run()`'s `--net private`: msb's own default restore network policy is
   * open (`RestoreBuilder::new` clears mounts/ports/vsock/user but never
   * touches the network policy field, so it keeps whatever a fresh
   * `SandboxBuilder`'s default is — the same open-by-default policy `run()`
   * itself relies on when `networkDisabled` is unset), so `--no-net` is
   * emitted only when `networkDisabled` is true, exactly mirroring `run()`'s
   * own `--net private` condition.
   */
  restore(spec: ContainerSpec): string[] {
    if (spec.checkpointRef === undefined) {
      throw new Error("MsbCommands.restore requires spec.checkpointRef");
    }
    const argv: string[] = ["restore", spec.checkpointRef, "--name", spec.name];
    if (spec.memoryLimitMb !== undefined) {
      argv.push("-m", `${spec.memoryLimitMb}M`);
    }
    if (spec.networkDisabled) {
      argv.push("--no-net");
    }
    for (const port of spec.ports) {
      // Same "/udp"-only-for-udp spelling as run() above — a checkpoint
      // reboot re-publishes each binding's ORIGINAL protocol, never
      // defaulting a udp binding back to tcp on restore.
      argv.push("-p", `${port.hostPort}:${port.guestPort}${port.protocol === "udp" ? "/udp" : ""}`);
    }
    for (const mount of spec.mounts) {
      // Same option grammar and Windows rationale as `run()`'s `--mount-file` —
      // see this function's own doc.
      argv.push("--volume", `${mount.hostPath}:${mount.guestPath}:${mount.readOnly ? "ro" : "rw"},nodev`);
    }
    return argv;
  },

  /**
   * `msb snapshot create --from-sandbox <sandbox> <name>` — requires
   * `sandbox` STOPPED. `name` is a caller-supplied label, EMPIRICALLY
   * VERIFIED against a real msb 0.7.1 binary to no longer determine where
   * the artifact lands: it only appears in msb's own index (as
   * `<sandbox>:<name>`, visible in `msb snapshot list`) and in `snapshot
   * inspect` output. The artifact itself always lands under
   * `<destDir-or-default>/<sandbox>/snap_<32-hex-digest>` — a
   * content-addressed path `name` has no say over — which is why
   * `MsbCliBackend.createCheckpoint` parses it back out of this command's
   * own stdout (see `parseSnapshotCreateArtifactPath`) instead of
   * constructing it. `destDir` (this library's own `--dest-dir`, when the
   * ref is a path ref) still controls the artifact's PARENT directory —
   * `<destDir>/<sandbox>/snap_<digest>` when given, msb's own default
   * snapshot store (`~/.microsandbox/snapshots/<sandbox>/snap_<digest>`)
   * otherwise.
   */
  snapshotCreate(sandbox: string, name: string, destDir?: string): string[] {
    const argv = ["snapshot", "create", "--from-sandbox", sandbox, name];
    if (destDir !== undefined) {
      argv.push("--dest-dir", destDir);
    }
    return argv;
  },

  /**
   * `msb snapshot rm <ref> -f` — best-effort per `removeCheckpoint`'s own
   * contract; "not found" is fine. `ref` must be the snapshot's own artifact
   * PATH, never a bare name or `group:member` form: EMPIRICALLY VERIFIED
   * against a real msb 0.7.1 binary, name-based removal does not resolve —
   * the artifact path is the only address that reliably works. `-f` forces
   * the removal; without it a plain `msb snapshot rm` prompts for
   * confirmation, which would hang a non-interactive CLI invocation forever.
   * A non-zero exit can ALSO mean msb refused because `ref` is the current
   * head of older siblings from the same source sandbox — see
   * `isSnapshotHeadRemovalRefused`, which `removeCheckpoint` propagates
   * rather than swallowing alongside an ordinary "not found."
   */
  snapshotRemove(ref: string): string[] {
    return ["snapshot", "rm", ref, "-f"];
  },

  /**
   * `msb snapshot inspect <ref>` — exit 0 means the snapshot exists,
   * non-zero means it doesn't (or the probe itself failed); `hasCheckpoint`'s
   * backend call for a bare-name ref. `ref` should be the snapshot's own
   * artifact PATH for the same reason `snapshotRemove` requires one —
   * EMPIRICALLY VERIFIED against a real msb 0.7.1 binary, name-based inspect
   * does not resolve either.
   */
  snapshotInspect(ref: string): string[] {
    return ["snapshot", "inspect", ref];
  },

  /**
   * `msb snapshot save <ref> <dest>` — writes a `.tar.zst` artifact archive;
   * deliberately never `--with-image` (its import fails an integrity check
   * in 0.6.6, see the checkpoints guide). Upstream renamed the subcommand
   * from `export` to `save` for msb 0.7.1 (EMPIRICALLY VERIFIED against a
   * real 0.7.1 binary — `snapshot export` no longer exists at all); `<ref>`
   * and `<dest>` are still plain positionals with the explicit filename
   * preserved, so nothing about the argv shape besides the verb changes.
   * `exportCheckpoint`'s backend call.
   */
  snapshotExport(ref: string, dest: string): string[] {
    return ["snapshot", "save", ref, dest];
  },

  /**
   * `msb snapshot load <archive> --dest <destDir>` — upstream renamed the
   * subcommand from `import` to `load` for msb 0.7.1 (EMPIRICALLY VERIFIED
   * against a real 0.7.1 binary — `snapshot import` no longer exists at
   * all) and added `--dest`, which this always passes: omitting it imports
   * into msb's own global default snapshot store instead of this library's
   * checkpoints directory, which is exactly the placement bug `--dest`
   * exists to avoid (mirrors `snapshotCreate`'s own `--dest-dir`, a
   * differently-spelled flag on a different subcommand). `destDir` is
   * always the checkpoints cache directory (see `MsbCliBackend.importCheckpoint`).
   * `importCheckpoint`'s backend call.
   */
  snapshotImport(archive: string, destDir: string): string[] {
    return ["snapshot", "load", archive, "--dest", destDir];
  },

  /** `msb copy -q <hostPath> <name>:<containerPath>` — host-to-guest transfer, `cp -r`-style destination naming for a directory source. */
  copyIn(hostPath: string, name: string, containerPath: string): string[] {
    return ["copy", "-q", hostPath, `${name}:${containerPath}`];
  },

  /** `msb copy -q <name>:<containerPath> <hostPath>` — the reverse direction of `copyIn`. */
  copyOut(name: string, containerPath: string, hostPath: string): string[] {
    return ["copy", "-q", `${name}:${containerPath}`, hostPath];
  },

  exec(name: string, cmd: readonly string[]): string[] {
    return ["exec", name, "--", ...cmd];
  },

  /**
   * `msb exec -e KEY=VALUE... <name> -- <cmd...>` — the workload-revival exec
   * variant `MsbCliBackend.reviveWorkload` spawns to restart a restored
   * sandbox's captured workload with its ORIGINAL env (a restore's own `msb
   * restore` has no `-e`/`--env` flag at all — see `restore()`'s own doc —
   * so this is the one place that env reaches a restored sandbox's guest).
   * Distinct from the plain `exec()` builder above, which every other
   * one-shot exec call this backend makes (the `nc` probe, `/etc/hosts`
   * alias install, `mkdir -p`, ...) uses and which never carries env — those
   * calls have no reason to widen the guest command's environment, and
   * `msb exec` accepts `-e` at all only because a genuine workload restart
   * needs it. `-e` is repeatable (mirrors `run()`'s own `-e`) and is emitted
   * right after `exec`, before the sandbox NAME positional — the same
   * relative placement `run()` gives its own `-e` flags among its other
   * options, ahead of the trailing positional(s).
   */
  execWithEnv(name: string, env: ReadonlyArray<readonly [string, string]>, cmd: readonly string[]): string[] {
    const argv: string[] = ["exec"];
    for (const [key, value] of env) {
      argv.push("-e", `${key}=${value}`);
    }
    argv.push(name, "--", ...cmd);
    return argv;
  },

  execStream(name: string, cmd: readonly string[]): string[] {
    return ["exec", "--stream", name, "--", ...cmd];
  },

  logs(name: string): string[] {
    return ["logs", name, "--tail", "1000"];
  },

  /**
   * `msb logs <name> --source system --tail 1000` — msb's own boot
   * diagnostics channel, distinct from the workload log `logs()` above
   * fetches. This is where the boot-completion marker line lives (see
   * `hasSandboxStartedMarker`); the fast-exit post-mortem classification in
   * `MsbCliBackend.bootRunOnce` and the restore poll's own failure
   * diagnostics in `MsbCliBackend.bootRestoreOnce` are this builder's only
   * callers.
   */
  systemLog(name: string): string[] {
    return ["logs", name, "--source", "system", "--tail", "1000"];
  },

  followLogs(name: string): string[] {
    return ["logs", name, "-f"];
  },

  stop(name: string): string[] {
    return ["stop", name];
  },

  rm(name: string): string[] {
    return ["rm", name];
  },

  ls(): string[] {
    // No `--json` flag exists on `ls` — that spelling belongs to `logs`.
    return ["ls", "--format", "json"];
  },

  /**
   * `msb image remove <reference>` deletes one cached image's entry (manifest
   * + layer bookkeeping) so the next run/pull re-fetches it from scratch.
   * Scoped to the single image reference; never touches sandbox state or any
   * other cached image, including ones sharing layers with it (confirmed
   * empirically: removing one image and re-pulling it left a sibling's
   * already-materialized shared base layer untouched and bootable).
   */
  imageRemove(reference: string): string[] {
    return ["image", "remove", reference];
  },
};
