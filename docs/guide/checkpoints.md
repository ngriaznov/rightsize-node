# Checkpoint / restore

Commit a running container's filesystem to an image, then boot new
containers from it — a fast way to skip repeated boot-and-seed work across a
test suite.

## What this actually captures

**A checkpoint is a filesystem capture, not a memory snapshot.** `checkpoint()`
commits the container's current filesystem to a new image; `fromCheckpoint()`
boots a fresh container from that image. Whatever was on disk when you
checkpointed — a migrated schema, seeded rows, a config file you wrote via
`exec` — is there in every restored container. Whatever was only in memory —
open connections, in-flight requests, anything the process hadn't flushed to
disk — is not. The restored container's processes start from scratch, the
same as any other freshly-booted container; nothing resumes mid-execution.

True microVM memory snapshots (where a restored sandbox resumes running code
mid-instruction) need upstream microsandbox support and aren't available on
either backend yet — see [Roadmap](/guide/roadmap).

## Backend support

```ts
import "rightsize/backend-docker";
import { Backends } from "rightsize";

const caps = Backends.active().capabilities;
console.log(caps.checkpoint); // true on docker, false on microsandbox
```

| | docker | microsandbox |
|---|---|---|
| `capabilities.checkpoint` | `true` — implemented via image commit | `false` — no upstream microVM snapshot support yet |

Calling `checkpoint()` against a backend whose `capabilities.checkpoint` is
`false` throws `CheckpointUnsupportedError` before any backend call is ever
made — no wasted commit attempt, no partial state.

## Basic usage

```ts
import { GenericContainer, Wait } from "rightsize";

const source = await new GenericContainer("postgres:16-alpine")
  .withEnv("POSTGRES_PASSWORD", "test")
  .withExposedPorts(5432)
  .waitingFor(Wait.forListeningPort())
  .start();

// ...migrate and seed the database via exec or a client connection...

const checkpoint = await source.checkpoint();
// { imageRef: "rightsize/checkpoint:<12-hex>", spec: <source's ContainerSpec> }
await source.stop();

// Later, possibly in a different test:
await using restored = await GenericContainer.fromCheckpoint(checkpoint)
  .waitingFor(Wait.forListeningPort())
  .start();
// restored already has the migrated schema and seeded rows on disk.
```

`checkpoint()` requires a currently-running container — calling it before
`start()` or after `stop()` throws the same state error `exec()`/`logs()` do.

## `fromCheckpoint()`: an ordinary container, just with a different image

`GenericContainer.fromCheckpoint(checkpoint)` returns a normal builder whose
image is `checkpoint.imageRef` and whose env, command, exposed ports, and
memory limit default to the source container's spec. Chain further builder
calls — a different `waitingFor`, `withBackend`, extra `withEnv` — the same
as any other `GenericContainer`, before calling `start()`:

```ts
import { GenericContainer, Wait } from "rightsize";
import type { Checkpoint } from "rightsize";

async function restore(checkpoint: Checkpoint): Promise<GenericContainer> {
  return GenericContainer.fromCheckpoint(checkpoint)
    .withEnv("EXTRA_FLAG", "1") // override/extend beyond the checkpoint's own env
    .waitingFor(Wait.forListeningPort())
    .start();
}
```

A restored container is ordinary in every other respect once started: fresh
host ports (never the source's old ones), normal
[orphan-reaping ledger](/guide/reaping) tracking, normal `stop()`. Network
topology, mounts, and `keepAlive` are never carried over from the source
spec — the committed image already has the filesystem baked in, and (the
same reasoning as [reuse](/guide/reuse)'s network restriction) topology was
never part of what a checkpoint captures.

## The seeded-database fixture pattern

The main payoff: boot and seed a database ONCE per suite, checkpoint it, then
restore a fresh copy per test instead of re-running migrations and seed data
every time.

```ts
import { GenericContainer, Wait } from "rightsize";
import type { Checkpoint } from "rightsize";

let seeded: Checkpoint;

async function suiteSetup(): Promise<void> {
  await using source = await new GenericContainer("postgres:16-alpine")
    .withEnv("POSTGRES_PASSWORD", "test")
    .withExposedPorts(5432)
    .waitingFor(Wait.forListeningPort())
    .start();

  // ...run migrations, seed fixture rows...

  seeded = await source.checkpoint();
}

async function perTestSetup(): Promise<GenericContainer> {
  return GenericContainer.fromCheckpoint(seeded)
    .waitingFor(Wait.forListeningPort())
    .start();
}
```

Each test gets its own restored container, isolated from every other test's
writes, without paying the migration/seed cost more than once per suite run.

## Cleanup: checkpoint images are not auto-reaped

The [orphan reaper](/guide/reaping) tracks *containers*, not images —
`checkpoint()`'s committed image is never appended to the reaping ledger and
is never removed by a sweep, a watchdog, or `close()`. Clean up committed
images by hand once a suite is done with them:

```bash
docker rmi $(docker images -q rightsize/checkpoint)
```

## microsandbox

`checkpoint()` throws `CheckpointUnsupportedError` on the microsandbox
backend today — there is no upstream microVM snapshot mechanism to build on
yet. The error names the active backend and points at the docker fallback:

```
checkpoint() is not supported by the 'microsandbox' backend — checkpoint/restore
is implemented via image commit on the docker backend today; native microVM
memory snapshots for microsandbox are on the roadmap. Set RIGHTSIZE_BACKEND=docker
to use checkpoint/restore.
```

Native microVM memory snapshots — a restored sandbox that resumes
mid-execution rather than rebooting — remain on the [roadmap](/guide/roadmap),
gated on upstream microsandbox support.
