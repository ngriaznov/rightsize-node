import { describe, it, assert } from "../../../test/harness.js";
import { reuseEnabled } from "./env.js";

describe("reuseEnabled — RIGHTSIZE_REUSE gating", () => {
  it("'true' enables reuse", () => {
    assert.equal(reuseEnabled({ RIGHTSIZE_REUSE: "true" }), true);
  });

  it("'1' enables reuse", () => {
    assert.equal(reuseEnabled({ RIGHTSIZE_REUSE: "1" }), true);
  });

  it("unset does not enable reuse", () => {
    assert.equal(reuseEnabled({}), false);
  });

  it("any other value (including 'True', '0', 'yes') does not enable reuse — exact-string match only", () => {
    assert.equal(reuseEnabled({ RIGHTSIZE_REUSE: "True" }), false);
    assert.equal(reuseEnabled({ RIGHTSIZE_REUSE: "0" }), false);
    assert.equal(reuseEnabled({ RIGHTSIZE_REUSE: "yes" }), false);
    assert.equal(reuseEnabled({ RIGHTSIZE_REUSE: "" }), false);
  });
});
