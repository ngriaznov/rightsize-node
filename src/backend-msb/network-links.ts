import { UnsupportedByBackendError } from "../core/errors.js";
import type { NetworkLink } from "../core/backend.js";

const BACKEND_NAME = "microsandbox";

// Permissive DNS-label charset: aliases are interpolated into a `sh -c`
// `/etc/hosts` echo, so this exists to reject shell-metacharacter aliases
// that could break out of the quoting, not to enforce a strict hostname
// grammar.
const ALIAS_CHARSET = /^[A-Za-z0-9._-]+$/;

/**
 * Two siblings publishing the same guest port ON THE SAME PROTOCOL have
 * nowhere distinct to route to — checked per (protocol, guestPort), not
 * guestPort alone, so a container exposing one guest port on BOTH
 * protocols (DNS's 53, say) is never flagged: its TCP and UDP links each
 * get their own independent route (an exec-tunnel, a forwarder script) and
 * never collide with each other.
 */
export function requireNoDuplicateGuestPorts(links: readonly NetworkLink[]): void {
  const seen = new Set<string>();
  for (const link of links) {
    const key = `${link.protocol}:${link.guestPort}`;
    if (seen.has(key)) {
      throw new UnsupportedByBackendError(
        `two siblings exposing the same ${link.protocol} guest port ${link.guestPort} on one network`,
        BACKEND_NAME,
      );
    }
    seen.add(key);
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

/** Where a UDP link's forwarder script/log live in the guest — the name itself is load-bearing: it is grepped back out of `/proc/<pid>/cmdline` by the script's own supervisor loop below. */
export function udpForwarderScriptPath(guestPort: number): string {
  return `/tmp/rz-udp-link-${guestPort}.sh`;
}

/** The forwarder's own launch log, tailed into a readiness-timeout error to give it something to diagnose from. */
export function udpForwarderLogPath(guestPort: number): string {
  return `/tmp/rz-udp-link-${guestPort}.log`;
}

/**
 * The in-guest UDP forwarder, one instance per linked UDP port: relays
 * `guestPort` to `<gateway IPv4>:<targetHostPort>`, where the target's own
 * host-published UDP port is listening. busybox `nc -u -l` locks onto the
 * FIRST client's source port forever and never forks for a second one, so
 * this supervises a chain of single-client listeners instead: each `nc`
 * relays through a fresh `timeout 60 nc` leg to the target and, the moment
 * it locks onto a client, this starts the next listener behind it. "Locked
 * onto a client" is read from `/proc/$pid/cmdline`, not the process's own
 * `comm` — busybox `timeout` keeps the ORIGINAL pid for the program it
 * wraps and only forks the timer, so `comm` reads `nc` again once a client
 * has connected, indistinguishable from the pre-connection listener by name
 * alone. The FIRST inner wait blocks WHILE `cmdline` still contains this
 * script's own `rz-udp-link` path: immediately after `&` forks the child,
 * its cmdline is still THIS script's (the shell hasn't exec'd `nc` yet), and
 * treating that as "locked" starts a flood of listeners on top of one
 * another. The SECOND inner wait blocks WHILE `cmdline` still contains
 * ` -l ` — the listener's own unlocked marker; once that's gone the
 * listener has locked onto a client, and the loop starts the next one.
 * `timeout 60` bounds each individual client's relay — msb's own UDP
 * sessions idle out after 60s, so a client that keeps sending past that
 * gets a fresh relay rather than a wedged one. The gateway's IPv4 literal
 * (never the `host.microsandbox.internal` name) is read once from
 * `/etc/hosts`; `: ${H:=host.microsandbox.internal}` falls back to the name
 * itself when `/etc/hosts` carries no IPv4 gateway line. That name also
 * resolves to an IPv6 gateway, which msb rewrites to `::1`, where the
 * target's 127.0.0.1-bound port never listens.
 *
 * No argument here is ever quoted, and the script carries no `"` anywhere:
 * on Windows hosts the JDK's default `ProcessBuilder` command-line building
 * wraps an exec argument in quotes without escaping embedded ones, so a `"`
 * reaching an exec argument this backend builds comes out mangled on
 * `msb.exe`. Every variable in this script is a number (`$P`, `$HP`,
 * `$pid`) or an IP literal (`$H`), so unquoted word-splitting is never a
 * hazard.
 */
export const UDP_FORWARDER_SCRIPT = `P=$1; HP=$2
H=$(awk -v n=host.microsandbox.internal '$2 == n && $1 ~ /^[0-9.]+$/ { print $1; exit }' /etc/hosts)
: \${H:=host.microsandbox.internal}
while true; do
  nc -u -l -p $P -e timeout 60 nc -u $H $HP &
  pid=$!
  while [ -e /proc/$pid ] && grep -q rz-udp-link /proc/$pid/cmdline 2>/dev/null; do sleep 0.01; done
  while [ -e /proc/$pid ] && tr '\\0' ' ' < /proc/$pid/cmdline 2>/dev/null | grep -q -- ' -l '; do sleep 0.05; done
  [ -e /proc/$pid ] || sleep 0.2
done`;

/**
 * Capability probe for the forwarder's own dependencies — run once per
 * `installNetworkLinks` call, only when at least one UDP link is present.
 * The plain `command -v nc` the TCP exec-tunnel already probes says nothing
 * about `-e`/`-u` or `timeout`, all three of which the forwarder needs.
 * busybox prints its own usage to STDERR on `--help` with a non-zero exit,
 * hence the `2>&1` merge rather than trusting the exit code alone.
 */
export function udpForwarderProbeScript(): string {
  return (
    "command -v nc >/dev/null && command -v timeout >/dev/null && " +
    "nc --help 2>&1 | grep -q -- '-e PROG' && nc --help 2>&1 | grep -q -- '-u'"
  );
}

/**
 * The "one exec" that installs and launches a UDP link's forwarder: writes
 * `UDP_FORWARDER_SCRIPT` to `udpForwarderScriptPath(guestPort)` via a QUOTED
 * heredoc (`<<'EOF'`, never expanded while writing — the script's own `$1`/
 * `$P`/`$pid`/... must reach the file literally, not this shell's
 * evaluation of them), then launches it DETACHED, redirecting its output to
 * `udpForwarderLogPath(guestPort)`. Launched as a FILE argument to `sh`
 * (`sh <path>`), never `sh -c` with the content inlined: the script's own
 * pre-exec wait (see `UDP_FORWARDER_SCRIPT`'s own doc) greps the freshly
 * forked child's cmdline for `rz-udp-link`, which is only there because the
 * path itself carries that substring — an inlined `-c` invocation's cmdline
 * never would. A detached background process survives this exec session;
 * guest processes die with the sandbox, so a UDP link needs no host-side
 * teardown, and a checkpoint reboot's link replay simply reruns this
 * against the rebooted (tmpfs-backed) `/tmp`.
 */
export function installUdpForwarderScript(guestPort: number, targetHostPort: number): string {
  const scriptPath = udpForwarderScriptPath(guestPort);
  const logPath = udpForwarderLogPath(guestPort);
  return (
    `cat > ${scriptPath} <<'EOF'\n${UDP_FORWARDER_SCRIPT}\nEOF\n` +
    `nohup sh ${scriptPath} ${guestPort} ${targetHostPort} >${logPath} 2>&1 &`
  );
}

/** `guestPort` as 4 uppercase hex digits — `/proc/net/udp{,6}`'s own local-address-column encoding (5000 → `"1388"`). */
function guestPortHex(guestPort: number): string {
  return guestPort.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * True (exit 0) once `guestPort` shows up bound in `/proc/net/udp` or
 * `/proc/net/udp6` — polled at a short interval after launching the
 * forwarder, since `nc -u -l`'s bind happens after process startup and
 * prints nothing to signal it. Matches on the LAST 4 hex digits of the
 * local-address column (`<addr>:<PORT-hex>`) rather than the whole column,
 * since the address part varies (`00000000` for an unbound-interface
 * listener) and only the port is what this needs to confirm; `NR>1` skips
 * the header line both files start with.
 */
export function udpReadinessProbeScript(guestPort: number): string {
  const hex = guestPortHex(guestPort);
  return (
    `awk -v p=':${hex}' 'NR>1 && substr($2, length($2)-4) == p {f=1} END {exit !f}' ` +
    "/proc/net/udp /proc/net/udp6"
  );
}
