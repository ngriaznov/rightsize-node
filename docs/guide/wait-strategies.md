# Wait strategies

`waitingFor` decides when `start()` returns — before then, the container may
be created and even booting, but nothing about it is safe to use yet.

```ts
import { GenericContainer, Wait } from "rightsize";

await using c = await new GenericContainer("nginx:alpine")
  .withExposedPorts(80)
  .waitingFor(Wait.forHttp("/").forPort(80).forStatusCode(200))
  .start();
```

Every strategy shares the same shape: poll repeatedly (250ms apart) until
ready or a deadline passes (default 120s, override with
`.withStartupTimeout(ms)`), probing at least once even if the deadline has
already technically passed by the time polling starts — a 1ms timeout still
gets its one shot. Timing out throws `ContainerLaunchError` with a
description of the container and its last 50 log lines attached.

## `Wait.forListeningPort()`

The default when `waitingFor` is never called. Ready once every exposed port
accepts a real peer.

This is **not** a bare TCP connect. Docker's userland proxy (and
microsandbox's equivalent) accepts the published host port the instant the
container is created — before the process inside has actually called
`listen()`. A bare connect-and-declare-ready wait therefore reports readiness
before anything is truly listening. `forListeningPort` connects, then
attempts a bounded zero-byte read: an immediate EOF/reset means "a proxy
accepted with nobody behind it yet" (not ready); receiving data, or the read
timing out with the connection still open, means a real peer is there
(ready). This read-probe is why `forListeningPort` is trustworthy as a
default rather than merely convenient.

## `Wait.forHttp(path)`

```ts
import { Wait } from "rightsize";

Wait.forHttp("/health").forPort(8080).forStatusCode(200);
```

Ready once a GET to `path` returns the expected status (200 by default).
`.forPort(n)` targets a specific exposed guest port instead of the first one
declared. Prefer this whenever the workload has a real health endpoint — it's
a stronger readiness signal than a port merely accepting connections.

## `Wait.forLogMessage(pattern, times?)`

```ts
import { Wait } from "rightsize";

Wait.forLogMessage(".*started.*", 1);
```

Ready once a line matching the regex `pattern` has appeared at least `times`
times in the container's logs (default 1). A line matching both as a whole
line and as a substring still only counts once. `times: 0` means "ready
immediately, without even needing logs to be fetchable yet" — useful for a
container whose first probe may run before any log line exists.

**The `times` parameter exists because some entrypoints print their own
readiness line more than once.** PostgreSQL's official image, for instance,
starts its server once to run init scripts, shuts it down, and starts it
again for real — printing `"database system is ready to accept connections"`
both times. Waiting for the first occurrence races that restart: a client can
connect to the throwaway init-time server moments before it's torn down.
`PostgresContainer` (see [its module page](/modules/postgres)) waits for the
line's *second* occurrence for exactly this reason — the showcase case for
`times`.

## Readiness-probe caveats

These apply to both backends, not just microsandbox:

- **A listening-port wait can be satisfied before the in-guest process is
  actually ready to do useful work** — it only proves *a* process is
  listening and responding at the TCP level, not that the workload has
  finished its own startup (loaded a dataset, joined a cluster, run
  migrations). Prefer `forHttp`/`forLogMessage` whenever the image gives you
  a real readiness signal.
- **A protocol that doesn't speak on connect defeats even the read-probe.**
  Memcached, for instance, never sends anything until spoken to, and never
  logs anything on startup either — neither a listening-port wait nor a
  log-message wait can distinguish "up" from "still booting." Its module
  ships a bespoke `WaitStrategy` that sends a `version` command and requires
  a real `VERSION` reply — see `MemcachedRespondsStrategy` on the
  [Memcached module page](/modules/memcached) as a worked example if you need
  the same pattern for your own image.
