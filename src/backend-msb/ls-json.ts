/**
 * Parses `msb ls --format json` — the msb backend's only way to learn which
 * sandboxes currently show `"status":"Running"`. The current msb release's shape is a flat
 * JSON array of objects with keys `created_at, image, name, status` (status
 * capitalized). `JSON.parse` handles that shape fine, but a hand-rolled
 * string/escape-aware brace scanner is kept as the primary path anyway: it
 * degrades gracefully (skip the malformed object, keep the rest) on the kind
 * of schema drift a future msb release might introduce, where `JSON.parse`
 * would simply throw and cost the caller every entry instead of the one bad
 * one.
 */

interface RawEntry {
  name: string | undefined;
  status: string | undefined;
}

/**
 * Splits a top-level JSON array's text into the substrings of its immediate
 * object elements, string- and escape-aware so a `}` or `,` inside a quoted
 * value never miscounts as structural. Never throws: anything that isn't
 * bracket-balanced simply yields whatever complete objects were found before
 * the text ran out.
 */
function splitTopLevelObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth++;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          objects.push(text.slice(start, i + 1));
          start = -1;
        }
      }
      continue;
    }
  }
  return objects;
}

/** Extracts a single string field's value from one object's raw text, tolerant of key order. */
function extractStringField(objectText: string, field: string): string | undefined {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const match = re.exec(objectText);
  if (match === undefined || match === null || match[1] === undefined) {
    return undefined;
  }
  return match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function scanEntries(json: string): RawEntry[] {
  return splitTopLevelObjects(json).map((objectText) => ({
    name: extractStringField(objectText, "name"),
    status: extractStringField(objectText, "status"),
  }));
}

/**
 * Shared by `runningNames` and `statusOf`: tries `JSON.parse` first for the
 * common case and falls back to the tolerant brace scanner only if that
 * throws, so well-formed output pays no scanning cost while malformed output
 * still degrades gracefully instead of losing everything.
 */
function parseEntries(json: string): RawEntry[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as RawEntry[]) : [];
  } catch {
    return scanEntries(json);
  }
}

/**
 * Names of sandboxes whose `status` is exactly `"Running"` (capitalized —
 * msb never lowercases it). An entry missing `name` or `status` is skipped
 * outright, never counted as a name-less running sandbox.
 */
export function runningNames(json: string): Set<string> {
  const names = new Set<string>();
  for (const entry of parseEntries(json)) {
    if (entry.status === "Running" && typeof entry.name === "string") {
      names.add(entry.name);
    }
  }
  return names;
}

/**
 * The raw `status` field of the single entry named `name`, or `undefined` if
 * `name` does not appear at all. Unlike `runningNames`, this reports every
 * status verbatim (not just `"Running"`) — the fast-exit post-mortem
 * classification in `MsbCliBackend.bootOnce` needs to confirm a sandbox
 * settled on exactly `"Stopped"`, which is a different question from "is it
 * currently running".
 */
export function statusOf(json: string, name: string): string | undefined {
  for (const entry of parseEntries(json)) {
    if (entry.name === name) {
      return entry.status;
    }
  }
  return undefined;
}

/** Test-only: forces the tolerant scanner path regardless of whether JSON.parse would succeed. */
export function _scanRunningNamesForTests(json: string): Set<string> {
  const names = new Set<string>();
  for (const entry of scanEntries(json)) {
    if (entry.status === "Running" && typeof entry.name === "string") {
      names.add(entry.name);
    }
  }
  return names;
}
