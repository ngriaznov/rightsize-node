import * as net from "node:net";
import * as http from "node:http";
import "../backend-msb/index.js";
import "../backend-docker/index.js";
import { describe, itIntegration, assert } from "../../test/harness.js";
import { RedisContainer } from "./redis.js";
import { MemcachedContainer } from "./memcached.js";
import { ArangoContainer } from "./arango.js";
import { MongoDBContainer } from "./mongodb.js";

/**
 * Live gates for the simple single-node datastore modules, run against
 * whichever backend `RIGHTSIZE_BACKEND` selects (`docker` or
 * `microsandbox`). Each container is stopped in a `finally` so a failed
 * assertion never leaves a live sandbox/container behind.
 */

function redisRoundTrip(uri: string): Promise<string> {
  const url = new URL(uri);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname);
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      if (buffered.includes("+PONG")) {
        socket.end();
        resolve(buffered);
      }
    });
    socket.on("error", reject);
    socket.on("connect", () => socket.write("PING\r\n"));
  });
}

function httpGetJson(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 5_000 }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("request timed out"));
    });
  });
}

describe("datastore modules", () => {
  itIntegration("Redis: boots and answers a PING over its uri", async () => {
    const redis = await RedisContainer.start();
    try {
      const reply = await redisRoundTrip(redis.uri);
      assert.match(reply, /\+PONG/);
    } finally {
      await redis.stop();
    }
  });

  itIntegration("Memcached: boots and answers a version probe on its address", async () => {
    const mc = await MemcachedContainer.start();
    try {
      const [host, portStr] = mc.address.split(":");
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(Number(portStr), host);
        // The container already passed MemcachedRespondsStrategy's own
        // protocol-level probe before start() returned, so a real memcached
        // is definitely listening — but this is a brand-new connection, not
        // that same probe socket, and a bare `net` promise with no timeout
        // hangs forever on a dropped write or a swallowed 'data' event
        // instead of failing loudly. A 10s socket timeout turns that would-be
        // hang into a normal test failure.
        socket.setTimeout(10_000);
        socket.on("connect", () => socket.write("version\r\n"));
        socket.on("data", (chunk) => {
          socket.end();
          resolve(chunk.toString("utf8"));
        });
        socket.on("timeout", () => {
          socket.destroy();
          reject(new Error("timed out waiting for a VERSION reply from memcached"));
        });
        socket.on("error", reject);
      });
      assert.match(reply, /^VERSION/);
    } finally {
      await mc.stop();
    }
  });

  itIntegration("ArangoDB: boots with no-auth and serves /_api/version", async () => {
    const arango = await ArangoContainer.start();
    try {
      const res = await httpGetJson(`${arango.endpoint}/_api/version`);
      assert.equal(res.status, 200);
      assert.match(res.body, /"version"/);
    } finally {
      await arango.stop();
    }
  });

  itIntegration("MongoDB: replica set has a writable primary immediately after start()", async () => {
    const mongo = await MongoDBContainer.start();
    try {
      const insert = await mongo.exec(
        "mongosh",
        "--quiet",
        "test",
        "--eval",
        "db.t.insertOne({x: 1}); db.t.countDocuments({x: 1})",
      );
      assert.equal(insert.exitCode, 0);
      assert.match(insert.stdout, /1/);
    } finally {
      await mongo.stop();
    }
  });
});
