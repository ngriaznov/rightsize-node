/**
 * True if `output` (an `msb restore` invocation's combined stdout/stderr) is
 * msb refusing to restore a snapshot whose source sandbox had files copied in
 * at start (`withCopyFileToContainer`), because the restore did not supply a
 * destination for each of them. A copied file is a start-time bind mount of a
 * host file, so the snapshot holds no content for it; msb 0.7.8 records the
 * mount in the snapshots it creates and refuses to restore without it.
 * Captured from msb 0.7.8:
 *
 * ```text
 * error: invalid config: restore requires destination bindings for: mount /etc/app/b.conf; provide a destination mount for each path or explicitly allow missing resources
 *   → map each path with -v SOURCE:GUEST or --mount-disk SOURCE:GUEST
 *   → or pass --allow-missing-resources to start without them
 * ```
 *
 * The 0.7.6 binary carries the same sentence with `invalid config:` missing
 * in front and a different tail (`; provide --volume mappings, select
 * captured disks with --volume GUEST, or explicitly use
 * --allow-missing-resources`), used for other restore shapes. A snapshot
 * taken by 0.7.6 does not carry the mount record, so restoring it never
 * produces this refusal: the file comes back empty.
 *
 * Matches only the stable sentence `restore requires destination bindings
 * for`, with any run of whitespace (a wrapped line included) between the
 * words. It does not depend on the `invalid config:` prefix, the version-
 * specific tail, the hint lines, the arrows or the line structure, all of
 * which change with the msb version and with how a Windows host captures the
 * output (PowerShell decorates the first line with `msb.exe : ` and mangles
 * the arrow). The entries after `for:` can be disk entries as well as `mount
 * <path>`, so nothing here parses them.
 *
 * The caller must not retry on a match: the same restore is refused the same
 * way every time. It must also never answer the refusal by passing
 * `--allow-missing-resources`, which would start the sandbox with the copied
 * files silently absent.
 */
export function isRestoreMissingBindingsFailure(output: string): boolean {
  return /restore\s+requires\s+destination\s+bindings\s+for/i.test(output);
}
