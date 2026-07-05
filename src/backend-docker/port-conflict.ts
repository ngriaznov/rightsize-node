/**
 * The daemon has no distinct exception type for a host-port bind conflict —
 * only free-text in a 500 response body, such as "driver failed programming
 * external connectivity: ... address already in use" or "Bind for
 * 0.0.0.0:PORT failed: port is already allocated". Classify by message,
 * case-insensitively.
 */
export function isPortBindConflictMessage(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("already in use") || m.includes("already allocated");
}
