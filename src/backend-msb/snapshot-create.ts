import * as path from "node:path";

/**
 * Extracts the artifact path msb prints as the LAST line of a successful
 * `msb snapshot create --from-sandbox ...` invocation's stdout. EMPIRICALLY
 * VERIFIED against a real msb 0.7.1 binary: the command prints the snapshot
 * ID line first, then the absolute artifact path as its final line —
 * `<destDir-or-default>/<sourceSandbox>/snap_<32-hex-digest>` (see
 * `MsbCommands.snapshotCreate`'s own doc for why the caller-supplied name
 * never determines this path). `MsbCliBackend.createCheckpoint` uses the
 * returned path — never the ref it asked msb to create the snapshot under —
 * as the effective checkpoint ref for every later restore/rm/inspect call.
 *
 * Deliberately conservative, matching the HARD CONSTRAINT this parser was
 * written to satisfy: trims the whole output, keeps only non-empty lines,
 * takes the LAST one, and requires it to be an absolute path (`path.isAbsolute`)
 * — anything else (empty output, a relative-looking last line, some future
 * extra trailing line this parser has never seen) resolves `undefined`
 * rather than guessing, so the caller can fail loudly with the raw,
 * unparsed output quoted verbatim instead of minting a checkpoint ref from a
 * misread line.
 */
export function parseSnapshotCreateArtifactPath(stdout: string): string | undefined {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastLine = lines.at(-1);
  if (lastLine === undefined || !path.isAbsolute(lastLine)) {
    return undefined;
  }
  return lastLine;
}
