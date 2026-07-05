import { describe, it, assert } from "../../test/harness.js";
import { requireNoDuplicateGuestPorts, requireAliasesAreValid, hostsAliasScript } from "./network-links.js";
import { UnsupportedByBackendError } from "../core/errors.js";

describe("requireNoDuplicateGuestPorts", () => {
  it("rejects two links exposing the same guest port, naming the port", () => {
    assert.throws(() =>
      requireNoDuplicateGuestPorts([
        { alias: "a", guestPort: 8888, targetHostPort: 1 },
        { alias: "b", guestPort: 8888, targetHostPort: 2 },
      ]),
    );
    try {
      requireNoDuplicateGuestPorts([
        { alias: "a", guestPort: 8888, targetHostPort: 1 },
        { alias: "b", guestPort: 8888, targetHostPort: 2 },
      ]);
      assert.ok(false, "expected a throw");
    } catch (err) {
      assert.ok(err instanceof UnsupportedByBackendError);
      assert.match((err as Error).message, /8888/);
    }
  });

  it("allows distinct guest ports", () => {
    requireNoDuplicateGuestPorts([
      { alias: "a", guestPort: 80, targetHostPort: 1 },
      { alias: "b", guestPort: 443, targetHostPort: 2 },
    ]);
  });
});

describe("requireAliasesAreValid", () => {
  it("rejects a shell-quoting-breaking alias with the DNS-label remedy", () => {
    try {
      requireAliasesAreValid([{ alias: "evil'; rm -rf /;'", guestPort: 80, targetHostPort: 1 }]);
      assert.ok(false, "expected a throw");
    } catch (err) {
      assert.ok(err instanceof UnsupportedByBackendError);
      assert.match((err as Error).message, /valid DNS label/);
    }
  });

  it("accepts letters, digits, dot, underscore, hyphen", () => {
    requireAliasesAreValid([{ alias: "configuration-stub.local_1", guestPort: 80, targetHostPort: 1 }]);
  });
});

describe("hostsAliasScript", () => {
  it("appends one echo per distinct alias", () => {
    const script = hostsAliasScript([
      { alias: "a", guestPort: 1, targetHostPort: 1 },
      { alias: "a", guestPort: 2, targetHostPort: 2 },
      { alias: "b", guestPort: 3, targetHostPort: 3 },
    ]);
    assert.equal(script, "echo '127.0.0.1 a' >> /etc/hosts; echo '127.0.0.1 b' >> /etc/hosts");
  });
});
