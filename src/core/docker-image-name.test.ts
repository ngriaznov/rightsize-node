import { describe, it, assert } from "../../test/harness.js";
import { DockerImageName } from "./docker-image-name.js";
import { IncompatibleImageError } from "./errors.js";

describe("DockerImageName.parse", () => {
  it("parses a plain name with a tag", () => {
    const name = DockerImageName.parse("postgres:16");
    assert.equal(name.registry, undefined);
    assert.equal(name.repository, "postgres");
    assert.equal(name.tag, "16");
    assert.equal(name.digest, undefined);
  });

  it("parses a plain name with no tag", () => {
    const name = DockerImageName.parse("redis");
    assert.equal(name.registry, undefined);
    assert.equal(name.repository, "redis");
    assert.equal(name.tag, undefined);
  });

  it("keeps a namespaced (non-registry) name whole — floci/floci stays whole, not split at the '/'", () => {
    const name = DockerImageName.parse("floci/floci");
    assert.equal(name.registry, undefined);
    assert.equal(name.repository, "floci/floci");
    assert.equal(name.tag, undefined);
  });

  it("parses a namespaced name with a tag", () => {
    const name = DockerImageName.parse("qdrant/qdrant:v1.18.3");
    assert.equal(name.registry, undefined);
    assert.equal(name.repository, "qdrant/qdrant");
    assert.equal(name.tag, "v1.18.3");
  });

  it("strips a dotted registry host — quay.io/keycloak/keycloak", () => {
    const name = DockerImageName.parse("quay.io/keycloak/keycloak");
    assert.equal(name.registry, "quay.io");
    assert.equal(name.repository, "keycloak/keycloak");
    assert.equal(name.tag, undefined);
  });

  it("strips a dotted registry host and keeps the tag separate", () => {
    const name = DockerImageName.parse("quay.io/keycloak/keycloak:26.0");
    assert.equal(name.registry, "quay.io");
    assert.equal(name.repository, "keycloak/keycloak");
    assert.equal(name.tag, "26.0");
  });

  it("recognizes a registry host that carries an explicit port (colon, no dot)", () => {
    const name = DockerImageName.parse("localhost:5000/myrepo:tag");
    assert.equal(name.registry, "localhost:5000");
    assert.equal(name.repository, "myrepo");
    assert.equal(name.tag, "tag");
  });

  it("recognizes the literal 'localhost' with no port as a registry host too", () => {
    const name = DockerImageName.parse("localhost/myrepo:tag");
    assert.equal(name.registry, "localhost");
    assert.equal(name.repository, "myrepo");
    assert.equal(name.tag, "tag");
  });

  it("parses a bare digest reference with no tag", () => {
    const name = DockerImageName.parse("postgres@sha256:abcd1234");
    assert.equal(name.repository, "postgres");
    assert.equal(name.tag, undefined);
    assert.equal(name.digest, "sha256:abcd1234");
  });

  it("parses a reference carrying both a tag and a digest", () => {
    const name = DockerImageName.parse("postgres:16@sha256:abcd1234");
    assert.equal(name.repository, "postgres");
    assert.equal(name.tag, "16");
    assert.equal(name.digest, "sha256:abcd1234");
  });

  it("parses registry + namespaced repository + tag + digest all together", () => {
    const name = DockerImageName.parse("quay.io/keycloak/keycloak:26.0@sha256:deadbeef");
    assert.equal(name.registry, "quay.io");
    assert.equal(name.repository, "keycloak/keycloak");
    assert.equal(name.tag, "26.0");
    assert.equal(name.digest, "sha256:deadbeef");
  });

  it("toString() returns the exact reference passed in, unmodified", () => {
    const raw = "quay.io/keycloak/keycloak:26.0@sha256:deadbeef";
    assert.equal(DockerImageName.parse(raw).toString(), raw);
  });
});

