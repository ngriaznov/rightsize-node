import { describe, it, assert } from "../../test/harness.js";
import { formatRetryDelay } from "./backend.js";

describe("formatRetryDelay", () => {
  it("prints whole seconds as seconds and everything else, zero included, as milliseconds", () => {
    // Same rendering as the Kotlin and Rust libraries, so the agent-relay retry note reads alike in all three.
    assert.equal(formatRetryDelay(2000), "2 s");
    assert.equal(formatRetryDelay(1000), "1 s");
    assert.equal(formatRetryDelay(1500), "1500 ms");
    assert.equal(formatRetryDelay(999), "999 ms");
    assert.equal(formatRetryDelay(150), "150 ms");
    assert.equal(formatRetryDelay(0), "0 ms");
  });
});
