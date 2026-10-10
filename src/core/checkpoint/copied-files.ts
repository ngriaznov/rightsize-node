import * as fs from "node:fs/promises";
import { CheckpointHostFileMissingError } from "../errors.js";
import type { FileMount } from "../model.js";

/**
 * Throws `CheckpointHostFileMissingError` for the first mount, in spec order,
 * whose host file is gone. Used by the microsandbox checkpoint, which stops the
 * container, snapshots it and boots it again with `msb restore --volume` for
 * every copied file, so each host file has to exist before the first of those
 * steps. A snapshot holds no content for a copied file, and a boot that finds
 * the host file missing would come after the source sandbox is already gone.
 *
 * Only "no such file or directory" counts as missing. Any other `stat` failure
 * (a permission error on a parent directory, say) is left for msb to report
 * with its own message, so this never claims a file no longer exists when it
 * might still.
 */
export async function requireCopiedHostFilesExist(mounts: readonly FileMount[]): Promise<void> {
  for (const mount of mounts) {
    try {
      await fs.stat(mount.hostPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new CheckpointHostFileMissingError(mount.guestPath, mount.hostPath);
      }
    }
  }
}
