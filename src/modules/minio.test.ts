import { describe, it, assert } from "../../test/harness.js";
import { MinIOContainer } from "./minio.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";
import { DockerImageName } from "../core/docker-image-name.js";
import { IncompatibleImageError } from "../core/errors.js";

describe("MinIOContainer", () => {
  it("exposes 9000/9001, sets the command, and defaults to testuser/testpassword", async () => {
    const backend = new FakeModuleBackend();
    const minio = new MinIOContainer().withBackend(backend).waitingFor(instantReadyWait());
    await minio.start();
    try {
      assert.equal(backend.lastSpec?.image, "minio/minio:latest");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [9000, 9001]);
      assert.deepEqual(backend.lastSpec?.command, ["server", "/data", "--console-address", ":9001"]);
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("MINIO_ROOT_USER"), "testuser");
      assert.equal(env.get("MINIO_ROOT_PASSWORD"), "testpassword");
    } finally {
      await minio.stop();
    }
  });

  it("withRootUser/withRootPassword override the defaults and the accessors reflect them", async () => {
    const backend = new FakeModuleBackend();
    const minio = new MinIOContainer()
      .withBackend(backend)
      .waitingFor(instantReadyWait())
      .withRootUser("admin")
      .withRootPassword("supersecret1");
    await minio.start();
    try {
      assert.equal(minio.rootUser, "admin");
      assert.equal(minio.rootPassword, "supersecret1");
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("MINIO_ROOT_USER"), "admin");
      assert.equal(env.get("MINIO_ROOT_PASSWORD"), "supersecret1");
    } finally {
      await minio.stop();
    }
  });

  it("builds endpointUrl from host and the mapped API port", async () => {
    const backend = new FakeModuleBackend();
    const minio = new MinIOContainer().withBackend(backend).waitingFor(instantReadyWait());
    await minio.start();
    try {
      const mapped = minio.getMappedPort(9000);
      assert.equal(minio.endpointUrl, `http://127.0.0.1:${mapped}`);
    } finally {
      await minio.stop();
    }
  });

  it("accepts a custom image tag via the constructor", async () => {
    const backend = new FakeModuleBackend();
    const minio = new MinIOContainer("minio/minio:RELEASE.2025-09-08T00-00-00Z").withBackend(backend).waitingFor(instantReadyWait());
    await minio.start();
    try {
      assert.equal(backend.lastSpec?.image, "minio/minio:RELEASE.2025-09-08T00-00-00Z");
    } finally {
      await minio.stop();
    }
  });

  it("accepts a DockerImageName instance whose repository matches", async () => {
    const backend = new FakeModuleBackend();
    const image = DockerImageName.parse("minio/minio:RELEASE.2025-09-08T00-00-00Z");
    const minio = new MinIOContainer(image).withBackend(backend).waitingFor(instantReadyWait());
    await minio.start();
    try {
      assert.equal(backend.lastSpec?.image, "minio/minio:RELEASE.2025-09-08T00-00-00Z");
    } finally {
      await minio.stop();
    }
  });

  it("throws IncompatibleImageError before start() for a mismatched repository", () => {
    try {
      new MinIOContainer("mongo:latest");
      assert.ok(false, "expected the constructor to throw");
    } catch (err) {
      assert.ok(err instanceof IncompatibleImageError);
      assert.equal((err as IncompatibleImageError).suppliedRepository, "mongo");
      assert.equal((err as IncompatibleImageError).expectedRepository, "minio/minio");
    }
  });

  it("accepts a mismatched image explicitly marked asCompatibleSubstituteFor('minio/minio')", async () => {
    const backend = new FakeModuleBackend();
    const substitute = DockerImageName.parse("mycorp/minio-hardened:2025").asCompatibleSubstituteFor("minio/minio");
    const minio = new MinIOContainer(substitute).withBackend(backend).waitingFor(instantReadyWait());
    await minio.start();
    try {
      assert.equal(backend.lastSpec?.image, "mycorp/minio-hardened:2025");
    } finally {
      await minio.stop();
    }
  });
});
