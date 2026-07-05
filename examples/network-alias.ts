// Two containers on one Network, reachable by alias — the same API whether
// the containers underneath are Docker containers on a bridge network or
// fully isolated microVMs with no shared network at all (see
// docs/guide/networking.md for what each backend does under the hood).
//
// Run (from the repo root):
//   npm run example:network
//
// Switch backends explicitly:
//   RIGHTSIZE_BACKEND=docker npm run example:network
//   RIGHTSIZE_BACKEND=microsandbox npm run example:network

import "rightsize/backend-msb";
import "rightsize/backend-docker";
import { GenericContainer, Network, Wait } from "rightsize";

async function main(): Promise<void> {
  await using net = Network.newNetwork();

  await using cache = await new GenericContainer("redis:8.6-alpine")
    .withNetwork(net)
    .withNetworkAliases("cache")
    .withExposedPorts(6379)
    .waitingFor(Wait.forListeningPort())
    .start();

  console.log("cache resolves on the network as", net.resolve("cache", 6379));

  // A second container on the same network reaches the first by alias. A
  // retry loop (not a single attempt) is the right shape here: on the
  // microsandbox backend the alias/tunnel takes a moment to come up after
  // the target container starts, the same way any freshly published
  // service does.
  await using consumer = await new GenericContainer("redis:8.6-alpine")
    .withNetwork(net)
    .withCommand("sh", "-c", "for i in $(seq 1 20); do redis-cli -h cache -p 6379 ping && exit 0; sleep 1; done; exit 1")
    .waitingFor(Wait.forLogMessage("PONG", 1).withStartupTimeout(30_000))
    .start();

  const logs = await consumer.logs();
  console.log("consumer reached cache by alias, saw PONG:", logs.includes("PONG"));
}

await main();
console.log("done — both containers were stopped and the network released automatically");
