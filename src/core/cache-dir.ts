import * as path from "node:path";
import * as os from "node:os";

/**
 * The one rightsize runtime cache directory, shared by every part of the
 * library that needs a place on disk: the msb toolchain provisioner
 * (`<cacheDir>/msb/<version>/...`), the reaping ledger (`<cacheDir>/runs/...`),
 * and the watchdog scripts (`<cacheDir>/reaper/...`). Lives in core rather
 * than the msb provisioner because the ledger needs it even in a
 * docker-only process, which never touches `backend-msb` at all.
 *
 * `%LOCALAPPDATA%` is the Windows-idiomatic location for a machine-local,
 * non-roaming native toolchain cache (as opposed to `%USERPROFILE%`, which a
 * roaming-profile setup can sync, or a Unix-style dotfile under the home
 * dir). Falls back to `%USERPROFILE%\AppData\Local` if the env var is unset,
 * matching what `os.homedir()` resolves to on a normal Windows install when
 * `LOCALAPPDATA` isn't populated (rare, but seen on some minimal/CI images).
 */
export function cacheDir(): string {
  const override = process.env["RIGHTSIZE_CACHE_DIR"];
  if (override !== undefined) {
    return override;
  }
  if (process.platform === "win32") {
    const localAppData = process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "rightsize");
  }
  return path.join(os.homedir(), ".cache", "rightsize");
}
