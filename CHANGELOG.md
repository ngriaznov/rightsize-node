# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- **The pinned microsandbox release is now 0.6.15** (from 0.6.14). Upstream changes
  relevant here: host DNS on Windows now routes through the system resolver, file
  copies on NTFS only copy allocated ranges, and read-only mounts no longer get
  write-probed. No CLI surface this library drives changed.

## [0.7.4] - 2026-08-22

### Changed

- **The pinned microsandbox release is now 0.6.14 on every platform.** Upstream
  fixed the Windows bootstrap regression in the msb_krun_devices 0.1.32 bump
  (upstream issue #1426): console ports now start delivery at PORT_OPEN instead
  of PORT_READY, matching unix, so the guest driver no longer discards the
  pre-boot bootstrap frame before a guest process has the port open. 0.6.12 ->
  0.6.14 changes nothing else of substance for the CLI surface this library
  drives, so unifying both platforms on 0.6.14 does not change behavior on any
  platform. The per-platform split pin introduced in 0.7.2 is retired.

  **If you point `MSB_PATH` at your own msb binary on Windows, avoid 0.6.10
  through 0.6.13** — those releases carry the regression; use 0.6.9 or 0.6.14+.

## [0.7.3] - 2026-08-21

### Changed

- **The pinned microsandbox release is now 0.6.12 on macOS and Linux; Windows stays
  on 0.6.9.** msb 0.6.10 through 0.6.12 all carry the same Windows-only regression:
  guest bootstrap never reaches agentd on Windows hosts, so every sandbox dies about
  60 seconds after spawn without the agent relay ever coming up, and there is no
  client-side workaround. The 0.6.10 -> 0.6.12 upstream diff is release packaging
  only, so the CLI surface this library drives is identical from 0.6.9 through
  0.6.12 — the per-platform pin does not change behavior, it only keeps Windows off
  the broken releases until upstream fixes bootstrap delivery.

  **If you point `MSB_PATH` at your own msb binary on Windows, keep it at 0.6.9** —
  a 0.6.10, 0.6.11, or 0.6.12 binary there will hit the same regression on every
  container start.

## [0.7.2] - 2026-08-19

### Changed

- **The pinned microsandbox release is now 0.6.10 on macOS and Linux; Windows stays
  on 0.6.9.** msb 0.6.10 has a Windows-only regression: its pre-boot guest bootstrap
  message never reaches the guest agent on Windows hosts, so every sandbox exits
  about 70 seconds after spawn without the agent ever coming up. macOS and Linux are
  unaffected. The two releases are identical across every CLI surface this library
  drives, so the per-platform pin does not change behavior — the provisioner simply
  routes Windows around the broken release until upstream fixes it.

  **If you point `MSB_PATH` at your own msb binary on Windows, keep it at 0.6.9** —
  a 0.6.10 binary there will hit the regression on every container start.

## [0.7.1] - 2026-08-16

### Changed

- **The pinned microsandbox release is now 0.6.9** (was 0.6.8). No CLI surface this
  library drives changed, so no action is needed — the provisioner downloads and
  checksum-verifies the new release automatically, and `MSB_PATH` setups validated
  against 0.6.8 keep working. 0.6.9 also fixes two upstream issues this library
  carried defenses for: the Windows snapshot-save flush failure (the salvage path
  stays in place and now simply never fires) and the concurrent-pull image-cache
  race (the heal path likewise remains as a safety net).

## [0.7.0] - 2026-08-04

### Added

- **`GenericContainer.withDiskLimit(megabytes)`** caps the writable root disk
  on microsandbox (`--root-disk <mb>M`); docker runs without a ceiling and
  ignores it. On an msb reboot the ceiling can only grow, never shrink.
  Mutually exclusive with `withTmpfsRoot()` — `start()` throws
  `RootDiskConflictError` before any backend call if both are set. msb also
  rejects any root-disk setting on a `fromCheckpoint()` restore before boot,
  since the snapshot itself pins the root disk.
- **`GenericContainer.withTmpfsRoot(megabytes)`** backs the writable root
  with RAM instead of disk on microsandbox (`--root-disk tmpfs:<mb>M`) —
  faster ephemeral containers, no disk residue left behind; docker ignores
  it. Must fit inside the guest memory: msb defaults to 512M when
  `withMemoryLimit` is unset, and `start()` throws
  `TmpfsRootExceedsMemoryError` when both are set and the tmpfs size exceeds
  the memory limit. A tmpfs root cannot be checkpointed — `checkpoint()`
  throws `TmpfsRootCheckpointError` before touching anything, so a refused
  named re-checkpoint leaves the existing checkpoint under that name intact.
- **`GenericContainer.withNetworkDisabled()`** blocks the guest's
  public-internet access on microsandbox (`--net private`) — published ports
  keep serving and private-range links keep working, only outbound
  connections to the public internet fail; docker ignores the flag entirely,
  since there's no portable way to block egress there while keeping
  published ports reachable. Cannot be combined with `withNetwork()` —
  `start()` throws `NetworkDisabledConflictError` before any backend call if
  both are set.

### Changed

- **msb checkpoint artifacts now live under `<cacheDir>/checkpoints/`**
  (`~/.cache/rightsize` on macOS/Linux, `%LOCALAPPDATA%\rightsize` on
  Windows), created via msb's `--dest-dir` rather than its own default
  snapshot store. `Checkpoint.ref` for msb is now the absolute artifact
  path — the ref remains an opaque string throughout the public API, and an
  old bare-name ref from an earlier release still restores. The snapshot
  still appears in `msb snapshot list` (msb keeps its own global index
  alongside the dest-dir artifact); removing it through this library
  (`Checkpoints.remove`, the `removeCheckpoint` SPI) cleans both. Export and
  import are unaffected.
- **`ContainerSpec` gained three required members** —
  `diskLimitMb: number | undefined`, `tmpfsRootMb: number | undefined`, and
  `networkDisabled: boolean` — backing the three builders above. Anything
  constructing a `ContainerSpec` object literal directly, such as a custom
  `SandboxBackend` test fixture, needs to add them.

### Fixed

- **Container boot's install-lock retry now also recognizes msb's second
  refusal phrasing.** msb 0.6.8 words the "an install is already in
  progress" refusal differently depending on which side holds the lock —
  "microsandbox install operation in progress until `<ts>`; retry after it
  completes" or "another microsandbox install operation is in progress until
  `<ts>`" — and the boot-retry classifier only recognized the first. Both
  phrasings now route through the same 30-second polling retry instead of
  the second one failing the boot outright.

## [0.6.1] - 2026-08-01

### Changed

- **The pinned microsandbox release is now 0.6.8** (was 0.6.6). The provisioner
  downloads and checksum-verifies it automatically, so no action is needed for the
  usual setup.

  **If you point `MSB_PATH` at your own msb binary, it must be 0.6.8 or newer.**
  0.6.8 renamed three CLI surfaces this library drives, and the calls it now emits do
  not exist in 0.6.6:

  | 0.6.6 | 0.6.8 |
  |---|---|
  | `run --snapshot <ref>` | `run --from-snapshot <PATH_OR_NAME>` |
  | `snapshot export <ref> <dest>` | `snapshot save <SNAPSHOT> <OUT>` |
  | `snapshot import <archive>` | `snapshot load <ARCHIVE> [DEST]` |

  Checkpoint restore and checkpoint archives are the affected features; both fail
  outright against an older binary rather than degrading quietly.

- **A loaded snapshot's effective ref is now a bare 64-character digest**, where 0.6.6
  produced a `sha256-<16hex>` directory name. Nothing in the public API changes — the
  ref was always opaque and content-addressed — but code that pattern-matched the old
  shape will need updating.

- **`FileMount.readOnly` is now `false` for mounts made through
  `withCopyFileToContainer`, and the flag is genuinely enforced on the microsandbox
  backend.** It previously never reached msb, so every mount was writable there
  regardless of what the flag said; the docker backend enforced it all along. What a
  caller observes: a default mount on docker was read-only before and is writable now —
  pass a read-only mount explicitly to get the old docker behavior, which both backends
  now honor as a guest-side write block. Either way the mount is a view of the host
  file, not a copy: a guest write through a writable mount reaches the host file
  itself.

### Fixed

- The Cassandra module's `GPG_KEYS` override remains required: 0.6.8 still aborts
  before the VM starts on any image whose baked environment contains a tab, verified
  directly against this release.

- **File mounts work on Windows.** msb 0.6.7 broke every start-time file mount there:
  its mount-spec parsing splits a token-less spec at the drive letter's colon, both on
  the CLI spec and again on an internally rebuilt one. Every mount spec this backend
  emits now carries an explicit `ro`/`rw` token plus `nodev`, keeping both layers
  parseable. `nodev` is meaningless for a single-file mount.

- **Checkpoint archives export on Windows again.** msb 0.6.7/0.6.8 fail every
  `snapshot save` there (`Access is denied. (os error 5)`: the finished archive is
  fsynced through a read-only handle one step before the final rename). When exactly
  that failure occurs with exactly one finished staging file beside the destination,
  the backend completes the rename itself — transparent, Windows-only, and
  self-disabling once msb fixes the fsync.

- **Container boot rides out msb's transient `install operation in progress` refusal**
  by polling for up to 30 seconds instead of failing on the first attempt.

## [0.6.0] - 2026-07-28

### Upgrading from 0.5.0

Two changes affect existing code.

**Modules no longer pin an image version.** `new RedisContainer()` previously booted
`redis:8.6-alpine`; it now boots `redis:latest`. Your tests will run whatever version
upstream currently publishes, which is the point — the version tracks the image's own
releases rather than this package's. To keep a specific version, name it:
`new RedisContainer("redis:8.6-alpine")`. Redis, Valkey, Postgres, and Memcached
additionally move from an Alpine variant to the Debian-based `latest`: functionally
equivalent, noticeably larger to pull.

**`ElasticsearchContainer` has no default image.** Elastic publishes no floating tag —
`elasticsearch:latest`, `:9`, and `:8` are all `404` on Docker Hub — so an explicit
version is required and there is nothing this module could pick on your behalf:
`new ElasticsearchContainer("elasticsearch:9.4.4")`.

An explicitly supplied image is also now checked against the repository the module
understands, so passing an unrelated image fails immediately with
`IncompatibleImageError` instead of timing out against the wrong server. If the image
really is a drop-in replacement, say so:
`DockerImageName.parse("mycorp/pg-hardened:16").asCompatibleSubstituteFor("postgres")`.

### Added

- **`DockerImageName`** (`src/core/docker-image-name.ts`) — a parsed
  `[registry/]repository[:tag][@digest]` image reference, built via
  `DockerImageName.parse(string)`. Every module constructor now accepts
  `string | DockerImageName` and resolves it through `requireCompatible`,
  which checks the supplied image's repository against the one the module
  declares before any port, wait-strategy, or backend work runs, throwing the
  new typed `IncompatibleImageError` on a mismatch rather than degrading into
  a bare wait-strategy timeout. `DockerImageName.asCompatibleSubstituteFor(string)`
  is the escape hatch for a private mirror, a hardened rebuild, or a rename.
  Registry-host stripping follows the Docker convention: the first path
  segment is a registry only if it contains a `.` or a `:`, or is exactly
  `localhost`.
- **`ElasticsearchContainer`** — a single-node Elasticsearch container.
  Elastic publishes no floating tag for this image
  (`elasticsearch:latest`/`:9`/`:8` are all `404` on Docker Hub), so this
  module has no default parameter — an explicit image is required. Readiness
  checks plain connectivity rather than cluster health, since a single
  node's health stays `yellow` forever (no peer to place replica shards on).
- **`QdrantContainer`** — a single-node Qdrant vector database container,
  defaulting to `qdrant/qdrant:latest`. Readiness is Qdrant's own `/readyz`
  probe, which answered on the first poll in direct verification; no memory
  limit is needed.

### Changed

- **Every one of the 21 pre-existing modules now defaults to a floating
  image reference** instead of a pinned version, and checks any explicitly
  supplied image against the repository it understands via `DockerImageName`
  (see above). Most float to `<repository>:latest`; `RabbitMQContainer`
  floats to `rabbitmq:management` instead, since plain `latest` lacks the
  management plugin the module is built around. Redis, Valkey, Postgres, and
  Memcached move from a pinned Alpine variant to the Debian-based `latest`.
  No env var, port, wait strategy, memory limit, or command changed — each
  module's own doc comment and docs page states which pinned version its
  readiness signal, memory floor, and timing facts were verified against.

### Fixed

- **An `exec` issued immediately after `start()` could fail to reach the guest.** A
  sandbox reports `Running` before the in-guest agent has created the endpoint `exec`
  connects to; the gap is invisible whenever a wait strategy runs first, which is every
  module, but a caller that starts and execs at once could lose the race — reliably so on
  Windows, where the endpoint is a named pipe. `exec` now retries on that one signature.
  A guest command's own non-zero exit, and any agent error raised after connecting, still
  return on the first attempt.
- **`MongoDBContainer`'s replica-set budget is now 180s**, up from 60s. `rs.initiate`
  was observed failing at exactly the 60s mark on a loaded Windows CI runner against the
  floating default, matching the budget MySQL and ClickHouse already carry.

## [0.5.0] - 2026-07-25

### Added

- `ValkeyContainer` — a single-node Valkey container, the Redis-protocol-compatible
  fork. Readiness is anchored on Valkey's own `Ready to accept connections` log line,
  and `uri` returns a `redis://` URI because that is the scheme every Redis-protocol
  client parses.
- `MinIOContainer` — a single-node MinIO server, S3-compatible object storage. The
  image needs an explicit `server /data --console-address :9001` command, which this
  module always sets; readiness is MinIO's own `/minio/health/live` probe on the S3 API
  port. Defaults to a `testuser`/`testpassword` root pair, since MinIO rejects a root
  password shorter than eight characters.
- `CassandraContainer` — a single-node Apache Cassandra, ready-checked on its
  `Starting listening for CQL clients` log line. The module overrides the image's baked
  `GPG_KEYS` value, which contains a tab: the microsandbox backend aborts before the VM
  starts on any image whose baked environment carries one. `GPG_KEYS` is consumed only
  at image-build time, so the override has no effect on the running server.

## [0.4.0] - 2026-07-18

### Added

- Checkpoint export/import: `Checkpoints.exportTo(checkpoint, path)` bundles
  a checkpoint into a portable archive (a plain tar of `checkpoint.json` —
  pinned metadata plus the format version — and an `artifact` member holding
  the backend's own payload: `msb snapshot export` on microsandbox, `docker
  save` on docker); `Checkpoints.importFrom(path)` materializes it on a
  machine running the same backend and returns a restorable `Checkpoint`,
  the CI-cache pattern (export after seeding, cache the archive, import on
  later runs) from the [checkpoints guide](https://ngriaznov.github.io/rightsize-node/guide/checkpoints#moving-checkpoints-between-machines).
  Archives never bundle the OCI image (`--with-image` fails an integrity
  check on msb import) — the destination pulls it on first boot. `exportTo`
  requires the active backend to match the checkpoint's own and the
  artifact to still exist (`CheckpointArtifactMissingError` otherwise, both
  before any filesystem work); `importFrom` requires the archive's recorded
  backend to match the active one (`CheckpointBackendMismatchError`) and the
  archive to be well-formed (`MalformedCheckpointArchiveError` otherwise),
  both before any backend call or registry write. A named archive's import
  replaces an existing same-name registry entry the same way `checkpoint(name)`
  does; an unnamed archive imports as an ephemeral checkpoint. On
  microsandbox the effective ref after import is a content digest
  (`sha256-<hex>`), resolved via `msb snapshot list --format json` — never
  the archive's own `rz-ckpt-<name>` ref, since `msb snapshot import` writes
  under a digest-derived directory name it doesn't let the caller choose;
  re-importing byte-identical content is treated as success, not failure.
  Docker's effective ref round-trips unchanged. New SPI:
  `SandboxBackend.exportCheckpoint(ref, destFile)` and
  `SandboxBackend.importCheckpoint(srcFile, ref) -> effectiveRef`.

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
