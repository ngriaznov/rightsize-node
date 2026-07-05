/**
 * msb has no structured error for a host-port bind conflict — only the
 * `msb run` child's combined stdout/stderr text — so this is a best-effort
 * message match, msb-specific wording kept local to this backend rather than
 * folded into `GenericContainer`'s own cause-chain classifier (which handles
 * the typed `PortBindConflictError` case once this function has produced
 * one).
 */
export function isPortBindConflictOutput(output: string): boolean {
  const m = output.toLowerCase();
  return (
    m.includes("address already in use") ||
    m.includes("port is already allocated") ||
    m.includes("bind: address already in use") ||
    (m.includes("already in use") && m.includes("port"))
  );
}
