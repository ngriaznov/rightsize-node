# Checkpoint / restore

Capture a running container's state, then boot new containers from it — a
fast way to skip repeated boot-and-seed work across a test suite.

## What this actually captures

**A checkpoint is a filesystem capture, not a memory snapshot.** `checkpoint()`
captures the container's current filesystem; `fromCheckpoint()` boots a fresh
container from that capture. Whatever was on disk when you checkpointed — a
migrated schema, seeded rows, a config file you wrote via `exec` or
[`copyFileToContainer`/`copyContentToContainer`](/guide/copy) — is there
in every restored container. Whatever was only in memory — open connections,
in-flight requests, anything the process hadn't flushed to disk — is not. If you
have just written files via `exec`, run `sync` in the guest before checkpointing —
an unflushed write is exactly the kind of state a checkpoint does not capture.
That includes RAM-backed mounts: the microsandbox guest mounts `/tmp` as tmpfs,
so files written there never enter a checkpoint — write anything you need
restored to a rootfs path such as `/srv` or `/var`.
The restored container's processes start from scratch, the same as any
other freshly-booted container; nothing resumes mid-execution.

True microVM memory snapshots (where a restored sandbox resumes running code
mid-instruction) need upstream microsandbox support and aren't available on
either backend yet — see [Roadmap](/guide/roadmap).

## Backend support

Both backends support checkpoint/restore today, via two different
mechanisms:

| | docker | microsandbox |
|---|---|---|
| Mechanism | Commit the running container to a new image | Stops the sandbox, snapshots its disk, and boots it back from that snapshot under the same name and ports |
| `capabilities.checkpoint` | `true` | `true` |
| `capabilities.checkpointRestartsWorkload` | `false` — the container is undisturbed | `true` — the workload restarts |
| Ref format | `rightsize/checkpoint:<12-hex>` (an image tag) | `rz-ckpt-<12-hex>` (a snapshot name) |
| Cleanup one-liner | `docker rmi rightsize/checkpoint:<ref>` | `msb snapshot rm rz-ckpt-<ref>` |

```ts
import "rightsize/backend-msb";
import { Backends } from "rightsize";

const caps = Backends.active().capabilities;
console.log(caps.checkpoint); // true on both backends today
console.log(caps.checkpointRestartsWorkload); // true on microsandbox, false on docker
```

On microsandbox, the stop/snapshot/reboot cycle means the sandbox's workload
genuinely restarts — `checkpoint()` re-runs the container's own wait strategy
before returning, so you never get back a container that looks ready but
whose workload hasn't actually come back up yet. On docker, commit-to-image
never touches the running container at all, so no re-wait happens there.
If the container was joined to a `Network`, its network links are also
re-established as part of the same cycle, before the wait strategy runs.

Calling `checkpoint()` against a backend whose `capabilities.checkpoint` is
`false` (a test double, in practice — both real backends have it) throws
`CheckpointUnsupportedError` before any backend call is ever made.

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
// { ref: "rightsize/checkpoint:<12-hex>" (docker) or "rz-ckpt-<12-hex>" (msb),
//   backend: "docker" | "microsandbox", spec: <source's ContainerSpec> }
await source.stop();

// Later, possibly in a different test:
await using restored = await GenericContainer.fromCheckpoint(checkpoint)
  .waitingFor(Wait.forListeningPort())
  .start();
// restored already has the migrated schema and seeded rows on disk.
```

`checkpoint()` requires a currently-running container — calling it before
`start()` or after `stop()` throws the same state error `exec()`/`logs()` do.

## Restoring under a different backend

A checkpoint is only meaningful to the backend that created it — a docker
image tag means nothing to `msb`, and a microsandbox snapshot name means
nothing to docker. `GenericContainer.fromCheckpoint(cp).start()` checks
`cp.backend` against the backend that would actually run it and throws
`CheckpointBackendMismatchError` before any backend call if they differ:

```
this checkpoint was created on the 'docker' backend but the active backend
is 'microsandbox' — set RIGHTSIZE_BACKEND=docker to restore it there, or
create a fresh checkpoint under the 'microsandbox' backend instead.
```

## `fromCheckpoint()`: an ordinary container, just with a different image

`GenericContainer.fromCheckpoint(checkpoint)` returns a normal builder whose
image is `checkpoint.ref` and whose env, command, exposed ports, and memory
limit default to the source container's spec. Chain further builder calls —
a different `waitingFor`, `withBackend`, extra `withEnv` — the same as any
other `GenericContainer`, before calling `start()`:

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
spec — the captured state already has the filesystem baked in, and (the
same reasoning as [reuse](/guide/reuse)'s network restriction) topology was
never part of what a checkpoint captures.

`fromCheckpoint()` combined with `.withReuse()` throws
`ReuseFromCheckpointError` once reuse is actually double opt-in active —
reuse's identity hash doesn't cover a checkpoint ref, so an adopted sandbox
could never be verified against the checkpoint it was meant to restore. Drop
one or the other.

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

## Reusing checkpoints across runs

Passing a name to `checkpoint()` makes it durable and rediscoverable — not
just something the current process can pass to `fromCheckpoint()`, but
something a LATER process (a later test run, a different CI job) can look up
by name:

```ts
import { GenericContainer, Checkpoints, Wait } from "rightsize";

