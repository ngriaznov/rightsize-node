# Orphan reaping

`await using`, an explicit `stop()`, and the synchronous exit-path teardown
(see [Lifecycle](/guide/lifecycle) and [How It Works](/guide/how-it-works))
cover every way a process can wind down — except the one it can't run any
code for at all: `SIGKILL`, an OOM-kill, or a crashed CI step. When that
happens, whatever sandboxes the process had running keep running, orphaned.
Reaping exists for exactly that gap, and *only* that gap — it's bound to the
**process**, never to an individual test.

Two layers, both keyed off one on-disk ledger:

1. **The init-time sweep** — always runs (unless disabled), costs nothing on
   the happy path, and is the backstop that eventually cleans up any orphan
   no matter what killed the process that created it.
2. **The watchdog** — an optional per-run helper process that reaps within
   seconds of the crash, instead of waiting for the next process that
   happens to start.

## The ledger

Under the rightsize cache dir (the same one `backend-msb`'s provisioner
uses — see [`RIGHTSIZE_CACHE_DIR`](/guide/configuration)), every process
that creates at least one sandbox maintains three files per run, named after
its own run id:

- `runs/<run-id>.json` — this process's pid, the instant the *process*
  started (not the record), which backend it's using, and (for msb) the
  provisioned binary's path.
- `runs/<run-id>.sandboxes` — one sandbox name per line. A name is appended
  the instant *before* that sandbox is created and removed the instant
  *after* it's torn down — the file is therefore always a superset of the
  run's genuinely live sandboxes, never a subset.
- `runs/<run-id>.networks` — the same append-before/remove-after protocol,
  for networks.

On clean shutdown, once both files are empty, the three files are deleted —
a later container in the same process just recreates them. A crash leaves
them behind, which is precisely the signal the sweep and the watchdog both
key off.

The ledger is a plain, language-neutral file format on purpose: a Kotlin or
Rust rightsize process shares the same cache dir and can sweep up after a
crashed Node process (and vice versa) without knowing anything about the
process that wrote the files beyond this shared JSON/line-oriented shape.

## The init-time sweep

Runs exactly once per process, lazily, the moment a backend is first
resolved through `Backends.active()` — before that process's own first
sandbox is created. For every OTHER run's record under the ledger:

- Unparseable and less than an hour old → left alone (it might just be
  mid-write by its own process).
- Unparseable and older than an hour → treated as dead and cleaned up.
- Parseable and the recorded backend doesn't match this process's own
  active backend → left alone. A docker process cannot remove msb sandboxes
  and vice versa; a run's leftovers wait for a process on its own backend to
  find them.
- Parseable, same backend, and the recorded pid+start-time no longer match a
  live process → dead. Every sandbox in `.sandboxes` is removed (by name,
  "not found" ignored), every network in `.networks` is removed the same
  way, and the three ledger files are deleted.
- Parseable, same backend, and still alive → left completely alone.

Liveness is judged by pid **and** start time together, within a 2-second
tolerance — pid alone isn't enough, since the OS can and does reuse pids.

This sweep only ever runs for the backend resolved through
`Backends.active()` (the env-driven auto-selection path) — a container
pinned to an explicit backend instance via `withBackend()` isn't part of
this bookkeeping.

## The watchdog

The sweep alone means an orphan is eventually cleaned up, but only the next
time *some* process on the same backend happens to start — which could be
never, on a machine that only runs this test suite once a day. The watchdog
closes that gap for the common case: one small helper process per run,
spawned lazily right before that run's first sandbox is created, that
detects this process's death directly instead of waiting to be swept.

Mechanism, in short: the library writes a small script to `<cacheDir>/reaper/`
and spawns it detached. On macOS/Linux this is a POSIX `sh` script whose
stdin is wired to a pipe whose *write end* only the library process holds —
never inherited by anything else it spawns. That pipe stays open for exactly
as long as the library process is alive; the moment it exits, cleanly or via
`SIGKILL`, the OS closes the write end and the watchdog's blocking read hits
EOF. On Windows the watchdog is a small `node` script instead (a non-detached
Windows child process is killed by the OS itself the instant its parent is
torn down — Job Object semantics — so surviving requires `detached: true`,
and neither Windows PowerShell host survives being launched that way; plain
`node` does), polling this process's pid every 500ms rather than blocking on
a pipe read. Either way, once the watchdog detects the owning process is
gone, it reads this run's `.sandboxes`/`.networks` files (paths it received
as argv, not baked into the script itself) and reaps whatever's still
listed, using the same kill-command shape the backend itself uses — then
deletes the ledger files and exits. If a clean shutdown already emptied
those files, the script still runs (nothing to do) and just deletes what's
left.

There is deliberately no daemon here — one ephemeral process per run, gone
the moment it's done its job (or the moment it discovers there was never
anything to do).

## Reuse immunity

A [reuse](/guide/reuse)-active container (`.withReuse()` plus
`RIGHTSIZE_REUSE`) is never appended to `.sandboxes` in the first place.
Neither the sweep nor the watchdog can reap something that was never
listed, by construction — no special-casing needed at reap time.

## The `RIGHTSIZE_REAPER` switch

| Value | Sweep | Watchdog |
|---|---|---|
| `on` (default) | yes | yes |
| `sweep` | yes | no |
| `off` | no | no |

An unrecognized value is treated as `on`. Set `RIGHTSIZE_REAPER=sweep` to
keep crash cleanup working while skipping the extra process per run (a CI
environment that's touchy about unexpected child processes, for instance);
set it to `off` only if something else in your environment already handles
orphaned sandboxes.

```ts
// Force sweep-only for this process — e.g. before importing a backend, in a
// wrapper script that starts this test process.
process.env.RIGHTSIZE_REAPER = "sweep";
```

## The docker-remote caveat

The watchdog is a local process tied to the machine running the test
suite. On a CI provider where the Docker daemon lives on a different host
(or the runner VM is torn down the instant the job ends, taking the
watchdog with it before it can even notice anything), a local watchdog
cannot outlive the environment that hosted it. That's fine: the *next* run
against that same daemon — from any machine — performs the init-time sweep
and finds the leftovers, because the sweep works entirely off the shared
ledger and the daemon's own state, neither of which depends on the watchdog
having run at all. The watchdog is a latency optimization, not a
correctness requirement — the sweep is the one that's always eventually
correct.

## Troubleshooting: sandboxes left behind

If `msb ls` (or `docker ps`) shows sandboxes from a run that's long gone:

1. Check `RIGHTSIZE_REAPER` isn't set to `off` in whatever environment ran
   that process.
2. A leftover sandbox is cleaned up the next time *any* process on the same
   backend resolves one through `Backends.active()` — running your test
   suite (or any rightsize process) again is often the fastest fix.
3. If the leftover has sat for a while with nothing sweeping it, confirm a
   process is actually starting sandboxes through the normal
   auto-selection path on that machine/backend — the sweep never reaps
   anything for a backend nothing has resolved yet, and a container pinned
   via `withBackend()` doesn't feed the ledger at all (see the last point
   under [The init-time sweep](#the-init-time-sweep)).
4. As a last resort, `msb rm -f <name>` / `docker rm -f <name>` remove a
   sandbox directly — safe at any time, reaping or not.
