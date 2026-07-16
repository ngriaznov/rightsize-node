# Container reuse

Testcontainers' `withReuse()` speedup: keep a sandbox running across process
exits and *adopt* it on the next equivalent `start()` — in the same process
or a later one — instead of booting a fresh one every time. Aimed
specifically at the local dev loop, where re-running a test suite
repeatedly against the same fixture image dominates wall-clock time.

Reuse is bound to a container's **identity** (its image, env, command,
ports, memory limit, and copied files), never to a test or a run. Two
`GenericContainer` builders with the identical reuse-relevant state adopt the
same sandbox; anything that differs mints a different identity and therefore
a different sandbox.

## Double opt-in

Reuse only engages when BOTH of these are true:

```ts
import { GenericContainer, Wait } from "rightsize";

await using redis = await new GenericContainer("redis:8.6-alpine")
  .withReuse()
  .withExposedPorts(6379)
  .waitingFor(Wait.forListeningPort())
  .start();
```

1. **API marker** — `.withReuse()` on the builder.
2. **Environment** — `RIGHTSIZE_REUSE` is exactly `"true"` or `"1"`.

Marked but not enabled starts as an ordinary ephemeral container — normal
Testcontainers semantics, normal reaping, normal `stop()` — with one note on
stderr the first time it happens, so a forgotten `.withReuse()` never
silently changes behavior in an environment that hasn't opted in.

## Identity: what busts the hash

A sha256 hash over a canonical form of the reuse-relevant subset of the
spec decides identity:

