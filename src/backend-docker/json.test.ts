import { describe, it, assert } from "../../test/harness.js";
import { extractString, extractNumber, extractIds } from "./json.js";

describe("JSON field extractors", () => {
  it("extractString finds a top-level string field regardless of surrounding fields", () => {
    assert.equal(extractString('{"Warnings":[],"Id":"abc123"}', "Id"), "abc123");
    assert.equal(extractString('{"Id":"abc123","Warnings":[]}', "Id"), "abc123");
  });

  it("extractString returns undefined when the field is absent", () => {
    assert.equal(extractString('{"Warnings":[]}', "Id"), undefined);
  });

  it("extractNumber finds a numeric field", () => {
    assert.equal(extractNumber('{"ExitCode":137}', "ExitCode"), 137);
    assert.equal(extractNumber('{"ExitCode":0}', "ExitCode"), 0);
  });

  it("extractNumber returns undefined for a null field (exec still running)", () => {
    assert.equal(extractNumber('{"ExitCode":null}', "ExitCode"), undefined);
  });

  it("extractNumber returns undefined when the field is absent", () => {
    assert.equal(extractNumber("{}", "ExitCode"), undefined);
  });

  it("extractIds pulls every Id out of a JSON array of objects", () => {
    const body = '[{"Id":"c1","Names":["/a"]},{"Id":"c2","Names":["/b"]}]';
    assert.deepEqual(extractIds(body), ["c1", "c2"]);
  });

  it("extractIds returns an empty array for an empty JSON array", () => {
    assert.deepEqual(extractIds("[]"), []);
  });

  it("extractIds tolerates malformed/non-array bodies by returning an empty array", () => {
    assert.deepEqual(extractIds("not json"), []);
    assert.deepEqual(extractIds("{}"), []);
  });
});
