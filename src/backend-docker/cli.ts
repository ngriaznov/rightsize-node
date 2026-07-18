import { spawn } from "node:child_process";
import { BackendError } from "../core/errors.js";

/** One `docker <args>` invocation's outcome — never rejects on a nonzero exit, only on spawn failure or timeout (mirrors `backend-msb/invoke.ts`'s own contract). */
export interface DockerCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Pure argv construction for `docker cp` — kept separate from `runDockerCli` so the shape can be unit-tested without ever spawning the real binary. */
export const DockerCli = {
  /** `docker cp <hostPath> <id>:<containerPath>` — host-to-guest transfer. */
  copyIn(hostPath: string, id: string, containerPath: string): string[] {
    return ["cp", hostPath, `${id}:${containerPath}`];
  },
  /** `docker cp <id>:<containerPath> <hostPath>` — the reverse direction. */
  copyOut(id: string, containerPath: string, hostPath: string): string[] {
    return ["cp", `${id}:${containerPath}`, hostPath];
  },
  /** `docker save -o <destFile> <tag>` — `exportCheckpoint`'s backend call; the tag is preserved inside the archive, unlike msb's digest-derived import naming. */
  save(destFile: string, tag: string): string[] {
    return ["save", "-o", destFile, tag];
  },
  /** `docker load -i <srcFile>` — `importCheckpoint`'s backend call; loading re-points the tag if it already exists. */
  load(srcFile: string): string[] {
    return ["load", "-i", srcFile];
  },
};

/**
 * Runs one `docker <args>` invocation to completion over a child process —
 * used only for `docker cp` (see `DockerBackend.copyToContainer`/
 * `copyFromContainer`), the one operation this backend does not drive over
 * the daemon's HTTP API. Encoding/decoding a tar stream by hand (or adding
 * a third-party Docker SDK) just to reach the same daemon endpoint `docker
 * cp` already wraps isn't worth a new dependency; the reaper watchdog's own
 * kill-command prefixes already make the `docker` CLI a hard requirement
 * for this backend, so shelling out here adds no new precondition.
 */
export function runDockerCli(args: readonly string[], timeoutMs: number): Promise<DockerCliResult> {
  return new Promise((resolveCli, rejectCli) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      rejectCli(new BackendError(`docker ${args.join(" ")} timed out after ${timeoutMs}ms and was force-killed`));
    }, timeoutMs);

    child.once("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      rejectCli(new BackendError(`failed to spawn 'docker ${args.join(" ")}': ${err.message}`));
    });

    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveCli({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}
