function isHexDigit(ch: string | undefined): boolean {
  return ch !== undefined && /^[0-9a-f]$/i.test(ch);
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

/** A character that continues an identifier token: alphanumeric, `-`, or `_`. */
function isIdentContinue(ch: string | undefined): boolean {
  return ch !== undefined && /^[A-Za-z0-9_-]$/.test(ch);
}

/**
 * Extracts every `rz-<8 hex>-<seq>`-shaped name appearing anywhere in `ls`
 * output — a manual character scan rather than
 * a `\b`-delimited regex. `\b` is a `\w` boundary and `\w` does not include
 * `-`, so a naive `/\brz-[0-9a-f]{8}-\d+\b/` would treat `rz-deadbeef-1` as a
 * complete match inside `rz-deadbeef-1-extra` (the `-` after the digits
 * counts as a boundary) even though that's a glued-on continuation of a
 * longer, different token — exactly the shape a second run's id could
 * produce as a prefix of a name it doesn't own. Requiring the character
 * immediately after the matched digits to NOT be an identifier-continue
 * character keeps this a whole-token match instead of a false-positive
 * prefix.
 */
function orphanCandidateNames(lsOutput: string): string[] {
  const names: string[] = [];
  let i = 0;
  const n = lsOutput.length;
  while (i < n) {
    if (lsOutput.startsWith("rz-", i)) {
      const start = i;
      let j = i + 3;
      let hexLen = 0;
      while (j < n && hexLen < 8 && isHexDigit(lsOutput[j])) {
        j++;
        hexLen++;
      }
      if (hexLen === 8 && lsOutput[j] === "-") {
        let k = j + 1;
        let digitLen = 0;
        while (k < n && isDigit(lsOutput[k])) {
          k++;
          digitLen++;
        }
        if (digitLen > 0 && (k >= n || !isIdentContinue(lsOutput[k]))) {
          names.push(lsOutput.slice(start, k));
          i = k;
          continue;
        }
      }
    }
    i++;
  }
  return names;
}

/**
 * Every `rz-<runid>-<seq>` name mentioned in `msb ls`'s output that does NOT
 * belong to `thisRunId` — leftovers from a run that crashed before its own
 * cleanup ran. Filtering happens against the SAME `RunId.value` core used to
 * name this run's own containers (imported from `rightsize`, never
 * recomputed here) — a backend-local run id would either reap this run's own
 * live sandboxes or fail to recognize a genuinely stale one.
 */
export function orphanNames(lsOutput: string, thisRunId: string): string[] {
  const mine = `rz-${thisRunId}-`;
  const seen = new Set<string>();
  for (const name of orphanCandidateNames(lsOutput)) {
    if (!name.startsWith(mine)) {
      seen.add(name);
    }
  }
  return [...seen];
}
