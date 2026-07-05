/**
 * Tolerant field extraction for daemon response bodies. Request bodies in
 * this backend are fixed-shape and built with `JSON.stringify` — no need for
 * tolerance there. Responses go through `JSON.parse` too, but wrapped so a
 * daemon-version field addition or a genuinely malformed body degrades to
 * "field not found" instead of throwing, matching the msb `ls` parser's own
 * tolerance of schema drift (see `../backend-msb/ls-json.ts`).
 */

function parseOrUndefined(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export function extractString(body: string, field: string): string | undefined {
  const parsed = parseOrUndefined(body);
  if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const value = (parsed as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

export function extractNumber(body: string, field: string): number | undefined {
  const parsed = parseOrUndefined(body);
  if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const value = (parsed as Record<string, unknown>)[field];
  return typeof value === "number" ? value : undefined;
}

/** Every `Id` field from a JSON array of objects — used for the container/network list endpoints. */
export function extractIds(body: string): string[] {
  const parsed = parseOrUndefined(body);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of parsed) {
    if (entry !== null && typeof entry === "object" && typeof (entry as Record<string, unknown>)["Id"] === "string") {
      ids.push((entry as Record<string, unknown>)["Id"] as string);
    }
  }
  return ids;
}
