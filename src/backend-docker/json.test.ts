import { describe, it, assert } from "../../test/harness.js";
import { extractString, extractNumber, extractIds, extractPullStreamError } from "./json.js";

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

describe("extractPullStreamError", () => {
  it("returns undefined for a progress stream with no error, ignoring a non-JSON line", () => {
    const body = [
      '{"status":"Pulling from library/redis","id":"7"}',
      "this line is not json",
      '{"status":"Download complete","id":"abc"}',
      "",
    ].join("\n");
    assert.equal(extractPullStreamError(body), undefined);
  });

  it("returns undefined for an empty body", () => {
    assert.equal(extractPullStreamError(""), undefined);
  });

  it("finds a top-level error string", () => {
    const body = '{"status":"Pulling from x"}\n{"error":"toomanyrequests: rate limit"}\n';
    assert.equal(extractPullStreamError(body), "toomanyrequests: rate limit");
  });

  it("finds an errorDetail.message when there is no error string", () => {
    assert.equal(extractPullStreamError('{"errorDetail":{"message":"unauthorized"}}'), "unauthorized");
  });

  it("prefers the error string and reports the first failing line", () => {
    const body = '{"errorDetail":{"message":"detail"},"error":"top"}\n{"error":"later"}';
    assert.equal(extractPullStreamError(body), "top");
  });

  it("treats an empty error string, a non-string error, and non-object lines as no error", () => {
    const body = ['{"error":""}', '{"error":5}', '{"errorDetail":{"message":3}}', '{"errorDetail":"x"}', "[1,2]", "null", '"error"'].join("\n");
    assert.equal(extractPullStreamError(body), undefined);
  });

  it("tolerates CRLF line endings", () => {
    assert.equal(extractPullStreamError('{"status":"ok"}\r\n{"error":"boom"}\r\n'), "boom");
  });
});
