# Copying files

Move files and directories into or out of an already-**running** container —
a runtime operation, distinct from the start-time mount `withCopyFileToContainer`
performs before `start()`.

## Runtime copy vs. the start-time mount

| | `withCopyFileToContainer` (builder) | `copyFileToContainer` / `copyContentToContainer` / `copyFileFromContainer` (runtime) |
|---|---|---|
| When | Before `start()` — configures the container | Any time after `start()` — against a live container |
| Direction | Host → guest only | Both directions |
| Mechanism | A bind mount (docker) / mounted file (msb) | An actual copy through each backend's own tool (`docker cp` / `msb copy`) |
| Read-only option | Yes (`FileMount.readOnly`, advisory-only on msb) | N/A — every copy is a one-time transfer, not a live mount |

Reach for `withCopyFileToContainer` for fixtures a container needs from the
moment it boots (config files, seed data the entrypoint reads on startup).
Reach for the runtime methods below to inject or extract files while a
container is already up — writing a config mid-test, seeding a database
that's already listening, or pulling a generated artifact or debug dump back
to the host. To capture a container's entire filesystem rather than moving
individual files or directories, see
[Checkpoint / restore](/guide/checkpoints) instead.

## The three operations

```ts
import { GenericContainer, Wait } from "rightsize";

await using c = await new GenericContainer("alpine:3.19")
  .withCommand("sleep", "60")
  .waitingFor(Wait.forListeningPort())
  .start();

// Host file or directory -> container. Absent parent directories in the
// guest are created for you (exec: mkdir -p <parent>) — never pre-create
// them yourself.
await c.copyFileToContainer("/host/path/config.yml", "/etc/app/config.yml");

// In-memory bytes/string -> container. Writes a private (mode 0600) temp
// file and delegates to copyFileToContainer; the temp file is always
// cleaned up, success or failure.
await c.copyContentToContainer("key: value\n", "/etc/app/generated.yml");
await c.copyContentToContainer(new Uint8Array([1, 2, 3]), "/data/payload.bin");

// Container -> host file or directory. The host parent directory is
// created for you, the same guarantee in the other direction.
await c.copyFileFromContainer("/var/log/app/output.log", "/host/path/output.log");
```

All three require the container to be currently running — calling any of
them before `start()` or after `stop()` throws the same state error
`exec()`/`logs()` do, before any backend call. `containerPath` must always
be an absolute guest path (both `docker cp` and `msb copy` require a
`NAME:/abs/path` shape); a relative path throws `RelativeContainerPathError`
before any backend call too.

## Directory semantics

There is no separate "directory" method — each operation accepts a file OR a
directory source, `cp -r`-style, the same way `docker cp`/`msb copy`
themselves behave: copying a directory to an absent destination path
produces that destination as a copy of the source's **contents**, not the
source nested one level down.

```ts
import { GenericContainer, Wait } from "rightsize";

await using c = await new GenericContainer("alpine:3.19")
  .withCommand("sleep", "60")
  .waitingFor(Wait.forListeningPort())
  .start();

// /host/fixtures contains a.txt and sub/b.txt
await c.copyFileToContainer("/host/fixtures", "/data/fixtures");
// -> /data/fixtures/a.txt, /data/fixtures/sub/b.txt (NOT /data/fixtures/fixtures/...)
```

The same rule applies copying a guest directory back out to the host.

## The parent-creation guarantee

Neither direction requires you to pre-create the destination's parent
directory:

- Copying **in**, the guest's destination parent is created via `exec: mkdir
  -p <parent>` before the transfer.
- Copying **out**, the host's destination parent is created via the standard
  library's own recursive `mkdir` before the transfer.

## Reuse caveat

Runtime copies work against a [reuse](/guide/reuse)-active container the same
as any ordinary one — it's just a runtime operation, nothing reuse-specific
about it. But a runtime copy mutates the reused sandbox's shared state, and
that mutation is **not** part of the reuse identity hash: two processes
adopting the same reuse identity will see whatever the last copy left behind,
not a value tied to either process's own spec. If a test's outcome depends
on a runtime-copied file, be deliberate about whether that test should be
reuse-active at all.
