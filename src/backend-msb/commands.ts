import type { ContainerSpec, FileMount } from "../core/model.js";

/**
 * The `SOURCE:GUEST:OPTIONS` value of one copied file, shared by `run()`'s
 * `--mount-file` and `restore()`'s `--volume` so the two cannot drift. The
 * option block is always spelled out, never left to msb's defaults, for two
 * reasons on top of each other. The access token (`ro`/`rw`) carries
 * FileMount.readOnly, which msb enforces as a genuine guest-side write block — and it
 * keeps OUR spec parseable on Windows: msb stages each mount into a temp directory
 * and canonicalizes it, which there yields the extended-length `\\?\C:\...` form, and
 * its splitter skips a drive prefix only for a bare drive letter, so a spec with no
 * option block splits at the drive's colon and rejects the path tail as options.
 * `nodev` exists because msb then rebuilds an INTERNAL `tag:staged_path[:opts]` spec
 * for the same mount, carrying over only NON-DEFAULT option tokens — `rw` is its
 * default and is dropped, which on Windows strips the internal spec's option block
 * and re-creates the same misparse one layer down (captured: `--mount
 * "fm_…:\\?\C:\…": expected flag or key=value option`). `nodev` always survives the
 * carry-over, and for a single-file mount it is meaningless (no device nodes to
 * block): verified against a real msb 0.6.8 — `rw,nodev` mounts `rw,nodev` and
 * accepts an in-guest write, `ro,nodev` rejects one with `Read-only file system`.
 *
 * `--volume` and `--mount-file` go through the same shared mount-spec parser,
 * which splits `SOURCE:/guest[:options]` at the colon before the absolute guest
 * path and skips a Windows drive colon (`find_guest_path_separator` /
 * `is_windows_drive_separator` in msb's `crates/cli/lib/commands/common.rs`),
 * so the host path goes in as the OS gives it, with no conversion.
 */
function fileMountValue(mount: FileMount): string {
  return `${mount.hostPath}:${mount.guestPath}:${mount.readOnly ? "ro" : "rw"},nodev`;
}

