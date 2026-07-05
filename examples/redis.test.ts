// A node:test file using a module container in a test suite — the pattern
// most consumers copy directly. The container boots once for the whole
// file (`before`) and is disposed once at the end (`after`), rather than
// per-test, so a suite with many assertions doesn't pay for many boots.
//
// The `RIGHTSIZE_IT=1` gate below is the same shape this repo's own
// integration tests use (see test/it/*.test.ts): container-backed tests are
// skipped by default so `node --test` stays fast and safe to run on a
// machine with no container runtime, and only run when explicitly opted
// into with RIGHTSIZE_IT=1.
//
// Run (from the repo root):
//   npm run example:test
//
// Switch backends explicitly:
//   RIGHTSIZE_BACKEND=docker npm run example:test
//   RIGHTSIZE_BACKEND=microsandbox npm run example:test

import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import "rightsize/backend-msb";
import "rightsize/backend-docker";
import { RedisContainer } from "rightsize/modules";
import { createClient } from "redis";

// Skip the whole suite unless a consumer opts in — the same gate this
// repo's own integration tests use, so `npm test` never needs Docker or
// microsandbox installed.
const itIntegration = process.env["RIGHTSIZE_IT"] === "1" ? it : it.skip;

describe("Redis-backed test suite (RIGHTSIZE_IT=1)", () => {
  let redis: RedisContainer;
  let client: ReturnType<typeof createClient>;

  before(async () => {
    if (process.env["RIGHTSIZE_IT"] !== "1") {
      return;
    }
    redis = await RedisContainer.start();
    client = createClient({ url: redis.uri });
    await client.connect();
  });

  after(async () => {
    if (process.env["RIGHTSIZE_IT"] !== "1") {
      return;
    }
    await client.quit();
    await redis.stop(); // same effect as `await using` at scope exit
  });

  itIntegration("round-trips a value through the real container", async () => {
    await client.set("k", "v");
    assert.equal(await client.get("k"), "v");
  });

  itIntegration("reports a real redis:// connection URI", () => {
    assert.match(redis.uri, /^redis:\/\/127\.0\.0\.1:\d+$/);
  });
});