describe("DockerImageName.asCompatibleSubstituteFor", () => {
  it("does not mutate the original instance", () => {
    const original = DockerImageName.parse("mycorp/pg-hardened:16");
    const substitute = original.asCompatibleSubstituteFor("postgres");
    assert.equal(original.repository, "mycorp/pg-hardened");
    assert.equal(substitute.repository, "mycorp/pg-hardened");
    assert.equal(original.toString(), substitute.toString());
  });

  it("leaves the raw string verbatim — no rewriting of tag or repository", () => {
    const substitute = DockerImageName.parse("mycorp/pg-hardened:16").asCompatibleSubstituteFor("postgres");
    assert.equal(substitute.toString(), "mycorp/pg-hardened:16");
  });
});

describe("DockerImageName.requireCompatible", () => {
  it("accepts a plain string whose repository matches, returning it verbatim", () => {
    assert.equal(DockerImageName.requireCompatible("postgres:16", "postgres"), "postgres:16");
  });

  it("accepts a registry-qualified string whose stripped repository matches", () => {
    assert.equal(
      DockerImageName.requireCompatible("quay.io/keycloak/keycloak:26.0", "keycloak/keycloak"),
      "quay.io/keycloak/keycloak:26.0",
    );
  });

  it("accepts a DockerImageName instance directly, without re-parsing from a string", () => {
    const name = DockerImageName.parse("qdrant/qdrant:v1.18.3");
    assert.equal(DockerImageName.requireCompatible(name, "qdrant/qdrant"), "qdrant/qdrant:v1.18.3");
  });

  it("throws IncompatibleImageError, naming both repositories, on a plain mismatch", () => {
    try {
      DockerImageName.requireCompatible("mysql:8.4", "postgres");
      assert.ok(false, "expected requireCompatible to throw");
    } catch (err) {
      assert.ok(err instanceof IncompatibleImageError);
      const typed = err as IncompatibleImageError;
      assert.equal(typed.name, "IncompatibleImageError");
      assert.equal(typed.suppliedRepository, "mysql");
      assert.equal(typed.expectedRepository, "postgres");
      assert.match(typed.message, /'mysql'/);
      assert.match(typed.message, /'postgres'/);
      assert.match(typed.message, /asCompatibleSubstituteFor\("postgres"\)/);
    }
  });

  it("mismatch message names the SUPPLIED repository (registry-stripped), not the raw string", () => {
    try {
      DockerImageName.requireCompatible("quay.io/mycorp/mysql:8.4", "postgres");
      assert.ok(false, "expected requireCompatible to throw");
    } catch (err) {
      assert.ok(err instanceof IncompatibleImageError);
      assert.equal((err as IncompatibleImageError).suppliedRepository, "mycorp/mysql");
    }
  });

  it("the asCompatibleSubstituteFor escape hatch overrides the mismatch and returns the image verbatim", () => {
    const substitute = DockerImageName.parse("mycorp/pg-hardened:16").asCompatibleSubstituteFor("postgres");
    assert.equal(DockerImageName.requireCompatible(substitute, "postgres"), "mycorp/pg-hardened:16");
  });

  it("a substitute that still doesn't match the expected repository still throws", () => {
    const substitute = DockerImageName.parse("mycorp/pg-hardened:16").asCompatibleSubstituteFor("mysql");
    try {
      DockerImageName.requireCompatible(substitute, "postgres");
      assert.ok(false, "expected requireCompatible to throw");
    } catch (err) {
      assert.ok(err instanceof IncompatibleImageError);
      // The error still names the image's OWN parsed repository, not the
      // substitute target that itself failed to match.
      assert.equal((err as IncompatibleImageError).suppliedRepository, "mycorp/pg-hardened");
      assert.equal((err as IncompatibleImageError).expectedRepository, "postgres");
    }
  });

  it("a tag/digest never affects the compatibility comparison", () => {
    assert.equal(
      DockerImageName.requireCompatible("qdrant/qdrant@sha256:deadbeef", "qdrant/qdrant"),
      "qdrant/qdrant@sha256:deadbeef",
    );
  });
});
