/**
 * The pure replay math behind the `followLogs` watchdog (see `backend.ts`):
 * given the full authoritative tail fetched once the sandbox has left
 * Running, and a count of how many lines the live `msb logs -f` stream had
 * already delivered, returns only the lines still owed to the consumer.
 *
 * Trailing-newline handling mirrors `msb logs`'s own output shape: a
 * complete log always ends with '\n', which must not manufacture a phantom
 * empty final line — split on '\n' and drop one trailing empty element if
 * the text ended with a newline, but never touch an interior empty line
 * (a blank line the workload genuinely printed is real output).
 */
export function undeliveredLines(fullTailText: string, delivered: number): string[] {
  const lines = fullTailText.split("\n");
  if (fullTailText.endsWith("\n")) {
    lines.pop();
  }
  return lines.slice(delivered);
}
