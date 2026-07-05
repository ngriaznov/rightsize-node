// Redis quickstart — the library's signature lifecycle.
//
// `await using` disposes the container automatically at the end of this
// function's scope: stopped, removed, its port freed, no explicit
// try/finally needed. That is the one thing to take away from this file.
//
// Run (from the repo root):
//   npm run example:redis
//
// Switch backends explicitly (auto-selects otherwise — see README#backends):
//   RIGHTSIZE_BACKEND=docker npm run example:redis
//   RIGHTSIZE_BACKEND=microsandbox npm run example:redis

import "rightsize/backend-msb";
import "rightsize/backend-docker";
import { RedisContainer } from "rightsize/modules";
import { createClient } from "redis";

async function main(): Promise<void> {
  await using redis = await RedisContainer.start(); // boots a real container/microVM
  console.log("redis is up at", redis.uri);

  const client = createClient({ url: redis.uri });
  await client.connect();
  await client.set("greeting", "hello from rightsize");
  console.log("GET greeting ->", await client.get("greeting"));
  await client.quit();

  // No explicit stop() call: `redis` is disposed here, at scope exit,
  // whether main() returns normally or throws.
}

await main();
console.log("done — redis container was stopped and removed automatically");