/**
 * Pure msb CLI argv construction. Every spelling here was checked against the
 * real `msb` binary, not guessed from `--help` text alone. ATTACHED mode (no
 * `-d`) is the whole ballgame for `run()`: `msb run -d` runs the image's own
 * ENTRYPOINT/CMD too, so attached mode isn't about starting the workload —
 * see `MsbCliBackend.start` for the supervision it forces instead.
 * `restore()` is a
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
    // One rule per linked UDP target: a bare --net-rule (no --net flag) is
    // PREPENDED to msb's default policy, so public internet, DNS, and this
    // sandbox's own published-port ingress all keep working — only these
    // specific host UDP ports open up, nothing broader.
    for (const port of spec.hostUdpEgressPorts ?? []) {
      argv.push("--net-rule", `allow@host:udp:${port}`);
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
    // The value comes from `fileMountValue`, which also builds restore()'s
    // `--volume`; see its doc for why the option block is always spelled out.
    for (const mount of spec.mounts) {
      argv.push("--mount-file", fileMountValue(mount));
    }
    // `checkpointRef` never reaches here: msb 0.7.1 removed `run --from-snapshot`
    // (0.8.1 accepts it again, but this library still restores through `msb
    // restore`), so a spec that carries a checkpointRef is routed to
    // `restore()` below, one layer up in `MsbCliBackend.bootOnce` — this
    // function only ever builds an ordinary image boot.
    argv.push(spec.image);
    if (spec.command !== undefined) {
      // undefined => the image's own ENTRYPOINT/CMD runs unmodified.
      argv.push("--", ...spec.command);
    }
    return argv;
  },

  /**
   * `msb restore <ref> --name <name> [-m SIZE] [--no-net] [-p HOST:GUEST]...
   * [--volume SOURCE:GUEST:OPTS]...` — the checkpoint-reboot argv, in place
   * of `run --from-snapshot` (msb 0.7.1 moved restore to this dedicated
   * subcommand; 0.8.1 accepts the old flag again, this library keeps using
   * `restore`). NEVER emits `--disk-only`: EMPIRICALLY
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
   * mirroring `run()`'s own `--mount-file`/`--net private`. A file added with
   * `.withCopyFileToContainer()` is a start-time bind mount of a host file, so
   * a snapshot does NOT capture its content. Per msb's own source
   * (`sdk/rust/lib/sandbox/restore_builder.rs`'s `RestoreBuilder::new`),
   * every restore starts with `mounts`/`ports`/`vsock` CLEARED: they are the
   * destination's OWN fresh bindings for this specific restore, not something
   * msb re-derives from the snapshot. Verified live: a plain restore of such
   * a snapshot brings the file back EMPTY on msb 0.7.6 and is REFUSED on
   * 0.7.8 (`restore requires destination bindings for: mount <path>`, see
   * `isRestoreMissingBindingsFailure`), while `--volume HOST:GUEST` supplies
   * the file again with its content intact on both. `createCheckpoint`'s
   * stop/snapshot/reboot cycle (see `MsbCliBackend.createCheckpoint`) hands
   * this function `handle.spec` itself — the ORIGINAL sandbox's live
   * `mounts`/`networkDisabled` exactly as the caller set them via
   * `.withCopyFileToContainer()`/`.withNetworkDisabled()`, not anything
   * "carried over from a captured spec" — so they must be re-emitted here or
   * they vanish across the reboot (an empty file on 0.7.6, a refused restore
   * on 0.7.8). The host files must therefore still exist when the reboot
   * runs; `requireCopiedHostFilesExist` checks that before the source
   * sandbox is touched. Every restore this backend makes builds its argv
   * here (direct, brokered, retried and fresh-name attempts alike), so one
   * `--volume` per mount reaches all of them.
   * `GenericContainer.fromCheckpoint()` is the unrelated case: it never
   * copies `cp.spec.mounts`/`networkDisabled` onto the new container's own
   * builder state in the first place (see its own doc), so a
   * `fromCheckpoint()` container's `spec.mounts` is `[]` and
   * `networkDisabled` is `false` unless the caller adds them back explicitly
   * via `.withCopyFileToContainer()`/`.withNetworkDisabled()` on it directly —
   * in which case this function threads those through exactly the same as
   * for any other spec, as it should. A copied file left out there makes
   * msb 0.7.8 refuse the restore, which `bootRestoreOnce` turns into
   * `CheckpointMissingCopiedFilesError`; this function never passes
   * `--allow-missing-resources` to get past that. A `--volume` for a guest
   * path the snapshot never had is accepted by both versions.
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
    // Unlike run(), a bare --net-rule here is not additive: msb's restore
    // drops whatever CLI policy the ORIGINAL sandbox booted with and falls
    // back to its own default, so this has to re-supply the complete
    // replacement policy, not just the extra rule. --net-rule only parses
    // on restore alongside --net-default (there is no --net profile flag
    // here, unlike run's --net private), and --net-default governs BOTH
    // directions at once — so the published-port ingress a plain default
    // policy gives for free must be re-added explicitly as
    // allow:ingress@any, or this sandbox's own -p bindings restore
    // unreachable.
    const hostUdpEgressPorts = spec.hostUdpEgressPorts ?? [];
    if (hostUdpEgressPorts.length > 0) {
      const rules = ["allow@public", "allow@dns", ...hostUdpEgressPorts.map((port) => `allow@host:udp:${port}`), "allow:ingress@any"];
      argv.push("--net-default", "deny", "--net-rule", rules.join(","));
    }
    for (const port of spec.ports) {
      // Same "/udp"-only-for-udp spelling as run() above — a checkpoint
      // reboot re-publishes each binding's ORIGINAL protocol, never
      // defaulting a udp binding back to tcp on restore.
      argv.push("-p", `${port.hostPort}:${port.guestPort}${port.protocol === "udp" ? "/udp" : ""}`);
    }
    for (const mount of spec.mounts) {
      // The very value `run()` hands `--mount-file` — see `fileMountValue`.
      argv.push("--volume", fileMountValue(mount));
    }
    return argv;
  },

  /**
   * `msb snapshot create --from-sandbox <sandbox> <group>` — requires
   * `sandbox` STOPPED. Since msb 0.8.0 the positional is a NEW snapshot
   * GROUP, not a member label: msb refuses a group that already exists
   * (`snapshot already exists: <group>`) and names the single member it
   * creates itself (`snap_<32-hex-digest>`). The artifact therefore lands
   * under `<destDir-or-default>/<group>/snap_<digest>` — which is why
   * `MsbCliBackend.createCheckpoint` parses the path back out of this
   * command's own stdout (see `parseSnapshotCreateArtifactPath`) instead of
   * constructing it. `destDir` (this library's own `--dest-dir`, when the
   * ref is a path ref) still controls the group's PARENT directory; msb's
   * own default snapshot store (`~/.microsandbox/snapshots`) is used
   * otherwise.
   */
  snapshotCreate(sandbox: string, group: string, destDir?: string): string[] {
    const argv = ["snapshot", "create", "--from-sandbox", sandbox, group];
    if (destDir !== undefined) {
      argv.push("--dest-dir", destDir);
    }
    return argv;
  },

  /**
   * Removes a checkpoint, addressed the way msb 0.8 wants: the GROUP
   * DIRECTORY (`dirname` of the stored member path) plus, unless the whole
   * group goes, the member name (`basename`). A member path is not accepted
   * as the positional. `removeWholeGroup` picks `msb snapshot rm <groupDir>
   * --all` — the only way to delete the group's `group.json` too, which
   * `--checkpoint` leaves behind and which blocks reusing the group name —
   * and is only right when `member` is the group's only member. Otherwise
   * it is `msb snapshot rm <groupDir> --checkpoint <member> -f`; `-f` stops
   * the interactive confirmation prompt, which would hang a non-interactive
   * CLI invocation forever, and msb rejects it together with `--all`.
   */
  snapshotRemove(groupDir: string, member: string, removeWholeGroup: boolean): string[] {
    return removeWholeGroup
      ? ["snapshot", "rm", groupDir, "--all"]
      : ["snapshot", "rm", groupDir, "--checkpoint", member, "-f"];
  },

  /**
   * `msb snapshot inspect <ref>` — exit 0 means the snapshot exists,
   * non-zero means it doesn't (or the probe itself failed); `hasCheckpoint`'s
   * backend call for a bare-name ref only. Path refs are answered by a
   * filesystem check instead: msb 0.8.1 takes a GROUP here and rejects a
   * member path.
   */
  snapshotInspect(ref: string): string[] {
    return ["snapshot", "inspect", ref];
  },

  /**
   * `msb snapshot save <groupDir> --checkpoint <member> <dest>` — writes a
   * `.tar.zst` artifact archive; deliberately never `--with-image` (see the
   * checkpoints guide — this library doesn't bundle the OCI image into the
   * archive yet, though upstream supports it). Upstream renamed the
   * subcommand from `export` to `save` for msb 0.7.1; msb 0.8.0 made the
   * positional a group and added `--checkpoint` to pick the member, so a
   * member path no longer resolves. `exportCheckpoint`'s backend call.
   */
  snapshotExport(groupDir: string, member: string, dest: string): string[] {
    return ["snapshot", "save", groupDir, "--checkpoint", member, dest];
  },

  /**
   * `msb snapshot load <group> --file <archive> --dest <destDir>` — msb 0.8.0
   * made the new group's name a required positional and the archive a
   * `--file` option (the 0.7.x positional archive is gone). `--dest` is
   * always passed: omitting it imports into msb's own global default
   * snapshot store instead of this library's checkpoints directory, which is
   * exactly the placement bug `--dest` exists to avoid (mirrors
   * `snapshotCreate`'s own `--dest-dir`, a differently-spelled flag on a
   * different subcommand). `destDir` is always the checkpoints cache
   * directory (see `MsbCliBackend.importCheckpoint`); the member lands at
   * `<destDir>/<group>/<id>`. `importCheckpoint`'s backend call.
   */
  snapshotImport(group: string, archive: string, destDir: string): string[] {
    return ["snapshot", "load", group, "--file", archive, "--dest", destDir];
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

  /**
   * `msb rm -f <name>` — removes the sandbox even from a state a plain `rm`
   * refuses (a row msb left stuck in Starting). The boot path's agent-relay
   * retry uses it on the sandbox record a failed boot leaves behind (see
   * `isAgentRelayUnavailable`); every other caller keeps the plain `rm`.
   */
  rmForce(name: string): string[] {
    return ["rm", "-f", name];
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
