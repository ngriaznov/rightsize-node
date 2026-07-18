import { spawn } from "node:child_process";
import { BackendError } from "../errors.js";

/** One `tar <args>` invocation's outcome — never rejects on a nonzero exit, only on spawn failure or timeout (mirrors `backend-docker/cli.ts`'s own `runDockerCli` contract). */
export interface TarCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Pure argv construction for the host `tar` binary — the archive container
 * tool a checkpoint archive is built with (see the checkpoints guide's own
 * note on why a plain tar, not a project-specific packer): present on Linux,
 * macOS, and Windows 10+ (bsdtar as `tar.exe`). Kept separate from
 * `runTar` so the shape can be unit-tested without ever spawning the real
 * binary.
 */
export const TarCli = {
  /**
   * `tar -cf <archive basename> -C <workDir> <members...>` — members are written at
   * the tar's root, never nested under `workDir`'s own path. The archive is named by
   * BASENAME only: an absolute Windows path in the `-f` argument (`C:\...`) is parsed
   * by GNU tar as a `host:path` remote-archive spec ("Cannot connect to C"), and which
   * flavor `tar` resolves to on Windows depends on PATH order (System32's bsdtar vs
   * Git's GNU tar). `runTar` pairs this with `cwd` = the archive's parent directory,
   * which both flavors handle identically.
   */
  create(archiveBasename: string, workDir: string, members: readonly string[]): string[] {
    return ["-cf", archiveBasename, "-C", tarDirArg(workDir), ...members];
  },
  /** `tar -xf <archive basename> -C <destDir>` — extracts every member into `destDir`; same basename-plus-cwd contract as {@link TarCli.create}. */
  extract(archiveBasename: string, destDir: string): string[] {
    return ["-xf", archiveBasename, "-C", tarDirArg(destDir)];
  },
};

/**
 * Normalizes a directory path for tar's `-C` argument: on Windows, Git's GNU
 * (MSYS) tar mangles backslash paths (`C:\Users\...` arrives as
 * `C\:\\Users\\...` and fails "Cannot open"), while both it and System32's
 * bsdtar accept the same path with forward slashes. Elsewhere the path is
 * returned untouched — a backslash is a legal filename character on POSIX.
 */
export function tarDirArg(dir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? dir.replaceAll("\\", "/") : dir;
}

/**
 * Runs one `tar <args>` invocation to completion over a child process — the
 * one operation a checkpoint archive needs that isn't a backend CLI call.
 * Shelling out rather than a tar-writing dependency for the same reason
 * `backend-docker/cli.ts` shells out to `docker cp`: the tool already exists
 * on every platform this library ships for.
 */
export function runTar(args: readonly string[], timeoutMs: number, cwd: string): Promise<TarCliResult> {
  return new Promise((resolveTar, rejectTar) => {
    const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"], cwd });
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
      rejectTar(new BackendError(`tar ${args.join(" ")} timed out after ${timeoutMs}ms and was force-killed`));
    }, timeoutMs);

    child.once("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      rejectTar(new BackendError(`failed to spawn 'tar ${args.join(" ")}': ${err.message}`));
    });

    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveTar({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}