async function seededDatabase(): Promise<GenericContainer> {
  const existing = await Checkpoints.find("seeded-db");
  if (existing !== undefined) {
    return GenericContainer.fromCheckpoint(existing).waitingFor(Wait.forListeningPort()).start();
  }

  await using source = await new GenericContainer("postgres:16-alpine")
    .withEnv("POSTGRES_PASSWORD", "test")
    .withExposedPorts(5432)
    .waitingFor(Wait.forListeningPort())
    .start();

  // ...run migrations, seed fixture rows...

  const seeded = await source.checkpoint("seeded-db");
  return GenericContainer.fromCheckpoint(seeded).waitingFor(Wait.forListeningPort()).start();
}
```

The first run pays the migrate-and-seed cost once and checkpoints it under a
name; every later run — same process or not — finds it instantly via
`Checkpoints.find` and skips straight to `fromCheckpoint()`.

### Names, refs, and replace semantics

A checkpoint name must match `^[a-z0-9][a-z0-9-]{0,40}$` — lowercase
letters, digits, and hyphens, starting with a letter or digit, at most 41
characters — checked before any backend call; an invalid name throws
`InvalidCheckpointNameError`. The name also makes the ref deterministic:
`rightsize/checkpoint:<name>` on docker, `rz-ckpt-<name>` on microsandbox,
instead of a random 12-hex suffix.

Checkpointing under a name that's already taken REPLACES it: the same
deterministic ref means the old artifact under that name is best-effort
cleared before the new one is created, and the registry entry is overwritten
— the latest checkpoint under a name always wins. Omitting `name` keeps
`checkpoint()`'s original behavior exactly: a random ref, no registry entry,
purely ephemeral.

### The registry

A named checkpoint writes one JSON file, `<cacheDir>/checkpoints/<name>.json`
(see [Configuration](/guide/configuration) for where the cache directory
lives), only after the backend checkpoint itself has succeeded — a failed
`checkpoint(name)` call never leaves a stale registry entry behind. The file
holds the ref, the creating backend's name, a creation timestamp, and the
reduced subset of the source container's spec `fromCheckpoint()` actually
needs (env, command, exposed ports, memory limit) — the same shape is pinned
byte-for-byte across every rightsize language implementation (see
[Cross-language parity](/guide/parity)).

```ts
import { Checkpoints } from "rightsize";

const all = await Checkpoints.list(); // every named checkpoint currently registered
const removed = await Checkpoints.remove("seeded-db"); // true if anything existed
```

- **`Checkpoints.find(name)`** rediscovers a named checkpoint. No entry, or a
  corrupt one, resolves to `undefined` (a corrupt entry's bad file is
  best-effort deleted along the way). When the entry's recorded backend
  matches the CURRENTLY active one, the underlying artifact is probed before
  this resolves — an artifact that's gone (removed by hand, or by something
  outside this library) makes the entry stale: it's cleaned up and this
  resolves to `undefined` too. When the recorded backend DIFFERS from the
  active one, the entry is returned unprobed — an msb ref means nothing to a
  docker probe and vice versa, and `fromCheckpoint(cp).start()`'s own
  `CheckpointBackendMismatchError` gate stays the authority for that case.
- **`Checkpoints.list()`** returns registry contents only, with no artifact
  probing at all — a stale entry still appears here until something calls
  `find` or `remove` on it.
- **`Checkpoints.remove(name)`** deletes a named checkpoint: best-effort
  removal of the backend artifact (only when the entry's backend matches the
  active one) plus the registry file, regardless of failure order in either.
  Idempotent — "not found" anywhere is success, reported as `false`; an
  existing entry (valid or corrupt) reports `true`. **When the entry's
  recorded backend differs from the currently active one, this deletes only
  the registry record — the underlying artifact (the docker image, or the
  microsandbox snapshot) is left on disk permanently.** Nothing in this
  library reclaims it automatically in that case — and once the record is
  gone, a later `Checkpoints.remove(name)` finds nothing to act on. Remove
  a checkpoint under its creating backend in the first place (set
  `RIGHTSIZE_BACKEND` before the call), or clean the leftover artifact
  directly with that backend's own CLI one-liner (see
  [Cleanup](#cleanup-checkpoints-are-not-auto-reaped) below).

## Cleanup: checkpoints are not auto-reaped

The [orphan reaper](/guide/reaping) tracks *containers*, not images or
snapshots — `checkpoint()`'s captured state is never appended to the
reaping ledger and is never removed by a sweep, a watchdog, or `close()`.
`Checkpoints.remove(name)` (above) is the cleanup affordance for a NAMED
checkpoint; for an unnamed one, or for by-hand cleanup outside this library
entirely, the CLI one-liners still work:

```bash
docker rmi rightsize/checkpoint:<ref>       # docker
msb snapshot rm rz-ckpt-<ref>               # microsandbox
```

Both backends' SPI also expose `removeCheckpoint(ref)` (best-effort, "not
found" is success) for tests that want to clean up programmatically without
going through the named registry — it has no public `GenericContainer`
method of its own, since normal usage is expected to go through
`Checkpoints.remove` (named) or the CLI one-liners above (unnamed).
