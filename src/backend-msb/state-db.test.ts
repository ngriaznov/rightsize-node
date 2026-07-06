import { describe, it, assert } from "../../test/harness.js";
import { isMsbMigrationRace } from "./state-db.js";

describe("isMsbMigrationRace", () => {
  it("matches the captured msb error verbatim", () => {
    // Captured verbatim from a real msb 0.6.3 Windows binary: the spawned
    // `msb run` lost the startup-migration race against a concurrent msb
    // invocation (see the classifier's doc).
    const output =
      "error: database error: Execution Error: error returned from database: " +
      "(code: 1) index idx_manifest_layers_unique already exists";
    assert.ok(isMsbMigrationRace(output));
  });

  it("matches the unique-constraint shape of the same race", () => {
    // The other observed loser's message: the migrations bookkeeping row
    // itself, rather than a migration's DDL statement, loses the race.
    assert.ok(
      isMsbMigrationRace(
        "error: database error: Execution Error: error returned from database: " +
          "UNIQUE constraint failed: seaql_migrations.version",
      ),
    );
  });

  it("does not match a database error that is not about the migration race", () => {
    assert.ok(!isMsbMigrationRace("error: database error: disk I/O error"));
  });

  it("does not match 'already exists' outside a database error", () => {
    // e.g. a name conflict: "sandbox 'x' already exists" is the start-retry
    // path's concern, not this classifier's.
    assert.ok(!isMsbMigrationRace("error: sandbox 'rz-abc-1' already exists"));
  });

  it("does not match the image-cache corruption signature", () => {
    assert.ok(
      !isMsbMigrationRace(
        "error: image error: cache error at /tmp/cache/layers/sha256_dead.tar.gz: " +
          "No such file or directory (os error 2)",
      ),
    );
  });

  it("does not match empty output", () => {
    assert.ok(!isMsbMigrationRace(""));
  });
});
