import { describe, it, assert } from "../../test/harness.js";
import {
  requireNoDuplicateGuestPorts,
  requireAliasesAreValid,
  hostsAliasScript,
  udpForwarderScriptPath,
  udpForwarderLogPath,
  UDP_FORWARDER_SCRIPT,
  udpForwarderProbeScript,
  installUdpForwarderScript,
  udpReadinessProbeScript,
} from "./network-links.js";
import { UnsupportedByBackendError } from "../core/errors.js";

describe("requireNoDuplicateGuestPorts", () => {
  it("rejects two links exposing the same guest port on the SAME protocol, naming the port", () => {
    assert.throws(() =>
      requireNoDuplicateGuestPorts([
        { alias: "a", guestPort: 8888, targetHostPort: 1, protocol: "tcp" },
        { alias: "b", guestPort: 8888, targetHostPort: 2, protocol: "tcp" },
      ]),
    );
    try {
      requireNoDuplicateGuestPorts([
        { alias: "a", guestPort: 8888, targetHostPort: 1, protocol: "tcp" },
        { alias: "b", guestPort: 8888, targetHostPort: 2, protocol: "tcp" },
      ]);
      assert.ok(false, "expected a throw");
    } catch (err) {
      assert.ok(err instanceof UnsupportedByBackendError);
      assert.match((err as Error).message, /8888/);
    }
  });

  it("rejects two UDP links on the same guest port", () => {
    assert.throws(() =>
      requireNoDuplicateGuestPorts([
        { alias: "a", guestPort: 53, targetHostPort: 1, protocol: "udp" },
        { alias: "b", guestPort: 53, targetHostPort: 2, protocol: "udp" },
      ]),
    );
  });

  it("allows distinct guest ports", () => {
    requireNoDuplicateGuestPorts([
      { alias: "a", guestPort: 80, targetHostPort: 1, protocol: "tcp" },
      { alias: "b", guestPort: 443, targetHostPort: 2, protocol: "tcp" },
    ]);
  });

  it("allows the SAME guest port exposed on both protocols (DNS's 53) — never a duplicate", () => {
    requireNoDuplicateGuestPorts([
      { alias: "dns", guestPort: 53, targetHostPort: 1, protocol: "tcp" },
      { alias: "dns", guestPort: 53, targetHostPort: 2, protocol: "udp" },
    ]);
  });
});

describe("requireAliasesAreValid", () => {
  it("rejects a shell-quoting-breaking alias with the DNS-label remedy", () => {
    try {
      requireAliasesAreValid([{ alias: "evil'; rm -rf /;'", guestPort: 80, targetHostPort: 1, protocol: "tcp" }]);
      assert.ok(false, "expected a throw");
    } catch (err) {
      assert.ok(err instanceof UnsupportedByBackendError);
      assert.match((err as Error).message, /valid DNS label/);
    }
  });

  it("accepts letters, digits, dot, underscore, hyphen", () => {
    requireAliasesAreValid([{ alias: "configuration-stub.local_1", guestPort: 80, targetHostPort: 1, protocol: "tcp" }]);
  });
});

describe("hostsAliasScript", () => {
  it("appends one echo per distinct alias", () => {
    const script = hostsAliasScript([
      { alias: "a", guestPort: 1, targetHostPort: 1, protocol: "tcp" },
      { alias: "a", guestPort: 2, targetHostPort: 2, protocol: "tcp" },
      { alias: "b", guestPort: 3, targetHostPort: 3, protocol: "tcp" },
    ]);
    assert.equal(script, "echo '127.0.0.1 a' >> /etc/hosts; echo '127.0.0.1 b' >> /etc/hosts");
  });

  it("a UDP-only link list still gets its alias installed — the hosts step is shared with TCP", () => {
    const script = hostsAliasScript([{ alias: "udp-echo", guestPort: 9153, targetHostPort: 40000, protocol: "udp" }]);
    assert.equal(script, "echo '127.0.0.1 udp-echo' >> /etc/hosts");
  });
});

describe("udpForwarderProbeScript", () => {
  it("checks nc, timeout, and nc's own -e/-u support, merging stderr since busybox --help exits non-zero", () => {
    const script = udpForwarderProbeScript();
    assert.match(script, /command -v nc/);
    assert.match(script, /command -v timeout/);
    assert.match(script, /nc --help 2>&1 \| grep -q -- '-e PROG'/);
    assert.match(script, /nc --help 2>&1 \| grep -q -- '-u'/);
  });
});

describe("installUdpForwarderScript", () => {
  it("writes UDP_FORWARDER_SCRIPT via a quoted heredoc to the guestPort-named path, then launches it detached with guestPort/targetHostPort as argv", () => {
    const script = installUdpForwarderScript(9153, 40000);
    assert.match(script, /^cat > \/tmp\/rz-udp-link-9153\.sh <<'EOF'\n/);
    assert.ok(script.includes(UDP_FORWARDER_SCRIPT), "expected the exact forwarder script body to appear verbatim");
    assert.match(script, /\nEOF\nnohup sh \/tmp\/rz-udp-link-9153\.sh 9153 40000 >\/tmp\/rz-udp-link-9153\.log 2>&1 &$/);
  });

  it("the heredoc delimiter is quoted — the written script's own $1/$pid/... must never be expanded while writing", () => {
    const script = installUdpForwarderScript(1, 2);
    assert.match(script, /<<'EOF'/);
  });
});

describe("udpForwarderScriptPath / udpForwarderLogPath", () => {
  it("both are named by guestPort under /tmp, distinctly (.sh vs .log)", () => {
    assert.equal(udpForwarderScriptPath(9153), "/tmp/rz-udp-link-9153.sh");
    assert.equal(udpForwarderLogPath(9153), "/tmp/rz-udp-link-9153.log");
  });
});

describe("udpReadinessProbeScript", () => {
  it("encodes the guest port as 4 uppercase hex digits and checks both /proc/net/udp and udp6", () => {
    const script = udpReadinessProbeScript(5000);
    assert.match(script, /:1388'/, "5000 decimal is 1388 hex");
    assert.match(script, /\/proc\/net\/udp \/proc\/net\/udp6$/);
  });

  it("pads a small guest port to 4 hex digits", () => {
    const script = udpReadinessProbeScript(53);
    assert.match(script, /:0035'/);
  });
});

describe("UDP-link exec arguments never carry a double quote (Windows ProcessBuilder mangles them)", () => {
  it("UDP_FORWARDER_SCRIPT itself has no double-quote character", () => {
    assert.equal(UDP_FORWARDER_SCRIPT.includes('"'), false);
  });

  it("the probe, script write+launch, and readiness poll each have no double-quote character", () => {
    assert.equal(udpForwarderProbeScript().includes('"'), false);
    assert.equal(installUdpForwarderScript(9153, 40000).includes('"'), false);
    assert.equal(udpReadinessProbeScript(9153).includes('"'), false);
  });
});
