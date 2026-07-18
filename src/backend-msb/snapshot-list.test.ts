import { describe, it, assert } from "../../test/harness.js";
import { parseSnapshotList, confirmDigestDirNamePresent } from "./snapshot-list.js";

describe("parseSnapshotList", () => {
  it("parses the current msb release's flat array-of-objects shape", () => {
    const json = JSON.stringify([
      { digest: "sha256:b9c0448ee9d54e33...", name: "sha256-b9c0448ee9d54e33", artifact_path: "/snapshots/sha256-b9c0448ee9d54e33", image_ref: "alpine:3.19" },
    ]);
    const entries = parseSnapshotList(json);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.digest, "sha256:b9c0448ee9d54e33...");
    assert.equal(entries[0]?.name, "sha256-b9c0448ee9d54e33");
    assert.equal(entries[0]?.artifactPath, "/snapshots/sha256-b9c0448ee9d54e33");
  });

  it("resolves an empty list for malformed JSON, never throws", () => {
    assert.deepEqual(parseSnapshotList("not json at all"), []);
  });

  it("resolves an empty list for well-formed JSON that isn't an array", () => {
    assert.deepEqual(parseSnapshotList('{"not":"an array"}'), []);
  });

  it("tolerates entries missing fields — those fields resolve undefined, not a thrown error", () => {
    const entries = parseSnapshotList(JSON.stringify([{ name: "only-a-name" }]));
    assert.equal(entries[0]?.name, "only-a-name");
    assert.equal(entries[0]?.digest, undefined);
    assert.equal(entries[0]?.artifactPath, undefined);
  });
});

describe("confirmDigestDirNamePresent", () => {
  it("matches by exact name and returns the digest-dir name itself, not the full digest", () => {
    const entries = [{ digest: "sha256:full-digest", name: "sha256-b9c0448ee9d54e33", artifactPath: undefined }];
    assert.equal(confirmDigestDirNamePresent(entries, "sha256-b9c0448ee9d54e33"), "sha256-b9c0448ee9d54e33");
  });

  it("matches by the basename of artifact_path when name doesn't match, still returning the digest-dir name", () => {
    const entries = [
      { digest: "sha256:full-digest", name: "some-other-name", artifactPath: "/home/user/.microsandbox/snapshots/sha256-b9c0448ee9d54e33" },
    ];
    assert.equal(confirmDigestDirNamePresent(entries, "sha256-b9c0448ee9d54e33"), "sha256-b9c0448ee9d54e33");
  });

  it("resolves undefined when no entry matches", () => {
    const entries = [{ digest: "sha256:full-digest", name: "unrelated", artifactPath: "/snapshots/unrelated" }];
    assert.equal(confirmDigestDirNamePresent(entries, "sha256-never-imported"), undefined);
  });

  it("skips an entry with no digest even if its name matches", () => {
    const entries = [{ digest: undefined, name: "sha256-b9c0448ee9d54e33", artifactPath: undefined }];
    assert.equal(confirmDigestDirNamePresent(entries, "sha256-b9c0448ee9d54e33"), undefined);
  });
});
