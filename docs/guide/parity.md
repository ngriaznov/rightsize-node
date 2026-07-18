# Cross-language parity

rightsize ships as three independent libraries — Kotlin, Rust, and
TypeScript (this repo) — built and released separately, with no shared
runtime dependency between them. What they do share is a single behavioral
contract: **the same container spec produces the same observable behavior
in all three languages, on both the microsandbox and Docker backends.**
That claim isn't a marketing line, it's a thing each repo's own test suite
verifies on every change.

For a polyglot team, this means the module you learned in one language
transfers directly to another: the same image, the same wait strategy, the
same reasoning about ports, networks, and failure modes. Nothing about
switching from a TypeScript test suite to a Kotlin or Rust one requires
relearning how rightsize behaves.

## What's verified

Each behavior area below is exercised by a shared-body contract test that
runs unchanged against both backends (parameterized by `RIGHTSIZE_BACKEND`),
in every one of the three implementations. Where a backend genuinely
diverges (for example, read-only mount enforcement), the divergence itself
is asserted rather than glossed over — see
[Backends](/guide/backends#backend-differences).

| Behavior area | What's pinned across languages |
|---|---|
| Lifecycle (start/stop/idempotence) | `start()`/`stop()` are idempotent; a half-started container always tears itself down before its error surfaces; disposal (`await using` / `Symbol.asyncDispose` here, the `AutoCloseable`/`Drop` equivalents elsewhere) runs the same teardown as an explicit `stop()`. |
| Host port mapping | Host ports are chosen before the backend is ever called and bound loopback-only (`127.0.0.1`); a bind conflict on create retries with fresh ports rather than failing the whole `start()`. |
| Env/command propagation | `env` and `command` reach the container unmodified; an unset `command` runs the image's own `ENTRYPOINT`/`CMD`, on both backends. |
| File copy-in | A file copied to a guest path before start is present, with identical content, the instant the workload's own process can see it. Scope: start-time only (`withCopyFileToContainer`) — see the next row for the runtime counterpart. |
| Runtime file copy | `copyFileToContainer` / `copyContentToContainer` / `copyFileFromContainer` round-trip files, in-memory content, and directories against a RUNNING container on both backends; destination parents are created automatically; both operations require a running container and fail with a typed error otherwise. |
| Exec | `exec()` returns exit code, stdout, and stderr for a command run inside a running container, on both backends. |
| Logs + follow semantics | `logs()` returns a bounded tail; `followLogs`/`followOutput` delivers every line exactly once, including a final line with no trailing newline — even where the underlying mechanism differs (Docker's chunked HTTP stream vs. microsandbox's `msb logs -f` plus a watchdog-driven tail replay, since `-f` never exits on its own). |
| Wait strategies and budgets | `forListeningPort`, `forHttp`, `forLogMessage` share the same default 120s deadline-not-a-wait semantics and the same `ContainerLaunchError` failure shape (container description plus its last 50 log lines) across implementations. |
| Networks and aliases | Alias-based resolution (`"alias:port"`) returns the identical string shape on both backends; a container only becomes reachable to later joiners after its own link-installation step completes. |
| Boot-failure retries | The microsandbox backend retries a boot that fails on a transient state-database migration race (msb's shared SQLite state db) or a corrupted image-cache layer (self-healed via a scoped cache-image removal), exactly once, before propagating; both failure signatures are pinned test fixtures, not guesses. |
| Reaping ledger + sweep | The on-disk ledger format (`runs/<run-id>.json`/`.sandboxes`/`.networks`), the append-before/remove-after protocol, and the pid+start-time liveness check are language-neutral — a process in any one implementation can sweep up after a crashed process in either of the other two, sharing one cache dir. |
| Reuse gating + identity hash | The double opt-in (`.withReuse()` plus `RIGHTSIZE_REUSE`), the `rz-reuse-<hash12>` naming, and the sha256 identity hash over the canonical reuse-relevant spec are pinned to the **same digest** across all three implementations for the same logical spec. The pinned vector — `{image: "redis:7-alpine", env: {A: "1", B: "2"}, command: [], exposedPorts: [6379], memoryLimitMb: null, copies: []}` — hashes to `799aad5a3338ce3d36999c7ff2733d4673c0592d417563f334544693ec1907a5` in every implementation's own test suite. |
| Capabilities (`hardwareIsolated` / `checkpoint` / `checkpointRestartsWorkload`) | `msb`: `hardwareIsolated: true` (isolated), `checkpoint: true` (disk snapshot), `checkpointRestartsWorkload: true`. `docker`: `hardwareIsolated: false` (not isolated), `checkpoint: true` (image commit), `checkpointRestartsWorkload: false`. Identical values, identical field names, in every implementation. |
| `requireIsolation` gating | Requesting isolation on a backend that can't provide it throws before any network/port/create work, naming the active backend and the fix — the same fail-fast-before-boot placement in every implementation's `start()`. |
| Diagnostics report format | `diagnostics()` renders every currently-running container (image, mapped ports, a bounded 50-line log tail) into the identical report shape; a container whose `logs()` call fails degrades to a one-line `logs: unavailable (<reason>)` instead of hiding the rest of the report — byte-for-byte identical structure across languages. |
| Checkpoint gating | `checkpoint()` succeeds on both real backends and throws a typed, backend-naming error on a backend without the capability, before any backend call; restoring a checkpoint under a different active backend than the one that created it fails with a typed mismatch error before any backend work. |
| Named checkpoints | A checkpoint created with a name persists a registry entry (one JSON file per name under the rightsize cache directory, pinned field names) and is rediscoverable in any later process via find/list/remove; re-checkpointing a name replaces its artifact and entry; a stale entry whose artifact is gone resolves to absent and is cleaned up. |
| Checkpoint export/import | `exportTo` writes a self-describing archive (pinned metadata plus the backend artifact) for a checkpoint created by the active backend; `importFrom` materializes it on a machine running the same backend, re-registers a named checkpoint with replace semantics, and returns a restorable checkpoint; a backend mismatch or malformed archive fails with a typed error before any backend work. |

## The sibling implementations

- **Kotlin** — [github.com/ngriaznov/rightsize-kotlin](https://github.com/ngriaznov/rightsize-kotlin), docs at [ngriaznov.github.io/rightsize-kotlin](https://ngriaznov.github.io/rightsize-kotlin/)
- **Rust** — [github.com/ngriaznov/rightsize-rust](https://github.com/ngriaznov/rightsize-rust), docs at [ngriaznov.github.io/rightsize-rust](https://ngriaznov.github.io/rightsize-rust/)
- **TypeScript** (this repo) — [github.com/ngriaznov/rightsize-node](https://github.com/ngriaznov/rightsize-node), docs at [ngriaznov.github.io/rightsize-node](https://ngriaznov.github.io/rightsize-node/)

Each repo publishes and versions independently — there's no requirement to
run the same release number across languages — but the behavior each one
promises for a given container spec is the same regardless of which one a
team happens to be using.

## How the contract is enforced

In this repo, the contract lives in
[`test/it/contract.test.ts`](https://github.com/ngriaznov/rightsize-node/blob/main/test/it/contract.test.ts):
one shared set of test bodies, parameterized by `RIGHTSIZE_BACKEND`, that
exercises every behavior area in the table above against whichever backend
is selected. A genuinely backend-specific case (not a shared contract) lives
instead in
[`test/it/docker-backend.test.ts`](https://github.com/ngriaznov/rightsize-node/blob/main/test/it/docker-backend.test.ts)
or
[`test/it/msb-backend.test.ts`](https://github.com/ngriaznov/rightsize-node/blob/main/test/it/msb-backend.test.ts).

Run it directly:

```bash
RIGHTSIZE_BACKEND=microsandbox npm run test:node:it   # or test:bun:it
RIGHTSIZE_BACKEND=docker npm run test:node:it         # or test:bun:it
```

The Kotlin and Rust repos each maintain their own equivalent contract
suite (an abstract `@Tag("sandbox-it")` test class per backend module in
Kotlin, a `sandbox-it`-featured `crates/rightsize-modules/tests/contract.rs`
in Rust) — same behavior areas, same pinned vectors, run independently in
each repo's own CI. No test runs across repos; the contract is kept in
sync by pinning the same fixtures (like the reuse hash vector above) in all
three places rather than by sharing test code.
