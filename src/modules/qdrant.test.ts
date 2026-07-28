import { describe, it, assert } from "../../test/harness.js";
import { QdrantContainer } from "./qdrant.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";
import { DockerImageName } from "../core/docker-image-name.js";
import { IncompatibleImageError } from "../core/errors.js";

describe("QdrantContainer", () => {
  it("defaults to qdrant/qdrant:latest and exposes 6333/6334", async () => {
    const backend = new FakeModuleBackend();
    const qdrant = new QdrantContainer().withBackend(backend).waitingFor(instantReadyWait());
    await qdrant.start();
    try {
      assert.equal(backend.lastSpec?.image, "qdrant/qdrant:latest");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [6333, 6334]);
      assert.equal(backend.lastSpec?.memoryLimitMb, undefined);
    } finally {
      await qdrant.stop();
    }
  });

  it("builds restUrl from host and the mapped REST port", async () => {
    const backend = new FakeModuleBackend();
    const qdrant = new QdrantContainer().withBackend(backend).waitingFor(instantReadyWait());
    await qdrant.start();
    try {
      const mapped = qdrant.getMappedPort(6333);
      assert.equal(qdrant.restUrl, `http://127.0.0.1:${mapped}`);
    } finally {
      await qdrant.stop();
    }
  });

  it("accepts a custom image tag via the constructor", async () => {
    const backend = new FakeModuleBackend();
    const qdrant = new QdrantContainer("qdrant/qdrant:v1.18.3").withBackend(backend).waitingFor(instantReadyWait());
    await qdrant.start();
    try {
      assert.equal(backend.lastSpec?.image, "qdrant/qdrant:v1.18.3");
    } finally {
      await qdrant.stop();
    }
  });

  it("accepts a DockerImageName instance whose repository matches", async () => {
    const backend = new FakeModuleBackend();
    const image = DockerImageName.parse("qdrant/qdrant:v1.18.3");
    const qdrant = new QdrantContainer(image).withBackend(backend).waitingFor(instantReadyWait());
    await qdrant.start();
    try {
      assert.equal(backend.lastSpec?.image, "qdrant/qdrant:v1.18.3");
    } finally {
      await qdrant.stop();
    }
  });

  it("accepts a registry-qualified image whose stripped repository matches", async () => {
    const backend = new FakeModuleBackend();
    const qdrant = new QdrantContainer("myregistry.example.com/qdrant/qdrant:v1.18.3")
      .withBackend(backend)
      .waitingFor(instantReadyWait());
    await qdrant.start();
    try {
      assert.equal(backend.lastSpec?.image, "myregistry.example.com/qdrant/qdrant:v1.18.3");
    } finally {
      await qdrant.stop();
    }
  });

  it("throws IncompatibleImageError before start() for a mismatched repository", () => {
    try {
      new QdrantContainer("elasticsearch:9.4.4");
      assert.ok(false, "expected the constructor to throw");
    } catch (err) {
      assert.ok(err instanceof IncompatibleImageError);
      assert.equal((err as IncompatibleImageError).suppliedRepository, "elasticsearch");
      assert.equal((err as IncompatibleImageError).expectedRepository, "qdrant/qdrant");
    }
  });

  it("accepts a mismatched image explicitly marked asCompatibleSubstituteFor('qdrant/qdrant')", async () => {
    const backend = new FakeModuleBackend();
    const substitute = DockerImageName.parse("mycorp/qdrant-hardened:1.0").asCompatibleSubstituteFor("qdrant/qdrant");
    const qdrant = new QdrantContainer(substitute).withBackend(backend).waitingFor(instantReadyWait());
    await qdrant.start();
    try {
      assert.equal(backend.lastSpec?.image, "mycorp/qdrant-hardened:1.0");
    } finally {
      await qdrant.stop();
    }
  });
});
