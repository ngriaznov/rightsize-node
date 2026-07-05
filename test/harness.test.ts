import * as harness from "./harness.js";

const { describe, it, assert } = harness;

describe("test harness", () => {
  it("exports the same symbol set on every engine", () => {
    const expectedKeys = [
      "engine",
      "describe",
      "it",
      "test",
      "before",
      "after",
      "beforeEach",
      "afterEach",
      "assert",
      "itIntegration",
      "itMsbIntegration",
    ].sort();
    const actualKeys = Object.keys(harness).sort();
    assert.deepEqual(actualKeys, expectedKeys);
  });

  it("reports the running engine as node or bun", () => {
    assert.ok(harness.engine === "node" || harness.engine === "bun");
  });

  it("assert.equal passes on equal values and throws on unequal ones", () => {
    assert.equal(1, 1);
    assert.throws(() => assert.equal(1, 2));
  });

  it("assert.deepEqual compares structurally", () => {
    assert.deepEqual({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] });
    assert.throws(() => assert.deepEqual({ a: 1 }, { a: 2 }));
  });

  it("assert.ok treats falsy values as failures", () => {
    assert.ok(true);
    assert.throws(() => assert.ok(false));
  });

  it("assert.match tests a string against a regex", () => {
    assert.match("hello world", /hello/);
    assert.throws(() => assert.match("nope", /hello/));
  });

  it("assert.rejects awaits a rejecting promise", async () => {
    await assert.rejects(async () => {
      throw new Error("boom");
    });
  });

  it("assert.rejects throws when the promise resolves", async () => {
    let threw = false;
    try {
      await assert.rejects(async () => {
        // resolves, does not reject
      });
    } catch {
      threw = true;
    }
    assert.ok(threw);
  });
});

describe("itIntegration gating", () => {
  // itIntegration must be called at describe-time (like a real IT file
  // would call it at module scope), not from inside another test callback —
  // both runners register tests eagerly during the describe phase.
  harness.itIntegration("only runs when RIGHTSIZE_IT=1", () => {
    assert.equal(process.env["RIGHTSIZE_IT"], "1");
  });
});
