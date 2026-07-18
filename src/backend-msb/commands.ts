import type { ContainerSpec } from "../core/model.js";

/**
 * Pure msb CLI argv construction. Every spelling here was checked against the
 * real `msb` binary, not guessed from `--help` text alone. ATTACHED mode (no
 * `-d`) is the whole ballgame: `msb run -d` boots the microVM but never runs
 * the image's own ENTRYPOINT/CMD, only attached mode does — see
 * `MsbCliBackend.start` for the supervision this forces.
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
    for (const port of spec.ports) {
      argv.push("-p", `${port.hostPort}:${port.guestPort}`);
    }
    for (const [key, value] of spec.env) {
      argv.push("-e", `${key}=${value}`);
    }
    for (const mount of spec.mounts) {
      argv.push("--mount-file", `${mount.hostPath}:${mount.guestPath}`);
    }
    if (spec.checkpointRef !== undefined) {
      // `--snapshot` is mutually exclusive with the IMAGE positional arg —
      // the snapshot itself pins the image (see MsbCliBackend's own doc on
      // fromCheckpoint/checkpointRef).
      argv.push("--snapshot", spec.checkpointRef);
    } else {
      argv.push(spec.image);
    }
    if (spec.command !== undefined) {
      // undefined => the image's own ENTRYPOINT/CMD runs unmodified.
      argv.push("--", ...spec.command);
    }
    return argv;
  },

  /** `msb snapshot create --from <sandbox> <name>` — requires `sandbox` STOPPED; writes a sparse disk snapshot under `~/.microsandbox/snapshots/<name>`. */
  snapshotCreate(sandbox: string, name: string): string[] {
    return ["snapshot", "create", "--from", sandbox, name];
  },

  /** `msb snapshot rm <name>` — best-effort per `removeCheckpoint`'s own contract; "not found" is fine. */
  snapshotRemove(name: string): string[] {
    return ["snapshot", "rm", name];
  },

  /** `msb snapshot inspect <name>` — exit 0 means the snapshot exists, non-zero means it doesn't; `hasCheckpoint`'s backend call. */
  snapshotInspect(name: string): string[] {
    return ["snapshot", "inspect", name];
  },

  /** `msb snapshot export <ref> <dest>` — writes a `.tar.zst` artifact archive; deliberately never `--with-image` (its import fails an integrity check in 0.6.6, see the checkpoints guide). `exportCheckpoint`'s backend call. */
  snapshotExport(ref: string, dest: string): string[] {
    return ["snapshot", "export", ref, dest];
  },

  /** `msb snapshot import <archive>` — unpacks into a digest-derived directory under `~/.microsandbox/snapshots/`, never the original name; `importCheckpoint`'s backend call. */
  snapshotImport(archive: string): string[] {
    return ["snapshot", "import", archive];
  },

  /** `msb snapshot list --format json` — full `digest`/`name`/`artifact_path`/`image_ref` entries, used to CONFIRM an imported snapshot's digest-dir basename is present (the basename itself, not the `digest` field, is the effective ref — the full digest does not resolve as a snapshot ref). */
  snapshotList(): string[] {
    return ["snapshot", "list", "--format", "json"];
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

  execStream(name: string, cmd: readonly string[]): string[] {
    return ["exec", "--stream", name, "--", ...cmd];
  },

  logs(name: string): string[] {
    return ["logs", name, "--tail", "1000"];
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
