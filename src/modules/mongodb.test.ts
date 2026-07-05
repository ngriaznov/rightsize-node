import { describe, it, assert } from "../../test/harness.js";
import { MongoDBContainer } from "./mongodb.js";
import { FakeModuleBackend, instantReadyWait } from "./test-fake-backend.js";
import type { ExecResult } from "../core/model.js";

/** A fake exec that reports rs.initiate and db.hello() as already satisfied on the first call, so containerIsStarted's poll resolves immediately instead of racing the module's own 60s deadline. */
function instantPrimaryExec(): (cmd: ReadonlyArray<string>) => Promise<ExecResult> {
  return async (cmd) => {
    const joined = cmd.join(" ");
    if (joined.includes("isWritablePrimary")) {
      return { exitCode: 0, stdout: "true\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

describe("MongoDBContainer", () => {
  it("exposes port 27017 and runs mongod as a one-member replica set", async () => {
    const backend = new FakeModuleBackend();
    backend.execImpl = instantPrimaryExec();
    const mongo = new MongoDBContainer().withBackend(backend).waitingFor(instantReadyWait());
    await mongo.start();
    try {
      assert.equal(backend.lastSpec?.image, "mongo:8.0");
      assert.deepEqual(backend.lastSpec?.ports.map((p) => p.guestPort), [27017]);
      assert.deepEqual(backend.lastSpec?.command, ["mongod", "--replSet", "docker-rs", "--bind_ip_all"]);
    } finally {
      await mongo.stop();
    }
  });

  it("builds a connectionString and replicaSetUrl alias from host and mapped port", async () => {
    const backend = new FakeModuleBackend();
    backend.execImpl = instantPrimaryExec();
    const mongo = new MongoDBContainer().withBackend(backend).waitingFor(instantReadyWait());
    await mongo.start();
    try {
      const mapped = mongo.getMappedPort(27017);
      const expected = `mongodb://127.0.0.1:${mapped}/test?directConnection=true`;
      assert.equal(mongo.connectionString, expected);
      assert.equal(mongo.replicaSetUrl, expected);
    } finally {
      await mongo.stop();
    }
  });

  it("containerIsStarted retries rs.initiate and db.hello() through transient exec failures", async () => {
    const backend = new FakeModuleBackend();
    let initiateAttempts = 0;
    let helloAttempts = 0;
    backend.execImpl = async (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("rs.initiate")) {
        initiateAttempts++;
        if (initiateAttempts < 2) {
          return { exitCode: 1, stdout: "", stderr: "not ready yet" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (joined.includes("isWritablePrimary")) {
        helloAttempts++;
        if (helloAttempts < 2) {
          return { exitCode: 0, stdout: "false\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "true\n", stderr: "" };
      }
      throw new Error(`unexpected exec: ${joined}`);
    };
    const mongo = new MongoDBContainer().withBackend(backend).waitingFor(instantReadyWait());
    await mongo.start();
    try {
      assert.ok(initiateAttempts >= 2, "expected rs.initiate to be retried");
      assert.ok(helloAttempts >= 2, "expected db.hello() to be retried");
    } finally {
      await mongo.stop();
    }
  });

  it("accepts a custom image tag via the constructor", async () => {
    const backend = new FakeModuleBackend();
    backend.execImpl = instantPrimaryExec();
    const mongo = new MongoDBContainer("mongo:8.2.3").withBackend(backend).waitingFor(instantReadyWait());
    await mongo.start();
    try {
      assert.equal(backend.lastSpec?.image, "mongo:8.2.3");
    } finally {
      await mongo.stop();
    }
  });

});
