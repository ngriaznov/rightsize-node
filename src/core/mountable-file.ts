import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const tempCopies: string[] = [];
let exitHookInstalled = false;

function installExitCleanup(): void {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const p of tempCopies) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        // best-effort; the OS reclaims tmpdir eventually regardless
      }
    }
  });
}

function copyToTemp(sourcePath: string): string {
  const dest = path.join(os.tmpdir(), `rightsize-${randomBytes(6).toString("hex")}-${path.basename(sourcePath)}`);
  fs.copyFileSync(sourcePath, dest);
  tempCopies.push(dest);
  installExitCleanup();
  return dest;
}

/**
 * A file resolved to an absolute host path, ready to pass to
 * `GenericContainer.withCopyFileToContainer`. `path` is always absolute —
 * `forHostPath` resolves it immediately, and `forResource` copies to a
 * cleaned-on-exit temp file first.
 */
export class MountableFile {
  private constructor(
    /** The resolved, absolute host path. */
    readonly path: string,
  ) {}

  /** Resolves a host filesystem path (relative to `process.cwd()` if not already absolute). */
  static forHostPath(hostPath: string): MountableFile {
    return new MountableFile(path.resolve(hostPath));
  }

  /**
   * JS has no classpath and no cheap "caller's directory": `import.meta.url`
   * only ever gives the DEFINING module's own directory, and recovering the
   * true call site would need a fragile `Error().stack` parse that differs
   * between Node and Bun. So the base is explicit rather than inferred:
   * `relPath` resolves against `baseUrl` (typically the calling module's own
   * `import.meta.url`) when given, and against `process.cwd()` otherwise.
   * There is no classpath-relative resolution here — only an explicit
   * base (an `import.meta.url` you pass in) or the process cwd.
   */
  static forResource(relPath: string, baseUrl?: string): MountableFile {
    const baseDir = baseUrl === undefined ? process.cwd() : path.dirname(fileURLToPath(baseUrl));
    const resolved = path.resolve(baseDir, relPath);
    return new MountableFile(copyToTemp(resolved));
  }
}
