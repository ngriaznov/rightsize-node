import { createClient } from "redis";
import "../backend-msb/index.js";
import "../backend-docker/index.js";
import { describe, itIntegration, assert } from "../../test/harness.js";
import { ValkeyContainer } from "./valkey.js";

describe("Valkey module", () => {
  itIntegration("real client round-trip: SET then GET returns the same value", async () => {
    const valkey = await ValkeyContainer.start();
    try {
      const client = createClient({ url: valkey.uri });
      await client.connect();
      try {
        await client.set("k", "v");
        assert.equal(await client.get("k"), "v");
      } finally {
        await client.quit();
      }
    } finally {
      await valkey.stop();
    }
  });
});
