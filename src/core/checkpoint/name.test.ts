import { describe, it, assert } from "../../../test/harness.js";
import { requireValidCheckpointName, CHECKPOINT_NAME_PATTERN } from "./name.js";
import { InvalidCheckpointNameError } from "../errors.js";

function assertRejected(name: string): void {
  let thrown: unknown;
  try {
    requireValidCheckpointName(name);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof InvalidCheckpointNameError, `expected InvalidCheckpointNameError for '${name}', got: ${String(thrown)}`);
}

describe("requireValidCheckpointName", () => {
  it("accepts a single lowercase letter", () => {
    requireValidCheckpointName("a"); // must not throw
  });

  it("accepts a single digit", () => {
    requireValidCheckpointName("9"); // must not throw
  });

  it("accepts lowercase letters, digits, and hyphens together", () => {
    requireValidCheckpointName("seeded-db-v2"); // must not throw
  });

  it("accepts exactly 41 characters", () => {
    const name = "a".repeat(41);
    assert.equal(name.length, 41);
    requireValidCheckpointName(name); // must not throw
  });

  it("rejects 42 characters", () => {
    assertRejected("a".repeat(42));
  });

  it("rejects an empty string", () => {
    assertRejected("");
  });

  it("rejects a name starting with a hyphen", () => {
    assertRejected("-seeded");
  });

  it("rejects uppercase letters", () => {
    assertRejected("Seeded-DB");
  });

  it("rejects an underscore", () => {
    assertRejected("seeded_db");
  });

  it("rejects a space", () => {
    assertRejected("seeded db");
  });

  it("rejects a dot", () => {
    assertRejected("seeded.db");
  });

  it("thrown error carries the exact rejected name and names the pattern in its message", () => {
    let thrown: unknown;
    try {
      requireValidCheckpointName("BAD_NAME");
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof InvalidCheckpointNameError);
    assert.equal((thrown as InvalidCheckpointNameError).checkpointName, "BAD_NAME");
    assert.match((thrown as InvalidCheckpointNameError).message, /\^\[a-z0-9\]\[a-z0-9-\]\{0,40\}\$/);
  });

  it("CHECKPOINT_NAME_PATTERN matches requireValidCheckpointName's own behavior", () => {
    assert.equal(CHECKPOINT_NAME_PATTERN.test("seeded-db"), true);
    assert.equal(CHECKPOINT_NAME_PATTERN.test("Seeded-DB"), false);
  });
});
