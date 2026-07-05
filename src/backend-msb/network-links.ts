import { UnsupportedByBackendError } from "../core/errors.js";
import type { NetworkLink } from "../core/backend.js";

const BACKEND_NAME = "microsandbox";

// Permissive DNS-label charset: aliases are interpolated into a `sh -c`
// `/etc/hosts` echo, so this exists to reject shell-metacharacter aliases
// that could break out of the quoting, not to enforce a strict hostname
// grammar.
const ALIAS_CHARSET = /^[A-Za-z0-9._-]+$/;

/** Two siblings publishing the same guest port on one network have nowhere distinct to tunnel to. */
export function requireNoDuplicateGuestPorts(links: readonly NetworkLink[]): void {
  const seen = new Set<number>();
  for (const link of links) {
    if (seen.has(link.guestPort)) {
      throw new UnsupportedByBackendError(
        `two siblings exposing the same guest port ${link.guestPort} on one network`,
        BACKEND_NAME,
      );
    }
    seen.add(link.guestPort);
  }
}

export function requireAliasesAreValid(links: readonly NetworkLink[]): void {
  const aliases = new Set(links.map((l) => l.alias));
  for (const alias of aliases) {
    if (!ALIAS_CHARSET.test(alias)) {
      throw new UnsupportedByBackendError(
        `network alias '${alias}'`,
        BACKEND_NAME,
        "use a valid DNS label instead (allowed: letters, digits, '.', '_', '-')",
      );
    }
  }
}

/** The `sh -c` script that appends one `/etc/hosts` line per distinct alias. */
export function hostsAliasScript(links: readonly NetworkLink[]): string {
  const aliases = [...new Set(links.map((l) => l.alias))];
  return aliases.map((alias) => `echo '127.0.0.1 ${alias}' >> /etc/hosts`).join("; ");
}
