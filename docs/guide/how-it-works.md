# How it works

## Ports are pre-allocated, never allocated by a backend

Host ports are chosen on the TypeScript side — bound briefly on
`127.0.0.1:0`, read back, and released — before a container is created, and
handed to the backend already-chosen in `ContainerSpec.ports`. **A backend
binds the ports it's given; it never allocates its own.** This is what lets
brokers like Redpanda and Kafka advertise their own mapped host port at boot,
in one shot, with no restart dance: the port is known before the process
inside the container even starts, so it can be baked into the advertised
listener config directly.

The unavoidable cost is an allocate-then-bind race: between this process
releasing its temporary bind and the container actually claiming the port,
something else on the machine could grab it first. `start()` mitigates this
with a bounded retry (five attempts, fresh ports each time) rather than
pretending the race doesn't exist.

## Two-tier cleanup, no async `Drop`

The happy path is `await using` or an explicit `stop()` — both run the
backend's real async teardown and await it to completion before returning.
Neither runs if the process exits first (`process.exit()`, an uncaught
rejection, a hard kill), so two backstops sit under that path:

1. **A synchronous, blocking teardown registered per container.** Node's
   `process.on("exit", ...)` handler runs synchronously and cannot `await` —
   by the time it fires, the event loop is already being torn down. Each
   backend therefore exposes a `cleanupSync(id)` that uses a blocking
   primitive instead of its normal async calls: `child_process.spawnSync` for
   microsandbox, a blocking unix-socket call (shelled out through `curl
   --unix-socket`) for Docker. `SIGINT`/`SIGTERM` handlers run the same
   synchronous cleanup, then re-raise the signal so the process still exits
   the way it would have without the handler.
2. **Orphan reaping.** `SIGKILL` bypasses even the exit handler — nothing
   runs at all. An on-disk ledger (never name/label parsing) tracks every
   sandbox a process has live at any moment; an init-time sweep judges every
   OTHER run's ledger entry by pid+start-time liveness and reaps whatever's
   dead, and an optional per-run watchdog process reaps within seconds of
   the crash instead of waiting for the next sweep. Full mechanics:
   [Orphan reaping](/guide/reaping).

## `RunId`: one value per process, shared across both backends

Every container this process creates is named `rz-<runId>-<seq>`, where
`runId` is one 8-character value computed once at process start and exported
from the library's core — imported by *both* backend modules, never
recomputed independently by either. Both backends' own `close()` (this
run's own normal-exit cleanup, not the crash-recovery reaper above) filters
against this same value: Docker by the `dev.rightsize.runId` label, msb by
the set of names this backend instance itself started. If a backend
computed its own run id instead, the two values would differ and `close()`
could either miss this run's own containers or, in principle, reach for
another run's.

## The msb backend: attached-mode supervision

microsandbox's detached mode (`msb run -d`) boots the microVM but never
starts the image's own ENTRYPOINT — only attached mode does. The msb backend
therefore runs every sandbox as a held child process (`msb run`, no `-d`),
and readiness is inferred from `msb ls --format json` reporting the sandbox
as `"Running"` — never from the attached process's own stdout or exit code,
since that process's output *is* the workload's log stream, which has no
generic "I am ready" signal this backend could parse. Every child gets a
closed stdin: `msb exec` (and, empirically, plain `msb run`) blocks
indefinitely on a stdin that's held open but never closed.

`msb logs -f` never exits once its sandbox stops — it blocks on read
forever instead of returning cleanly. `followOutput` on this backend
therefore runs a small watchdog alongside the live log stream: once the
sandbox leaves `Running`, the watchdog kills the stuck follow process,
confirms every line it had already buffered has been delivered, then does
one authoritative non-streaming `msb logs` fetch and replays only the lines
the live stream hadn't delivered yet — guarded so that replay can only ever
happen once, and an explicit `close()` never triggers it (closing means
"stop delivering," never "catch me up").

## The msb backend: network links are a real TCP relay, not a shortcut

microVMs are fully isolated from each other, so `Network` on this backend
installs an `/etc/hosts` alias plus a byte-for-byte TCP relay tunneled over
the sandbox's `exec --stream` channel — the only guest data path this msb
build offers. The relay is deliberately unbuffered (a line-reader would hang
the whole pump waiting for a newline that HTTP responses don't always
provide) and serves one connection at a time, respawning its in-guest `nc -l`
listener after each one.

The trickiest part: **the msb port-publish proxy never propagates a target's
own TCP close back to this relay.** A host client's response never gets a
natural EOF, even after the real server on the other end has already closed
its side — so end-of-exchange has to be *inferred*, not observed. The relay
uses two independent idle-read timeouts on the target socket: a generous one
(10s) that applies until the first response byte arrives, so a slow-but-real
cold response is never truncated, and a much shorter one (500ms) once data
has started flowing, where a gap that short really does mean the single
client-speaks-first exchange is over. Collapsing these into a single window
either truncates slow responses or wedges every idle exchange — they stay
separate on purpose.

## The Docker backend: a client that can only dial a unix socket

`rightsize/backend-docker` talks to the daemon over a client built from
scratch on `node:http`'s `socketPath` option, never a general-purpose Docker
SDK. See [Backends](/guide/backends#backend-docker-deep-dive-why-this-client-is-hand-rolled)
for why: the short version is that a shared HTTP stack a consumer also
depends on has, on another runtime, been observed to misroute a Docker client
onto TCP instead of the daemon's real socket after an unrelated dependency
bump — a failure mode this client cannot exhibit by construction, because it
has no other transport to fall back to.

Daemon log/exec streams are demultiplexed from Docker's 8-byte-header framed
format (stream type + length, then raw payload) directly off the HTTP
response body — no TTY is ever allocated, so every stream this library reads
is framed this way. A single log line can straddle two frames, or a frame can
straddle two chunks of the underlying HTTP read; a small line-assembler
buffers the trailing partial line across reads and flushes it exactly once,
at stream end.

## The provisioner: an atomic, crash-safe install

The pinned `msb` release and its `libkrunfw` companion library are
downloaded to temp files first, SHA-256-verified against the release's
published checksums, and only then moved into place — `libkrunfw` first,
the `msb` binary itself **last**, so the binary's mere presence is the
"install is complete" marker. A process that crashes mid-install can never
leave a state where a later run wrongly trusts a half-finished one. A
cross-process file lock (an `O_EXCL`-created lock file, since Node has no
kernel-held advisory lock primitive) serializes concurrent installs across
parallel test workers; the lock records its holder's PID and a timestamp so
a later waiter can detect and take over from a holder that died without
releasing it, rather than waiting out a lock that will never be released.
