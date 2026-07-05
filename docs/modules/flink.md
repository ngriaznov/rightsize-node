# Flink

A Flink JobManager container (REST + RPC), with an optional companion
TaskManager — **Docker only**.

**Default image:** `flink:1.20.5`
**Exposed ports:** `8081` (REST), `6123` (RPC)
**Wait strategy:** `Wait.forHttp("/overview").forPort(8081)`, 120s startup
timeout
**Memory:** `withMemoryLimit(1024)` on both the JobManager and, when
requested, the TaskManager

| Member | Returns |
|---|---|
| `FlinkContainer.start(image?)` | `Promise<FlinkContainer>` — boots the JobManager |
| `.withTaskManager()` | `this` — requests a companion TaskManager on a shared `Network`, started once the JobManager is ready. **Docker only** — see below |
| `.restUrl` | The REST base URL for the running JobManager |

## Example: JobManager only (both backends)

```ts
import { FlinkContainer } from "rightsize/modules";

await using flink = await FlinkContainer.start();
console.log(await (await fetch(`${flink.restUrl}/overview`)).json());
```

## Example: a full session cluster (Docker only)

```ts
import { FlinkContainer } from "rightsize/modules";

await using flink = await new FlinkContainer().withTaskManager().start();
// only reaches this point on the docker backend
console.log(await (await fetch(`${flink.restUrl}/taskmanagers`)).json()); // one registered TM
```

## Backend notes: the `withTaskManager()` limitation, stated precisely

A real Flink session cluster needs a TaskManager to run anything, and a
TaskManager registers with its JobManager over a **persistent bidirectional
RPC connection** (Pekko/Akka). Two independent facts rule this topology out
on the microsandbox backend:

1. **The `flink` image ships neither `nc` nor `busybox`** — confirmed
   directly against the pinned tag (`command -v nc` and `command -v busybox`
   both exit 127 inside the image). microsandbox's network-link emulation
   depends on an in-guest `nc -l` listener (see
   [Networking](/guide/networking)); without it, the emulation's own
   preflight probe fails before any tunnel could even be attempted.
2. **Independent of fact 1, the tunnel's client-speaks-first,
   one-connection-at-a-time contract wouldn't carry a persistent
   bidirectional RPC connection anyway** — but whether Flink's registration
   RPC would actually survive being pumped through the tunnel was never
   tested, because fact 1 already makes the attempt moot.

`withTaskManager()` therefore throws `UnsupportedByBackendError` the instant
`start()` resolves the microsandbox backend — before any network setup, port
allocation, or the JobManager container is even created — naming both the
missing binary and `RIGHTSIZE_BACKEND=docker` as the remedy. A **bare
JobManager** (no `withTaskManager()` call) boots and serves `/overview`
normally on microsandbox; only the two-container topology is affected. On
Docker, the same builder produces a real two-container session cluster with
the TaskManager registering successfully.
