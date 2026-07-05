import { describe, it, assert } from "../../test/harness.js";
import { isPortBindConflictOutput } from "./port-conflict.js";

describe("isPortBindConflictOutput", () => {
  it("matches 'address already in use'", () => {
    assert.ok(isPortBindConflictOutput("Error: bind: address already in use"));
  });

  it("matches 'port is already allocated'", () => {
    assert.ok(isPortBindConflictOutput("Bind for 0.0.0.0:5432 failed: port is already allocated"));
  });

  it("is case-insensitive", () => {
    assert.ok(isPortBindConflictOutput("ADDRESS ALREADY IN USE"));
  });

  it("matches the generic already-in-use + port combination", () => {
    assert.ok(isPortBindConflictOutput("host port 5432 already in use by another process"));
  });

  it("does not match an unrelated failure", () => {
    assert.equal(isPortBindConflictOutput("Error: no such image: redis:doesnotexist"), false);
    assert.equal(isPortBindConflictOutput("permission denied"), false);
  });
});
