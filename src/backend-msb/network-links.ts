import { UnsupportedByBackendError } from "../core/errors.js";
import type { NetworkLink } from "../core/backend.js";

const BACKEND_NAME = "microsandbox";

// Permissive DNS-label charset: aliases are interpolated into a `sh -c`
// `/etc/hosts` echo, so this exists to reject shell-metacharacter aliases
// that could break out of the quoting, not to enforce a strict hostname
// grammar.
const ALIAS_CHARSET = /^[A-Za-z0-9._-]+$/;

/**
 * msb has no direct guest-to-guest networking: rightsize's msb links are TCP
 * exec-tunnels (`ExecTunnel`, built on `msb exec --stream` + an in-guest
 * `nc -l` listener), and there is no UDP equivalent of that channel — so a
 * link computed from a UDP-exposed sibling (`withExposedUdpPorts` +
 * `Network`) can never be honored here. Checked FIRST, ahead of the
 * duplicate-guest-port and alias-charset guards below: a udp link must
 * surface this specific, actionable error rather than an unrelated one (and
 * ahead of `requireNoDuplicateGuestPorts` in particular — a container
 * exposing the same guest port on BOTH protocols, DNS's 53 say, is
 * legitimate and must not be flagged as a duplicate; rejecting the udp side
 * outright here means that check never even sees it). Same
 * unsupported-with-remedy error shape as the `nc`-availability guard in
 * `MsbCliBackend.installNetworkLinks`.
 */
export function requireNoUdpLinks(links: readonly NetworkLink[]): void {
  if (links.some((link) => link.protocol === "udp")) {
    throw new UnsupportedByBackendError(
      "UDP network links (msb has no direct guest-to-guest networking — rightsize's msb links are TCP exec-tunnels)",
      BACKEND_NAME,
      "use the docker backend for container-to-container UDP, or publish host-mapped UDP ports instead " +
        "(withExposedUdpPorts()+getMappedUdpPort()), which is the msb-compatible pattern",
    );
  }
}

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
