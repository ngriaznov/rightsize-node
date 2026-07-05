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
    argv.push(spec.image);
    if (spec.command !== undefined) {
      // undefined => the image's own ENTRYPOINT/CMD runs unmodified.
      argv.push("--", ...spec.command);
    }
    return argv;
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
};
