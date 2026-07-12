import * as path from "node:path";
import { describe, it, assert } from "../../../test/harness.js";
import {
  runsDir,
  recordPath,
  sandboxesPath,
  networksPath,
  parseRunRecord,
  serializeRunRecord,
  type RunRecord,
} from "./run-record.js";

describe("run-record paths", () => {
  it("builds every ledger path under <cacheDir>/runs/<run-id>.<ext>", () => {
    assert.equal(runsDir("/cache"), path.join("/cache", "runs"));
    assert.equal(recordPath("/cache", "abc12345"), path.join("/cache", "runs", "abc12345.json"));
    assert.equal(sandboxesPath("/cache", "abc12345"), path.join("/cache", "runs", "abc12345.sandboxes"));
    assert.equal(networksPath("/cache", "abc12345"), path.join("/cache", "runs", "abc12345.networks"));
  });
});

describe("parseRunRecord", () => {
  it("round-trips a full msb record through serialize/parse", () => {
    const record: RunRecord = { pid: 1234, startedIso: "2026-07-11T00:00:00.000Z", backend: "msb", msbPath: "/bin/msb" };
    const parsed = parseRunRecord(serializeRunRecord(record));
    assert.deepEqual(parsed, record);
  });

  it("round-trips a docker record with no msbPath field", () => {
    const record: RunRecord = { pid: 1234, startedIso: "2026-07-11T00:00:00.000Z", backend: "docker" };
    const parsed = parseRunRecord(serializeRunRecord(record));
    assert.deepEqual(parsed, record);
  });

  it("rejects malformed JSON", () => {
    assert.equal(parseRunRecord("{ not json"), undefined);
  });

  it("rejects JSON that isn't an object", () => {
    assert.equal(parseRunRecord("42"), undefined);
    assert.equal(parseRunRecord("null"), undefined);
    assert.equal(parseRunRecord("[]"), undefined);
  });

  it("rejects a record missing pid", () => {
    assert.equal(parseRunRecord(JSON.stringify({ startedIso: "2026-07-11T00:00:00.000Z", backend: "msb" })), undefined);
  });

  it("rejects a record with a non-numeric pid", () => {
    assert.equal(
      parseRunRecord(JSON.stringify({ pid: "1234", startedIso: "2026-07-11T00:00:00.000Z", backend: "msb" })),
      undefined,
    );
  });

  it("rejects a record with an unknown backend value", () => {
    assert.equal(
      parseRunRecord(JSON.stringify({ pid: 1, startedIso: "2026-07-11T00:00:00.000Z", backend: "kubernetes" })),
      undefined,
    );
  });

  it("rejects a record whose msbPath is present but non-string", () => {
    assert.equal(
      parseRunRecord(JSON.stringify({ pid: 1, startedIso: "2026-07-11T00:00:00.000Z", backend: "msb", msbPath: 7 })),
      undefined,
    );
  });
});
