import { describe, it, assert } from "../../test/harness.js";
import { isSandboxAlreadyExistsFailure } from "./sandbox-already-exists.js";

describe("isSandboxAlreadyExistsFailure", () => {
  it("matches msb's verbatim sandbox-name-collision refusal", () => {
    assert.ok(isSandboxAlreadyExistsFailure("error: sandbox 'rz-abc-1' already exists"));
  });

  it("is case-insensitive", () => {
    assert.ok(isSandboxAlreadyExistsFailure("ERROR: SANDBOX 'RZ-ABC-1' ALREADY EXISTS"));
  });

  it("matches the alternate already-in-use-by-name phrasing", () => {
    assert.ok(isSandboxAlreadyExistsFailure("a sandbox with this name is already in use"));
  });

  it("does not match an unrelated failure", () => {
    assert.equal(isSandboxAlreadyExistsFailure("error: failed to restore snapshot: destination disk is full"), false);
    assert.equal(isSandboxAlreadyExistsFailure(""), false);
  });

  it("does not match a bare 'already in use' with no name mention", () => {
    assert.equal(isSandboxAlreadyExistsFailure("port 5432 is already in use"), false);
  });
});
