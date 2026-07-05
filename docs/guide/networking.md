# Networking

`Network` gives containers alias-based connectivity on both backends — the
same API whether the containers underneath are Docker containers on a bridge
network or fully-isolated microVMs with no shared network at all.

```ts runnable
import "rightsize/backend-msb";
import "rightsize/backend-docker";
import { GenericContainer, Network, Wait } from "rightsize";

await using net = Network.newNetwork();

await using redis = await new GenericContainer("redis:8.6-alpine")
  .withNetwork(net)
  .withNetworkAliases("cache")
  .withExposedPorts(6379)
  .waitingFor(Wait.forListeningPort())
  .start();

// A second container on the same network reaches the first by alias —
// `net.resolve` returns the same "alias:port" shape on either backend. A
// retry loop (not a single attempt) is the right shape here: on the
// microsandbox backend the alias/tunnel takes a moment to come up after
// this container starts, the same way any freshly-published service does.
await using consumer = await new GenericContainer("redis:8.6-alpine")
  .withNetwork(net)
  .withCommand("sh", "-c", "for i in $(seq 1 20); do redis-cli -h cache -p 6379 ping && exit 0; sleep 1; done; exit 1")
  .waitingFor(Wait.forLogMessage("PONG", 1).withStartupTimeout(30_000))
  .start();

console.log(await consumer.logs()); // includes "PONG"
console.log(net.resolve("cache", 6379)); // "cache:6379"
```

`net.resolve(alias, guestPort)` returns `"alias:guestPort"` — identical string
shape on both backends — and throws, naming the alias, if no registered
member carries it. A container only contributes links to *later* joiners once
it's registered, which happens after its own network-link installation step,
so a container can never end up linked to itself.

## An HTTP config-fetch pattern

The shape above generalizes directly to the common "app depends on a config
service" case:

```ts
import { GenericContainer, Network, Wait } from "rightsize";

await using net = Network.newNetwork();

await using config = await new GenericContainer("hyness/spring-cloud-config-server:latest")
  .withNetwork(net)
  .withNetworkAliases("configuration-stub")
  .withExposedPorts(8888)
  .waitingFor(Wait.forHttp("/actuator/health").forPort(8888))
  .start();

await using app = await new GenericContainer("my-service:latest")
  .withNetwork(net)
  .withEnv("CONFIG_URI", `http://${net.resolve("configuration-stub", 8888)}`)
  .start();
```

## What each backend actually does under the hood

**On Docker:** this is a native Docker network alias — the daemon's own
bridge networking and embedded DNS resolve `alias:port` for you. No
emulation, no tunnel, full native container-to-container connectivity.

**On microsandbox:** microVMs are fully isolated from each other — there's no
shared bridge network to attach to. rightsize transparently installs:

1. An `/etc/hosts` entry inside the consuming container's guest, mapping the
   alias to `127.0.0.1`.
2. A TCP relay tunneled over the sandbox's `exec --stream` channel — the
   *only* guest data path available on this msb build (no sandbox→host TCP
   under any net-rule tried; SSH forwarding was found broken too). The tunnel
   pumps raw bytes, unbuffered, flush-per-read, in both directions.

This is real emulation, not a shortcut, and it has real limits.

## Limits on the microsandbox backend

- **Start dependencies before their consumers.** Network links are computed
  for a new member from whichever siblings are *already running* at the
  moment it joins. A container started before its dependency is up won't
  retroactively gain a link to it.
- **One connection at a time per tunnel.** The in-guest `nc -l` listener
  backing a tunnel serves one connection, then gets respawned for the next.
  Fine for config-fetch-style traffic; not fine for a long-lived
  cross-container consumer (a Kafka consumer reading continuously from a
  broker on a sibling microVM, say).
- **Client speaks first.** The tunnel protocol assumes the connecting side
  sends the first bytes — matches HTTP requests and most RPC-style
  protocols; a server that waits silently for the client to speak needs the
  client end to actually be the one initiating data, which HTTP/REST calls
  naturally are.
- **The consumer image needs `nc`/busybox.** The tunnel is implemented as a
  shelled-out `nc` listener inside the guest. An image without it (a
  scratch-based image, or one that stripped busybox) fails `start()` fast,
  with an error naming the missing binary and suggesting
  `RIGHTSIZE_BACKEND=docker` as the workaround — this is exactly what happens
  with `FlinkContainer.withTaskManager()` on microsandbox, documented on its
  [module page](/modules/flink).
- **A target that never propagates TCP close can't be detected by naive
  EOF.** The msb port-publish proxy doesn't propagate the target socket's
  close to the tunnel, so end-of-exchange is inferred from an idle window
  *after* the first byte arrives — not from the whole connection, which would
  wrongly truncate a slow-to-respond target. See
  [How It Works](/guide/how-it-works) for the two-phase timeout this uses.

Every one of these is a real capability gap versus Docker's native bridge
networking, not a timing quirk that resolves itself with retries — pick
`RIGHTSIZE_BACKEND=docker` for a network topology this doesn't fit.

## Duplicate ports and invalid aliases fail fast

Two siblings on one network both exposing the same guest port, or an alias
containing shell-breaking characters, both fail immediately with an
actionable message — before any tunnel is installed, not partway through a
boot.
