import { describe, it, assert } from "../../test/harness.js";
import { runningNames, statusOf, _scanRunningNamesForTests } from "./ls-json.js";

const REAL_SHAPE = JSON.stringify([
  { created_at: "2026-01-01T00:00:00Z", image: "redis:8.6-alpine", name: "rz-abc-1", status: "Running" },
  { created_at: "2026-01-01T00:00:01Z", image: "redis:8.6-alpine", name: "rz-abc-2", status: "Stopped" },
]);

describe("runningNames", () => {
  it("parses the real msb shape, taking only Running entries", () => {
    const names = runningNames(REAL_SHAPE);
    assert.deepEqual([...names].sort(), ["rz-abc-1"]);
  });

  it("empty array yields an empty set", () => {
    assert.equal(runningNames("[]").size, 0);
  });

  it("only the capitalized 'Running' counts, not 'running'", () => {
    const json = JSON.stringify([{ name: "x", status: "running" }]);
    assert.equal(runningNames(json).size, 0);
  });

  it("tolerates out-of-order keys", () => {
    const json = `[{"status":"Running","name":"rz-z-9","created_at":"t","image":"i"}]`;
    assert.deepEqual([...runningNames(json)], ["rz-z-9"]);
  });

  it("tolerates extra unknown keys", () => {
    const json = `[{"name":"rz-z-9","status":"Running","future_field":{"nested":1}}]`;
    assert.deepEqual([...runningNames(json)], ["rz-z-9"]);
  });

  it("skips (not throws on) an entry missing name or status", () => {
    const json = JSON.stringify([{ status: "Running" }, { name: "rz-only-name" }, { name: "rz-ok", status: "Running" }]);
    assert.deepEqual([...runningNames(json)], ["rz-ok"]);
  });

  it("malformed / non-array JSON degrades to an empty set rather than throwing", () => {
    assert.equal(runningNames("not json at all").size, 0);
    assert.equal(runningNames('{"not":"an array"}').size, 0);
  });

  describe("statusOf", () => {
    it("returns the named entry's raw status, not just whether it's Running", () => {
      assert.equal(statusOf(REAL_SHAPE, "rz-abc-1"), "Running");
      assert.equal(statusOf(REAL_SHAPE, "rz-abc-2"), "Stopped");
    });

    it("returns undefined for a name that does not appear at all", () => {
      assert.equal(statusOf(REAL_SHAPE, "rz-never-existed"), undefined);
    });

    it("degrades to undefined on malformed JSON, same as the runningNames fallback", () => {
      assert.equal(statusOf("not json at all", "rz-abc-1"), undefined);
    });
  });

  describe("the tolerant brace-scan fallback directly", () => {
    it("is string/escape-aware: a brace or comma inside a quoted value never miscounts", () => {
      const json = `[{"name":"rz-{odd}-1","status":"Running"},{"name":"rz-quote-\\"-2","status":"Running"}]`;
      const names = _scanRunningNamesForTests(json);
      assert.deepEqual([...names].sort(), ['rz-quote-"-2', "rz-{odd}-1"]);
    });

    it("reproduces the same out-of-order/extra/missing-key tolerance as the primary path", () => {
      const json = `[{"status":"Running","extra":1,"name":"rz-a"},{"status":"Running"}]`;
      assert.deepEqual([..._scanRunningNamesForTests(json)], ["rz-a"]);
    });
  });
});
