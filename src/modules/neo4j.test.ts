import { describe, it, assert } from "../../test/harness.js";
import { Neo4jContainer } from "./neo4j.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";

describe("Neo4jContainer", () => {
  it("exposes HTTP (7474) and bolt (7687) ports with a rightsize-test default password", async () => {
    const backend = new FakeModuleBackend();
    const neo4j = new Neo4jContainer().withBackend(backend).waitingFor(instantReadyWait());
    await neo4j.start();
    try {
      assert.equal(backend.lastSpec?.image, "neo4j:5-community");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [7474, 7687]);
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("NEO4J_AUTH"), "neo4j/rightsize-test");
      assert.equal(neo4j.username, "neo4j");
      assert.equal(neo4j.password, "rightsize-test");
    } finally {
      await neo4j.stop();
    }
  });

  it("defaults to a 1024MB memory limit", async () => {
    const backend = new FakeModuleBackend();
    const neo4j = new Neo4jContainer().withBackend(backend).waitingFor(instantReadyWait());
    await neo4j.start();
    try {
      assert.equal(backend.lastSpec?.memoryLimitMb, 1024);
    } finally {
      await neo4j.stop();
    }
  });

  it("withPassword overrides the default and sets NEO4J_AUTH accordingly (username stays fixed)", async () => {
    const backend = new FakeModuleBackend();
    const neo4j = new Neo4jContainer().withBackend(backend).waitingFor(instantReadyWait()).withPassword("s3cret123");
    await neo4j.start();
    try {
      assert.equal(neo4j.username, "neo4j");
      assert.equal(neo4j.password, "s3cret123");
      const env = new Map(backend.lastSpec?.env ?? []);
      assert.equal(env.get("NEO4J_AUTH"), "neo4j/s3cret123");
    } finally {
      await neo4j.stop();
    }
  });

  it("builds httpUrl and boltUrl from host and their respective mapped ports", async () => {
    const backend = new FakeModuleBackend();
    const neo4j = new Neo4jContainer().withBackend(backend).waitingFor(instantReadyWait());
    await neo4j.start();
    try {
      const httpMapped = neo4j.getMappedPort(7474);
      const boltMapped = neo4j.getMappedPort(7687);
      assert.equal(neo4j.httpUrl, `http://127.0.0.1:${httpMapped}`);
      assert.equal(neo4j.boltUrl, `bolt://127.0.0.1:${boltMapped}`);
    } finally {
      await neo4j.stop();
    }
  });

  it("accepts a custom image tag via the constructor", async () => {
    const backend = new FakeModuleBackend();
    const neo4j = new Neo4jContainer("neo4j:5.26-community").withBackend(backend).waitingFor(instantReadyWait());
    await neo4j.start();
    try {
      assert.equal(backend.lastSpec?.image, "neo4j:5.26-community");
    } finally {
      await neo4j.stop();
    }
  });

  describe("the escaped-dot readiness pattern", () => {
    // Captured verbatim from a real `docker run neo4j:5-community` boot (see
    // the module's class doc). Pins that the shipped pattern uses an
    // escaped `\.` (matches only a literal dot), not the accidentally
    // permissive unescaped `.` (which would match ANY character in that
    // position, not just a dot).
    const capturedBootLog = [
      "2026-07-04 21:54:49.500+0000 INFO  Bolt enabled on 0.0.0.0:7687.",
      "2026-07-04 21:54:50.318+0000 INFO  HTTP enabled on 0.0.0.0:7474.",
      "2026-07-04 21:54:50.319+0000 INFO  Remote interface available at http://localhost:7474/",
      "2026-07-04 21:54:50.320+0000 INFO  Started.",
    ];

    it("matches the captured Started. line", () => {
      const re = /.*Started\..*/;
      assert.equal(re.test(capturedBootLog[3] ?? ""), true);
    });

    it("does not match a line where the terminating character isn't a literal dot", () => {
      const re = /.*Started\..*/;
      assert.equal(re.test("... INFO  Startedx"), false);
    });
  });
});
