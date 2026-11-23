/**
 * Pulls the imported member's id out of one `msb snapshot load` run's output.
 * msb 0.8.1 prints one `Added: snap_<id>` line per new member and one
 * `Reused: snap_<id>` line per member the group already held (exit 0 both
 * ways); the head-update line goes to stderr, and `load` prints no path. A
 * single-archive load reports exactly one member, so the first matching line
 * is the answer. Anything else — empty output, only warnings — resolves
 * `undefined` rather than guessing, so `importCheckpoint` fails loudly with
 * the raw output quoted instead of minting a ref from a misread line.
 *
 * The caller searches stdout first and stderr second, and builds the ref as
 * `<checkpointsDir>/<group>/<id>` itself.
 */
export function parseImportedMemberId(output: string): string | undefined {
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const match = /^(?:Added|Reused): (\S+)$/.exec(line);
    if (match !== null) {
      return match[1];
    }
  }
  return undefined;
}
