import { describe, it, assert } from "../../test/harness.js";
import { requireNoUdpLinks, requireNoDuplicateGuestPorts, requireAliasesAreValid, hostsAliasScript } from "./network-links.js";
import { UnsupportedByBackendError } from "../core/errors.js";

describe("requireNoUdpLinks", () => {
  it("rejects a udp link with a typed error naming the docker-backend and host-mapped-UDP remedies", () => {
    try {
      requireNoUdpLinks([{ alias: "dns", guestPort: 53, targetHostPort: 1, protocol: "udp" }]);
      assert.ok(false, "expected a throw");
    } catch (err) {
      assert.ok(err instanceof UnsupportedByBackendError);
      assert.match((err as Error).message, /UDP network links/);
      assert.match((err as Error).message, /docker backend/);
      assert.match((err as Error).message, /withExposedUdpPorts/);
    }
  });

  it("is triggered only when a udp link exists: an all-tcp link list never throws", () => {
    requireNoUdpLinks([{ alias: "a", guestPort: 80, targetHostPort: 1, protocol: "tcp" }]);
  });

  it("rejects when ANY link among several is udp, even if the rest are tcp", () => {
    assert.throws(() =>
      requireNoUdpLinks([
        { alias: "a", guestPort: 80, targetHostPort: 1, protocol: "tcp" },
        { alias: "b", guestPort: 53, targetHostPort: 2, protocol: "udp" },
      ]),
    );
  });

  it("an empty link list never throws", () => {
    requireNoUdpLinks([]);
  });
});

describe("requireNoDuplicateGuestPorts", () => {
  it("rejects two links exposing the same guest port, naming the port", () => {
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

  it("allows distinct guest ports", () => {
    requireNoDuplicateGuestPorts([
      { alias: "a", guestPort: 80, targetHostPort: 1, protocol: "tcp" },
      { alias: "b", guestPort: 443, targetHostPort: 2, protocol: "tcp" },
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
});
