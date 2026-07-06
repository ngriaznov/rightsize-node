import { describe, it, assert } from "../../test/harness.js";
import { isMsbStateDbError } from "./state-db.js";

describe("isMsbStateDbError", () => {
  it("matches the captured migration-race shapes verbatim", () => {
    // Both captured verbatim from a real msb 0.6.3 Windows binary: the
    // spawned `msb run` lost the startup-migration race against a concurrent
    // msb invocation — one race, different losing statements (see the
    // classifier's doc).
    assert.ok(
      isMsbStateDbError(
        "error: database error: Execution Error: error returned from database: " +
          "(code: 1) index idx_manifest_layers_unique already exists",
      ),
    );
    assert.ok(
      isMsbStateDbError(
        "error: database error: Execution Error: error returned from database: " +
          "(code: 1) duplicate column name: kind",
      ),
    );
  });

  it("matches the unique-constraint shape of the same race", () => {
    assert.ok(
      isMsbStateDbError(
        "error: database error: Execution Error: error returned from database: " +
          "UNIQUE constraint failed: seaql_migrations.version",
      ),
    );
  });

  it("matches any msb state-database failure, not just the known wordings", () => {
    // The classifier keys on msb's own framing, not the SQLite message —
    // chasing individual wordings is how the third race shape slipped
    // through. A one-shot retry on a non-race database error is harmless:
    // it costs a moment and then propagates with both attempts' output.
    assert.ok(isMsbStateDbError("error: database error: disk I/O error"));
  });

  it("does not match 'database error' outside msb's own error framing", () => {
    // e.g. a workload's stderr complaining about ITS database — no msb
    // `error:` prefix.
    assert.ok(!isMsbStateDbError("app: database error: connection refused"));
  });

  it("does not match unrelated msb errors", () => {
    assert.ok(!isMsbStateDbError("error: sandbox 'rz-abc-1' already exists"));
    assert.ok(
      !isMsbStateDbError(
        "error: image error: cache error at /tmp/cache/layers/sha256_dead.tar.gz: " +
          "No such file or directory (os error 2)",
      ),
    );
  });

  it("does not match empty output", () => {
    assert.ok(!isMsbStateDbError(""));
  });
});
