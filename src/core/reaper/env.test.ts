import { describe, it, assert } from "../../../test/harness.js";
import { reaperMode, sweepEnabled, watchdogEnabled } from "./env.js";

describe("reaperMode", () => {
  it("defaults to 'on' when unset", () => {
    assert.equal(reaperMode({}), "on");
  });

  it("recognizes 'sweep' and 'off'", () => {
    assert.equal(reaperMode({ RIGHTSIZE_REAPER: "sweep" }), "sweep");
    assert.equal(reaperMode({ RIGHTSIZE_REAPER: "off" }), "off");
  });

  it("an explicit 'on' is 'on'", () => {
    assert.equal(reaperMode({ RIGHTSIZE_REAPER: "on" }), "on");
  });

  it("an unknown value falls back to 'on', not an error", () => {
    assert.equal(reaperMode({ RIGHTSIZE_REAPER: "bogus" }), "on");
    assert.equal(reaperMode({ RIGHTSIZE_REAPER: "" }), "on");
  });
});

describe("sweepEnabled / watchdogEnabled", () => {
  it("'on': both the sweep and the watchdog run", () => {
    assert.equal(sweepEnabled("on"), true);
    assert.equal(watchdogEnabled("on"), true);
  });

  it("'sweep': the sweep runs, the watchdog does not", () => {
    assert.equal(sweepEnabled("sweep"), true);
    assert.equal(watchdogEnabled("sweep"), false);
  });

  it("'off': neither runs", () => {
    assert.equal(sweepEnabled("off"), false);
    assert.equal(watchdogEnabled("off"), false);
  });
});