- `image`
- `env` (order does not matter — sorted by key before hashing)
- `command` (`undefined` and `[]` hash identically: both mean "run the
  image's own entrypoint")
- `exposedPorts` (order does not matter — sorted before hashing)
- `memoryLimitMb`
- every file copied in via `withCopyFileToContainer` — both its guest path
  and its **content**, hashed at `start()` time. Order does not matter
  (sorted by guest path), but a file that has changed on disk since the
  last adopted start *does* change identity.

Deliberately **not** part of identity: host ports (chosen fresh or read back
from the registry, never hashed), the process's `RunId`, and network
topology (see below). The name a reuse-active container gets is
`rz-reuse-<first 12 hex chars of the hash>` — deterministic, so two
processes computing the identical logical spec independently arrive at the
same name without ever talking to each other.

This hash is a **cross-language contract**: the Kotlin, Rust, and
TypeScript rightsize implementations all hash the identical canonical form
to the identical digest for the identical logical spec, verified by a
pinned test vector in each implementation's own test suite.

**Runtime copy is not part of identity.** [`copyFileToContainer` /
`copyContentToContainer` / `copyFileFromContainer`](/guide/copy) work against
a reuse-active container the same as any other, but a runtime copy mutates
the sandbox's shared state without changing its identity hash — two
processes adopting the same identity see whatever the most recent copy left
behind, not something tied to either process's own spec. Only files listed
via `withCopyFileToContainer` (the start-time mount) are hashed; a runtime
copy is invisible to identity entirely.

## The network restriction

```ts
import { GenericContainer, Network } from "rightsize";

const net = Network.newNetwork();

await new GenericContainer("redis:8.6-alpine")
  .withReuse()
  .withNetwork(net) // throws ReuseWithNetworkError once RIGHTSIZE_REUSE is set
  .start();
```

`withReuse()` combined with `withNetwork()` throws `ReuseWithNetworkError`
at `start()`, once reuse is actually double-opt-in active — the identity
hash covers only this container's own spec, never cross-container topology,
so an adopted sandbox from an earlier process could never be correctly
re-linked to today's siblings. Drop either call.

## What happens on `start()`

1. **A registry entry exists for this identity** (`<cacheDir>/reuse/<hash>.json`
   — see [Configuration](/guide/configuration) for `RIGHTSIZE_CACHE_DIR`):
   the backend is asked whether that name is actually running, and if so,
   this container's own wait strategy is re-run against the ports the
   registry recorded. Both checks pass → **adopt**: no `create()` call at
   all, `isRunning` is `true`, and the mapped ports are exactly the ones the
   registry had.
2. **Not running, the wait fails, or the registry file itself is
   unreadable/corrupt** → best-effort remove whatever sandbox exists under
   that deterministic name and delete the stale registry file, then fall
   through to a fresh create.
3. **No registry entry** → probe the backend for a sandbox already running
   under the deterministic name and best-effort remove it if found (see
   "Recovering from a crash mid-boot" below), then allocate host ports
   normally, create under the `rz-reuse-<hash12>` name, wait for readiness,
   and write the registry file.
4. **Name collision on create** (another process's `start()` won a race
   against this one) → re-enter the adopt path once, using whatever the
   winner has since made visible.

## Recovering from a crash mid-boot

The registry file (`<cacheDir>/reuse/<hash>.json`) is written only **after**
a fresh-created reuse sandbox passes its own wait strategy — never at
`create()` time. A process that crashes, or fails that wait, in the window
between the two leaves a sandbox genuinely **running** under the
deterministic `rz-reuse-<hash12>` name with no registry entry to say so.
`keepAlive` keeps that sandbox out of every reaping path by design, so
nothing else in this library would ever notice or clear it. Without a
guard, the next `start()` for that identity finds no usable registry entry
and walks straight into a fresh `create()` against a name that's already
taken: docker responds with a 409 on the name conflict, while microsandbox
has no such check and happily boots a second workload alongside the first —
the two then fight over the same in-guest ports, and every subsequent
`start()` of that identity times out until someone removes the sandbox by
hand.

`start()` now closes this window itself: whenever the adopt path concludes
there is no usable registry entry to fall back on (none exists yet — the
crash-mid-boot case above, as distinct from one that exists but is corrupt
or fails its own re-verification, both of which already best-effort-clean
up the sandbox they know about), it asks the backend directly whether a
sandbox is already running under that name before ever calling `create()`,
and best-effort-removes it first if so. The common case — nothing running,
first `start()` ever for this identity — pays for exactly one liveness
check and no removal call. This is still racy against a concurrent creator
that has *already* called `create()` but hasn't finished its own wait yet;
that case is caught separately by the existing name-collision-retry, which
adopts the winner's registry entry once it appears rather than removing
anything.

## `stop()` leaves the sandbox running

```ts
import { GenericContainer, Wait } from "rightsize";

const redis = await new GenericContainer("redis:8.6-alpine")
  .withReuse()
  .withExposedPorts(6379)
  .waitingFor(Wait.forListeningPort())
  .start();

await redis.stop(); // the sandbox keeps running; only this handle forgets about it
```

That's the entire feature: `stop()` on a reuse-active container clears only
this instance's own bookkeeping (`isRunning` flips to `false`, its mapped
ports stop resolving) and never calls the backend's `stop`/`remove`. A
reuse sandbox is also never appended to the [reaping ledger](/guide/reaping)
— it's structurally invisible to both the sweep and the watchdog, the same
way `ContainerSpec.keepAlive` keeps it out of every other own-run cleanup
path.

There is no "remove this reused sandbox for good" API today. Do it by hand
with whichever backend is active:

```bash
msb rm -f rz-reuse-<hash12>       # microsandbox
docker rm -f rz-reuse-<hash12>    # docker
```

...and delete its registry file under `<cacheDir>/reuse/<hash>.json` so a
later `start()` doesn't try to adopt a sandbox that's gone (harmless even if
you skip this — a missing sandbox behind a stale registry entry is exactly
the "stale registry" case above, and self-heals on the next `start()`).

## CI guidance

**Do not set `RIGHTSIZE_REUSE` on ephemeral CI runners.** The whole point of
reuse is a sandbox that outlives the process — on a runner that's destroyed
at the end of every job, that sandbox is destroyed with it and the "reuse"
never pays off, while every job still pays the cost of writing and reading
the registry file. Reuse is a local-dev-loop and long-lived-host feature;
CI wants the ordinary ephemeral + reaping story instead.
