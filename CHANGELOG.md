# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Nothing yet.

## [0.3.0] - 2026-07-16

### Added

- Runtime file copy: `GenericContainer.copyFileToContainer(hostPath, containerPath)`,
  `copyContentToContainer(content, containerPath)`, and
  `copyFileFromContainer(containerPath, hostPath)` move files and
  directories into or out of an already-**running** container, distinct
  from the start-time `withCopyFileToContainer` mount. Both directions
  create the destination's parent directory automatically (`exec: mkdir -p`
  in the guest; the standard library's recursive `mkdir` on the host); a
  source directory copies `cp -r`-style (contents under an absent
  destination, not nested one level down); a non-running container or a
  relative `containerPath` fails fast with a typed error before any backend
  call. `copyContentToContainer` writes to a private (mode `0600`) temp file
  and cleans it up regardless of outcome. New SPI:
  `SandboxBackend.copyToContainer`/`copyFromContainer` — docker shells out
  to `docker cp` (the reaper watchdog already requires the CLI), msb uses
  `msb copy -q`. Works against a reuse-active container, but the mutation is
  not part of the reuse identity hash. See
  [Copying files](https://ngriaznov.github.io/rightsize-node/guide/copy).
- Checkpoint/restore now ships on microsandbox too, via disk snapshot:
  `checkpoint()` on msb stops the sandbox, snapshots its disk, then boots it
  back up from that snapshot under the same name/ports/env — `msb stop` →
  `msb snapshot create` → `msb rm` → a fresh attached `msb run --snapshot`
  boot, never `msb start` (upstream's detached-start path denies the
  breakaway right it needs whenever the msb CLI runs inside a restrictive
  Windows job object, e.g. as a child of a test runner) — and re-runs the
  container's own wait strategy before returning (the workload restarts as
  part of the cycle). A failed snapshot step leaves the sandbox stopped
  rather than best-effort restarting it, and names the by-hand remedy; a
  snapshot that succeeds but whose reboot then fails names the checkpoint
  ref as still restorable via `fromCheckpoint()`. New
  `capabilities.checkpointRestartsWorkload` flag (`true` for msb, `false`
  for docker) the generic layer uses to decide whether that re-wait runs.
  `Checkpoint`'s `imageRef` field is renamed to `ref` (a snapshot name on
  msb, an image tag on docker) and gains a `backend` field naming the
  backend that created it; restoring a checkpoint under a different active
  backend now throws a new `CheckpointBackendMismatchError` before any
  backend call. `fromCheckpoint()` combined with `.withReuse()` throws a new
  `ReuseFromCheckpointError` — reuse's identity hash doesn't cover a
  checkpoint ref. `ContainerSpec` gains `checkpointRef` (docker ignores it;
  msb boots via `msb run --snapshot <ref>` instead of the normal image boot
  when it's set). New SPI: `SandboxBackend.createCheckpoint` (renamed from
  `commitToImage`) and `SandboxBackend.removeCheckpoint(ref)` (best-effort,
  "not found" is success — SPI-only, no public `GenericContainer` method).
  `CheckpointUnsupportedError`'s message no longer steers toward docker
  specifically, since both real backends support checkpointing today.
  Checkpoints can now also be NAMED and made durable:
  `checkpoint(name)` mints a deterministic ref (`rightsize/checkpoint:<name>`
  on docker, `rz-ckpt-<name>` on msb) instead of a random one, validates
  `name` against `^[a-z0-9][a-z0-9-]{0,40}$` before any backend call
  (`InvalidCheckpointNameError` otherwise), and — only once the backend
  checkpoint itself has succeeded — writes a registry entry to
  `<cacheDir>/checkpoints/<name>.json` (pinned field names, a reduced
  cross-language subset of the source spec) that a LATER process can
  rediscover. Re-checkpointing an existing name replaces it: the old
  artifact under that same deterministic ref is best-effort cleared before
  the new one is created, and the registry entry is overwritten. New
  `Checkpoints` namespace: `find(name)` rediscovers a named checkpoint
  (probing the artifact via the new `hasCheckpoint` SPI when the entry's
  recorded backend matches the active one, and cleaning up a stale entry
  whose artifact is gone; an entry recorded under a different backend is
  returned unprobed), `list()` returns registry contents with no probing,
  and `remove(name)` deletes both the artifact (best-effort, only against
  the active backend) and the registry entry, idempotently. Unnamed
  `checkpoint()` calls are unaffected — random ref, no registry entry, still
  purely ephemeral. New SPI: `SandboxBackend.hasCheckpoint(ref)` (docker:
  image inspect; msb: `msb snapshot inspect`) — a probe failure always
  propagates, only a confirmed "does not exist" resolves `false`. See
  [Checkpoint / restore](https://ngriaznov.github.io/rightsize-node/guide/checkpoints).

### Fixed

- `MySQLContainer` readiness now carries a 180-second startup budget (was
  120s), matching `ClickHouseContainer`'s own budget: a loaded Windows CI
  runner was observed overrunning the 120-second budget (123s) during
  MySQL's first-boot double-mysqld-start sequence.
## [0.2.0] - 2026-07-12

### Added

- Orphan reaping: an on-disk ledger under the rightsize cache dir tracks
  every sandbox/network a process has live, an init-time sweep judges every
  other run's ledger entry by pid+start-time liveness and reaps whatever's
  dead, and an optional per-run watchdog process reaps within seconds of a
  `SIGKILL` instead of waiting for the next sweep. Controlled by
  `RIGHTSIZE_REAPER` (`on` default / `sweep` / `off`). See
  [Orphan reaping](https://ngriaznov.github.io/rightsize-node/guide/reaping).
- `SandboxBackend.removeByName(name)`: best-effort stop+remove of a sandbox
  identified by name rather than a handle, for the sweep and watchdog (which
  never hold one). Implemented on both backends; the Docker backend gets a
  liveness-aware orphan sweep for the first time — previously only msb had
  one, and it was liveness-blind (any sandbox not matching this run's own
  name was treated as an orphan, unsafe for concurrent runs).
- Container reuse: `GenericContainer.withReuse()`, gated by the double
  opt-in `RIGHTSIZE_REUSE` (`true`/`1`) environment variable. A reuse-active
  container is named `rz-reuse-<hash12>`, where the hash is a sha256 over a
  canonical JSON form of its reuse-relevant spec (image, env, command,
  exposed ports, memory limit, and copied-file content) — a cross-language
  contract shared with the Kotlin and Rust implementations. `start()` reads
  `<cacheDir>/reuse/<hash>.json` (written atomically) and, if it names a
  sandbox the active backend confirms is running and ready, ADOPTS it — no
  `create()` call at all — instead of booting a fresh one; a stale or
  corrupt registry entry is best-effort cleaned up and falls through to a
  fresh create, and a name collision on create (another process won the
  race) retries the adopt path once. `stop()` on a reuse-active container
  leaves the sandbox running and clears only in-process bookkeeping. Reuse
  plus `withNetwork()` is rejected with a new `ReuseWithNetworkError` — the
  identity hash does not cover cross-container network topology. New SPI:
  `ContainerSpec.keepAlive` (default `false`, `true` for a reuse-active
  container) keeps a sandbox out of every own-run cleanup path and out of
  the reaping ledger; `SandboxBackend.findRunning(spec)` checks whether a
  sandbox named `spec.name` is currently running and, if so, returns a
  handle for it — reuse's adoption check. Both implemented on both
  backends. See
  [Container reuse](https://ngriaznov.github.io/rightsize-node/guide/reuse).
- Failure diagnostics: `diagnostics()` renders every container this process
  currently has running (image, mapped ports, and a bounded 50-line log
  tail) into one human-readable report — identical format across the
  Kotlin, Rust, and TypeScript implementations. A failing `logs()` call
  degrades to a one-line `logs: unavailable (<reason>)` instead of
  throwing. `registerDiagnostics(onTestFailed)` is a dependency-free helper
  for wiring the report into a test framework's own failure hook (e.g.
  vitest's `onTestFailed`). See
  [Failure diagnostics](https://ngriaznov.github.io/rightsize-node/guide/diagnostics).
- Isolation requirement: `SandboxBackend.capabilities` exposes
  `hardwareIsolated` (`true` for msb, `false` for docker) and `checkpoint`
  (`false` for msb, `true` for docker — see checkpoint/restore below).
  `GenericContainer.withRequireIsolation()` makes `start()` throw a new
  `IsolationRequiredError` — naming the active backend and the
  `RIGHTSIZE_BACKEND=microsandbox` remedy — before any create/network work
  if the active backend isn't hardware-isolated, instead of silently
  degrading. See
  [Isolation](https://ngriaznov.github.io/rightsize-node/guide/isolation).
- Checkpoint / restore: `GenericContainer.checkpoint()` commits a running
  container's filesystem to a new image (`rightsize/checkpoint:<12-hex>`,
  random per checkpoint) and returns a `Checkpoint` carrying that image
  reference plus the source container's spec.
  `GenericContainer.fromCheckpoint(checkpoint)` builds a normal, ephemeral
  container from it — image is the checkpoint's, env/command/exposed
  ports/memory limit default to the source spec, callers can still override.
  A restored container is ordinary in every respect once started: fresh
  host ports, normal reaping-ledger tracking, normal `stop()`. Gated by the
  new `capabilities.checkpoint` flag (`true` for docker, implemented via the
  engine's commit endpoint; `false` for msb, no upstream microVM snapshot
  support yet) — `checkpoint()` throws a new typed
  `CheckpointUnsupportedError` before any backend call on an unsupported
  backend, and a state error on a non-running container. Checkpoint images
  are never auto-reaped (they're images, not containers). See
  [Checkpoint / restore](https://ngriaznov.github.io/rightsize-node/guide/checkpoints).
- A [Cross-language parity](https://ngriaznov.github.io/rightsize-node/guide/parity)
  page documenting the behavioral contract verified across the Kotlin,
  Rust, and TypeScript implementations — the claim, every verified behavior
  area, and where the contract suite that enforces it lives.

### Changed

- The msb backend's orphan sweep (`sweepOrphans`, name-prefix-based,
  liveness-blind) is replaced by the shared ledger-based sweep above, which
  also runs for the Docker backend and correctly leaves a still-alive run's
  sandboxes alone even if they don't belong to the current process.
- The msb toolchain cache-dir resolution (`RIGHTSIZE_CACHE_DIR` override,
  `~/.cache/rightsize` / `%LOCALAPPDATA%\rightsize` default) moved from
  `backend-msb`'s provisioner into core, since the reaping ledger needs it
  even in a docker-only process. Behavior is unchanged; the msb provisioner
  now delegates to it.

## [0.1.2] - 2026-07-09

### Changed

- The pinned microsandbox runtime is 0.6.6 (was 0.6.3). The provisioner
  downloads and SHA-256-verifies the new release on first use; existing
  `0.6.3` caches are left in place and simply stop being used. The behaviors
  the msb backend compensates for were re-verified as still present on 0.6.6:
  detached `msb run` never starts the image ENTRYPOINT, `msb logs -f` never
  exits after its sandbox stops, and read-only mounts remain advisory
  in-guest.

## [0.1.1] - 2026-07-06

### Fixed

- The default readiness budget is 120 seconds (was 60). Three modules in a
  row (MySQL, ClickHouse, Redpanda) were observed overrunning a 60-second
  ceiling on loaded CI runners while booting normally. The budget is a
  deadline, not a wait — `start()` still returns the moment the readiness
  signal fires — so the larger default costs nothing on the happy path and
  only delays the failure verdict when a container is genuinely broken.
  `withStartupTimeout` overrides it as before.
- `ClickHouseContainer` readiness now carries a 180-second startup budget:
  the entrypoint runs a second server pass for user/database provisioning
  before the HTTP interface opens, and a loaded Windows CI runner was
  observed still in early config processing at the previous 60-second
  default. The budget is a deadline, not a wait — readiness returns the
  moment `/ping` answers.
- The microsandbox backend retries a boot that hit msb's state-database
  error (`error: database error: ...`). Every msb invocation runs schema
  migrations against its shared SQLite state database on startup, and two
  concurrent invocations can race them — the loser exits before doing any
  work, with whatever wording matches the statement it lost on (three shapes
  observed: `index ... already exists`, `duplicate column name: ...`, and
  `UNIQUE constraint failed: seaql_migrations.version`). A boot is never
  inherently alone (the attached `msb run` races the backend's own state
  polling), so the failure can fire even under fully serialized tests. The
  race is transient by construction — the winner's migration commits and
  later invocations find the schema in place — so a boot failing with msb's
  state-database framing is retried exactly once after a short delay; a
  second failure propagates with both attempts' output.

## [0.1.0] - 2026-07-06

Initial public release.

### Added

- An `examples/` directory with three runnable examples (the `await using`
  Redis quickstart, a two-container network demo, and a consumer-style
  `node:test` suite), wired into `npm run examples:run` and typechecked as
  part of `docs:verify`.
- Native Windows support for the microsandbox backend (x86_64 and arm64):
  platform detection for `win32`, the `.exe`/`.dll` asset names shipped by
  the pinned msb release, install-target naming (`bin\msb.exe`, suffixless
  `msb` elsewhere), a `%LOCALAPPDATA%\rightsize` default cache root, and
  `MSB_PATH`/install-validity checks that don't assume a POSIX execute bit.
  Verified in CI (`msb-windows` job, `windows-2025`): Windows Hypervisor
  Platform was found enabled by default on hosted runners, so the job runs
  the real msb integration suite rather than a Docker-only fallback. Two
  msb-Windows-specific `logs`/`logs -f` gaps were found (documented in
  `.github/CONTRIBUTING.md`): a trailing line lacking its own newline is
  never delivered while the sandbox runs, and `msb logs -f` stalls after
  the first line when a workload writes its output as a slow trickle
  rather than all at once. `followOutput` on Windows therefore polls fresh
  `msb logs` snapshots instead of holding a `logs -f` pipe (a failed msb
  invocation reads as no-signal, and the terminal tail is delivered
  exactly once after the sandbox stops, including a final line with no
  trailing newline), so the full contract suite runs un-gated there.
- `itDockerIntegration`, a new gate in `test/harness.ts` alongside
  `itIntegration`/`itMsbIntegration`: skips `test/it/docker-backend.test.ts`
  cleanly when no Docker-compatible daemon socket is reachable at all
  (Windows CI runners, unlike GitHub's Linux runners, do not ship one),
  rather than every test in that file failing identically with a
  connection-refused error.
- `.gitattributes` pinning text sources to LF regardless of the checking-out
  platform's `core.autocrlf` setting — a Windows checkout was converting
  `src/core/rightsize-fixture.txt`'s committed LF ending to CRLF, breaking
  `MountableFile`'s exact-content round-trip assertion there.

### Fixed

- The microsandbox backend self-heals msb's image-cache race: concurrent
  pulls of images sharing base layers can corrupt msb's image cache — the
  losing pull reads a layer tarball the winner's cleanup already deleted,
  and every later boot of that image fails with `cache error at
  .../layers/<sha>.tar.gz: No such file or directory`. A boot failing with
  that signature now removes the affected image from msb's cache
  (`msb image remove`, scoped to the one reference) and retries the boot
  exactly once; any other failure, or a second failure after the heal,
  propagates unchanged.
- `MySQLContainer` readiness now carries a 120-second startup budget:
  MySQL's first boot initializes the datafiles and boots mysqld twice (a
  temp server for init scripts, then the real one), and while that finishes
  well under the 60-second default on a fast host, a loaded Windows CI
  runner overruns it.
- `MountableFile`'s test suite resolved its own fixture directory via
  `new URL(import.meta.url).pathname`, which mangles a Windows drive-letter
  path; switched to `fileURLToPath`, matching the rest of the codebase's
  house style for turning `import.meta.url` into a filesystem path.
- `test:node:it`/`test:bun:it`/`docs:verify:run`'s npm scripts set
  `RIGHTSIZE_IT=1`/`RIGHTSIZE_DOCS_RUN=1` as bare inline env-var
  assignments, which only parse under a POSIX shell; wrapped with
  `cross-env` so they work under PowerShell (the default shell on Windows
  Actions runners) too.
- Several unit-test fixtures were POSIX-only and never exercised on Windows
  before the `msb-windows` CI job existed: real unix-domain-socket servers
  standing in for a Docker daemon (`src/backend-docker/client.test.ts`) and
  POSIX `sh` scripts run directly as a fake `msb` binary
  (`src/backend-msb/backend.test.ts`, `src/backend-msb/invoke.test.ts`) —
  both fail structurally on Windows (no unix-domain-socket-at-a-filesystem-
  path concept; no shebang-based interpreter dispatch for `spawn()`) and are
  now skipped there with the reasoning documented at each site.

### Changed

- Bumped the pinned microsandbox runtime from `0.6.2` to `0.6.3`. Asset
  names are unchanged; checksums continue to be fetched and verified from
  the release's `checksums.sha256` at install time rather than hardcoded.
  Both documented msb behavior gaps (`msb logs -f` never exiting on its
  own; detached mode skipping the image's ENTRYPOINT) persist in `0.6.3`,
  so the existing compensations are unchanged.

Initial implementation: core lifecycle API (`GenericContainer`, `Network`,
`Wait` strategies, `FreePorts`, `RunId`, the `SandboxBackend` interface and
provider registry), the microsandbox backend (attached-mode CLI driver,
toolchain provisioner, exec-stream network tunnels), the Docker backend
(hand-rolled unix-socket HTTP client, log-frame demux), eighteen preconfigured
modules, a dual-runner (Node + Bun) unit and integration test suite, and this
documentation site.
