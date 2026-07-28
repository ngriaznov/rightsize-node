import { describe, it, assert } from "../../test/harness.js";
import { ElasticsearchContainer } from "./elasticsearch.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";
import { DockerImageName } from "../core/docker-image-name.js";
import { IncompatibleImageError } from "../core/errors.js";

describe("ElasticsearchContainer", () => {
  it("exposes 9200/9300, sets single-node/security/heap env, and raises the memory ceiling to 2560", async () => {
    const backend = new FakeModuleBackend();
    const es = new ElasticsearchContainer("elasticsearch:9.4.4").withBackend(backend).waitingFor(instantReadyWait());
    await es.start();
    try {
      assert.equal(backend.lastSpec?.image, "elasticsearch:9.4.4");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [9200, 9300]);
      assert.equal(backend.lastSpec?.memoryLimitMb, 2560);
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("discovery.type"), "single-node");
      assert.equal(env.get("xpack.security.enabled"), "false");
      assert.equal(env.get("ES_JAVA_OPTS"), "-Xms512m -Xmx512m");
    } finally {
      await es.stop();
    }
  });

  it("builds restUrl from host and the mapped REST port", async () => {
    const backend = new FakeModuleBackend();
    const es = new ElasticsearchContainer("elasticsearch:9.4.4").withBackend(backend).waitingFor(instantReadyWait());
    await es.start();
    try {
      const mapped = es.getMappedPort(9200);
      assert.equal(es.restUrl, `http://127.0.0.1:${mapped}`);
    } finally {
      await es.stop();
    }
  });

  it("accepts a plain string image whose repository matches", async () => {
    const backend = new FakeModuleBackend();
    const es = new ElasticsearchContainer("elasticsearch:8.19.19").withBackend(backend).waitingFor(instantReadyWait());
    await es.start();
    try {
      assert.equal(backend.lastSpec?.image, "elasticsearch:8.19.19");
    } finally {
      await es.stop();
    }
  });

  it("accepts a DockerImageName instance whose repository matches", async () => {
    const backend = new FakeModuleBackend();
    const image = DockerImageName.parse("elasticsearch:9.4.4");
    const es = new ElasticsearchContainer(image).withBackend(backend).waitingFor(instantReadyWait());
    await es.start();
    try {
      assert.equal(backend.lastSpec?.image, "elasticsearch:9.4.4");
    } finally {
      await es.stop();
    }
  });

  it("throws IncompatibleImageError before start() for a mismatched repository", () => {
    try {
      new ElasticsearchContainer("mysql:8.4");
      assert.ok(false, "expected the constructor to throw");
    } catch (err) {
      assert.ok(err instanceof IncompatibleImageError);
      assert.equal((err as IncompatibleImageError).suppliedRepository, "mysql");
      assert.equal((err as IncompatibleImageError).expectedRepository, "elasticsearch");
    }
  });

  it("accepts a mismatched image explicitly marked asCompatibleSubstituteFor('elasticsearch')", async () => {
    const backend = new FakeModuleBackend();
    const substitute = DockerImageName.parse("mycorp/elasticsearch-hardened:9.4.4").asCompatibleSubstituteFor("elasticsearch");
    const es = new ElasticsearchContainer(substitute).withBackend(backend).waitingFor(instantReadyWait());
    await es.start();
    try {
      assert.equal(backend.lastSpec?.image, "mycorp/elasticsearch-hardened:9.4.4");
    } finally {
      await es.stop();
    }
  });
});
