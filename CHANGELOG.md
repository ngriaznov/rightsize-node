# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- **The pinned microsandbox release is now 0.7.1** (from 0.6.18). Upstream's 0.7.0/0.7.1
  bring guest stream-symlink fixes at agent startup, configurable TCP/UDP connection
  limits, opt-in startup/network traces, and explicit snapshot flush policies (a new
  optional `--flush` flag; full snapshots — the shape this library's checkpoints use —
  keep their existing default). One driven CLI flag was renamed upstream —
  `msb snapshot create --from` became `--from-sandbox` — and this library's
  checkpoint machinery now emits the new spelling; nothing changes for callers.
- **Checkpoint restore now goes through `msb restore` instead of
  `msb run --from-snapshot`.** Upstream 0.7.1 removed `run --from-snapshot`
  outright (`msb run` rejects it as an unexpected argument) and moved restore to
  a dedicated `msb restore <ref> --name <name>` command; this library's
  checkpoint reboot (both the internal stop/snapshot/reboot cycle and
  `GenericContainer.fromCheckpoint().start()`) now emits that instead. This
  restore is inherently a cold boot of the captured disk without resuming
  processes/RAM — the same semantics this library's checkpoints have always
  had — so nothing changes for callers there; the command never carries a
  `--disk-only` flag (an earlier build of this same release briefly emitted
  one, but a disk-scope snapshot — the only kind `msb snapshot create`
  produces — rejects it outright with `invalid config: disk_only requires a
  full snapshot with checkpoint state`, so it is never sent). One narrower
  behavior does change on microsandbox: `msb restore` has no `-e`/`--env`
  flag at all (a restore replays the sandbox's own captured configuration,
  making a re-passed env redundant), so a `withEnv()` call after
  `fromCheckpoint()` that actually changes the env beyond what the
  checkpoint captured now throws a new `CheckpointRestoreEnvOverrideError`
  at `start()` instead of silently reaching the restored guest — docker is
  unaffected, since restoring there is an ordinary `docker create`/`run` with a
  fresh env array. `msb restore` also has its own mount (`--volume`) and
  network-policy (`--no-net`) flags, distinct from `run`'s `--mount-file`/`--net
  private` — the internal stop/snapshot/reboot cycle now re-emits a checkpointed
  sandbox's own `withCopyFileToContainer()` mounts and `withNetworkDisabled()`
  setting across the reboot through those flags, so both survive `checkpoint()`
  the same as ports already did, instead of silently dropping.
- **Checkpoint refs on the microsandbox backend now point at msb's own
  snapshot-store layout, not this library's own naming.** `msb snapshot
  create --from-sandbox <sandbox> <name> --dest-dir <dir>` no longer writes
  its artifact at `<dir>/<name>` — since 0.7.1 it always lands nested at
  `<dir>/<sandbox>/snap_<digest>`, a content-addressed path the caller-
  supplied name has no say over (the name only ends up in msb's own index).
  `Checkpoint.ref` on the microsandbox backend now looks like
  `<cacheDir>/checkpoints/<sourceSandbox>/snap_<hex-digest>` instead of
  `<cacheDir>/checkpoints/rz-ckpt-<name-or-random-suffix>` — still an
  absolute path under the same checkpoints directory, still opaque as far as
  this library's public API goes, but the exact basename and nesting have
  changed; code that parsed or logged the old shape should switch to
  checking that the checkpoints directory is an ancestor and the basename
  matches `snap_<hex>`. `Checkpoints.find`/`fromCheckpoint()`/the named-
  checkpoint registry all keep working unchanged, since they store and
  restore whatever ref the backend actually hands back rather than
  assuming its shape. Removing a checkpoint (`Checkpoints.remove`,
  `removeCheckpoint`, or the documented `msb snapshot rm` CLI one-liner) now
  operates by that same artifact path rather than a bare name — msb 0.7.1's
  snapshot removal does not resolve a bare name or `group:member` form at
  all. **Known limitation:** removing a checkpoint that is still the newest
  of several snapshots from the same source sandbox is refused by msb
  outright (`invalid config: cannot remove current head ...; first select
  another snapshot with 'msb snapshot head ...'`); this library propagates
  that refusal as an error rather than attempting automatic head rotation —
  select another snapshot as head with msb's own CLI first, or remove the
  older siblings before the newest one.
- **Checkpoint archives on the microsandbox backend now go through `msb
  snapshot save`/`msb snapshot load` instead of the removed `msb snapshot
  export`/`msb snapshot import`.** Upstream 0.7.1 renamed both subcommands
  outright (the old spellings no longer exist at all) and changed `load`'s
  contract: it now takes a `--dest <dir>`, which this library always passes
  (the checkpoints cache directory, the same one created checkpoints already
  land under) rather than letting an import fall through into msb's own
  global default snapshot store. `Checkpoints.exportTo`/`Checkpoints.importFrom`
  are unaffected — same signatures, same archive file naming — but
  **`importFrom`'s effective ref on microsandbox now points at the loaded
  artifact's own path** (`<cacheDir>/checkpoints/<generated-group>/snap_<hex-digest>`,
  parsed straight out of `snapshot load`'s own printed output — a group
  line, a digest line, then the artifact path as the last line) instead of a
  bare digest-dir name resolved via a separate `msb snapshot list`
  confirmation call, which is gone along with the pre-0.7.1 `load` shape it
  existed to work around. An imported ref is now the same absolute-path,
  `checkpoints`-directory-nested, `snap_<hex>`-basename shape a freshly
  created checkpoint's ref already has, rather than a differently-shaped
  digest string — visible if you print or log an imported checkpoint's
  `ref`, harmless otherwise (refs stay opaque throughout this library, and
  `Checkpoints.find`/`fromCheckpoint()` keep working unchanged). Docker is
  unaffected — `docker load` still preserves the original tag.
- **The MinIO module's default image moved to `quay.io/minio/minio:latest`.**
  Docker Hub's `minio/minio` repository has been removed upstream (`docker pull`
  now fails with "repository does not exist"); `quay.io/minio/minio` is MinIO's
  maintained mirror. The compatibility check `MinIOContainer` uses to accept a
  caller-supplied override is registry-agnostic (it compares the parsed
  `minio/minio` repository only, ignoring any registry host), so both
  `quay.io/minio/minio:<tag>` and `minio/minio:<tag>` overrides keep working
  unchanged.
- **Restored microsandbox containers now have their workload restarted by
  rightsize itself, via an `msb exec` session.** EMPIRICALLY VERIFIED against
  msb 0.7.1: `msb restore` boots a restored sandbox with ONLY its guest agent
  inside — the captured workload never re-executes on its own (`msb start`/
  `msb logs` against such a sandbox are equally idle/empty). This broke the
  checkpoint contract for every restore on this backend: a restored container
  behaved as though nothing had ever run in it. Both the internal
  `checkpoint()` stop/snapshot/reboot cycle and `GenericContainer
  .fromCheckpoint().start()` now revive the workload themselves the instant a
  restore reaches Running, spawning a long-lived, attached `msb exec [-e
  KEY=VALUE]... <name> -- <argv>` session with the checkpoint's own env — the
  wait strategy runs only after that exec is spawned. This exec child slots
  into the same attached-child role an ordinary boot's `msb run` process
  fills: child-exit-based death detection, reap-on-stop, and every other
  attached-child teardown semantic apply to it unchanged. The workload argv
  comes from the checkpoint's own explicit command when the source container
  had one; when it did not (the image's own default entrypoint was running),
  `checkpoint()` now also captures that entrypoint's cmdline from the guest
  immediately before stopping the source sandbox, and restore falls back to
  it. That captured cmdline is stored as `capturedCommand`, an ADDITIVE and
  OPTIONAL field on a named checkpoint's registry entry — old registry
  entries without it keep reading fine. A checkpoint that predates
  workload-cmdline capture (or whose capture attempt itself failed) and also
  carries no explicit command now throws `CheckpointWorkloadCommandMissingError`
  at restore time rather than silently booting the sandbox idle. No public
  API changes: `Checkpoint`, `ContainerSpec`, and the checkpoint registry file
  format are all unchanged and stay backward-compatible.
- **`msb restore` hitting a Windows file-handle-release-lag failure on its
  own just-written snapshot artifact is now retried.** Observed on Windows CI
  immediately after the source sandbox's own teardown in the checkpoint
  cycle: `msb restore` intermittently fails with exit 1 and `error: io
  error: Access is denied. (os error 5)` — msb's own docs describe deferred
  file-handle release on Windows, and the snapshot artifact `msb restore`
  was asked to read can still be mid-release for a brief window right after
  it was written. This backend now classifies that specific output shape
  (matching `"Access is denied"` together with `"io error"`/`"os error 5"`
  conservatively) as a retryable transient of the restore invocation and
  retries it a bounded number of times with a short backoff, mirroring the
  install-lock and state-database retry policies this backend already has.
  The signature never occurs on unix, so this is a no-op there.
- **`createCheckpoint`'s own reboot previously retried msb's "sandbox
  already exists" refusal on a genuine ~30-second budget (2-second
  intervals) instead of failing the checkpoint outright on the first hit.**
  The checkpoint cycle removes the source sandbox and immediately restored a
  fresh one under the same name; on Windows, msb 0.7.1's own restore-time
  collision check (`existing.is_some() || dir_exists`) can still see either
  the just-removed sandbox's database record or its on-disk directory as
  present for a window after `msb rm` returns — the directory in particular
  has been observed on CI outliving the database record by more than 3.5
  seconds under load, well past what a handful of short retries could ever
  outlast. The retry budget mirrored this backend's own install-lock poll
  shape and applied only to this reboot — an ordinary
  `GenericContainer.fromCheckpoint().start()` restoring a name that turns
  out to still be live keeps failing immediately, since reusing a live name
  is a real error, not this backend's own release race. Superseded by the
  fresh-name reboot below, which sidesteps the Windows race structurally
  rather than retrying through it — the budget itself is unchanged and
  stays in place as dormant defense (see the next entry).
- **`createCheckpoint`'s reboot now restores under a FRESH sandbox name,
  never the source sandbox's own.** Previously the checkpoint cycle
  (`msb stop` → `msb snapshot create` → `msb rm` → `msb restore`) restored
  the new sandbox under the exact name it had just removed — the entry
  above's retry budget existed only to paper over the Windows race that
  same-name restore created. This reboot now mints a fresh name via the
  same `rz-<runId>-<seq>` generator every ordinary `GenericContainer.start()`
  boot already uses, and updates the live `SandboxHandle` in place (its
  `id` and `spec.name`) so every subsequent call against it — `exec`,
  `logs`, `stop`, `remove`, a later `checkpoint()` — transparently targets
  the new sandbox; callers holding a `GenericContainer` see no difference at
  all. Ports, env, memory limit, mounts, and network isolation all carry
  over unchanged — only the underlying sandbox name differs, which was
  always an implementation detail, never part of what a checkpoint promises
  to preserve. The already-exists retry budget and the reaper ledger's
  install-lock-style dormant defenses are unchanged and untouched — they
  simply no longer trigger on the ordinary path, since a name nothing else
  has ever used cannot collide with a lingering directory on a loaded
  Windows host. The one place this IS observable: if you log or otherwise
  surface a sandbox's name yourself (e.g. via `msb ls`), that name changes
  across a `.checkpoint()` call — this was never part of this library's
  public API (`GenericContainer` exposes no name/id getter), so no
  application code should need to change, but anything that greps `msb ls`
  output for a specific sandbox name across a checkpoint should expect the
  new one.
- **Every msb restore retry — `createCheckpoint`'s own reboot AND the
  ordinary `GenericContainer.fromCheckpoint().start()` path — now mints a
  FRESH sandbox name on every attempt, never reusing one that just
  failed.** LIVE-VERIFIED against a real msb 0.7.1 binary: `msb restore
  --name X` validates the snapshot artifact FIRST — an integrity failure
  exits 1 and leaves no sandbox record at all — but a failure AFTER
  validation (its Windows access-denied signature in particular,
  `RestoreAccessDeniedError`) leaves `X` behind as a STOPPED SANDBOX RECORD
  visible in `msb ls`, and any retry of `restore --name X` then fails
  outright with msb's own "already exists" refusal. Every restore retry
  this library performs previously kept retrying under the exact name that
  had just failed — confirmed on Windows CI as the root cause of five
  checkpoint-reboot tests colliding on their own reboot names for the
  entire retry budget the moment the first attempt hit that access-denied
  failure, and the same shape awaited a first Windows access-denied hit on
  a plain `fromCheckpoint().start()` restore, one layer down. Every retry
  attempt (checkpoint reboot or ordinary restore alike) now mints a
  brand-new name from the same generator instead of reusing the failed one,
  tracks it in the reaper ledger before that attempt's own restore runs,
  and best-effort `msb rm`s the failed attempt's name (result ignored —
  cheap cleanup that correctness no longer depends on, now that the next
  attempt never reuses that name) before advancing. The overall retry
  budget/count and delay between attempts are unchanged for both paths,
  only what happens on each individual retry. No public API changes: the
  WINNING attempt's name is still the one `GenericContainer.checkpoint()`'s
  returned `Checkpoint`, `fromCheckpoint().start()`'s own resolved
  container, and every subsequent call against either transparently
  target, exactly as before.
- **A restore retry on Windows now escalates to a job-free launch after its
  first, always-direct attempt hits msb's access-denied refusal — dormant
  defense for callers whose test/CI harness wraps its worker processes in a
  Windows job object.** A four-round live diagnostic campaign traced the
  access-denied signature the two entries above already retry
  (`RestoreAccessDeniedError`) to something other than a file-handle release
  lag: `msb restore` is detached by design and always spawns a brand-new
  `msb.exe` to supervise the restored sandbox, and on Windows that spawn
  unconditionally requests job-breakaway (`CREATE_BREAKAWAY_FROM_JOB`). When
  the CALLING `msb.exe` itself sits inside a job object that was never
  granted `JOB_OBJECT_LIMIT_BREAKAWAY_OK` — exactly what Gradle test workers
  and cargo-test binaries do, and what Jest/Vitest workers and several CI
  systems do too — Windows refuses the spawn outright with
  `ERROR_ACCESS_DENIED`, which is the same "Access is denied. (os error 5)"
  text this library was already retrying, just misattributed. This
  repository's own Windows CI lane is unaffected either way (node's test
  workers add no such job object, which is why it has stayed green), but the
  sibling rust/kotlin libraries hit it deterministically, and a fix is also
  being reported upstream. The mitigation, live-validated against the exact
  environment where a direct spawn is denied: launching the identical
  `msb restore` through Windows Management Instrumentation
  (`Invoke-CimMethod -ClassName Win32_Process -MethodName Create`) runs the
  new process under `WmiPrvSE`, outside the caller's job hierarchy
  entirely, and succeeds every time. The fresh-name retry loops in both
  entries above now carry this as an escalation, not a replacement: the
  FIRST attempt of any restore retry is always the ordinary direct spawn,
  unconditionally, on every platform — nothing changes for a healthy
  environment. Only once an attempt hits `RestoreAccessDeniedError` on a
  Windows host does every REMAINING attempt of that same retry loop switch
  to launching through this WMI broker instead, and it stays on the broker
  for the rest of that loop even if a later attempt's own failure is
  merely "already exists" rather than access-denied again. Off Windows, or
  on a Windows host that never hits the access-denied signature in the
  first place, this new code path is never reached at all. If the broker
  mechanism itself fails to run (no `powershell.exe` on the host, or
  Windows refuses to even create the brokered process) that one attempt
  falls back to an ordinary direct spawn and the retry loop keeps going —
  the broker is defense-in-depth, never a new way for a restore to fail
  outright. No public API changes.

### Fixed

- **Checkpointing a container whose backend renames the sandbox mid-reboot no
  longer leaks its exit-path cleanup registration.** `GenericContainer
  .checkpoint()` on the microsandbox backend mutates the live handle's own id
  to the fresh post-reboot sandbox name (see the fresh-name reboot entry
  above); the process-exit cleanup registry (`core/cleanup.ts`) keys its
  entry by the id a container had at `start()` time, so a later `stop()` —
  looking itself up by the handle's CURRENT, renamed id — could never find
  and remove that original entry, leaking it for the rest of the process.
  `checkpoint()` now re-keys its own registration whenever the backend
  renames the handle during the call, mirroring the same `keepAlive`
  exclusion `start()` already applies before registering in the first place.
  Harmless on docker (which never renames a handle), but on microsandbox this
  leaked one stale entry per checkpoint — invisible in an ordinary process
  lifetime, but under Bun (which runs an entire test suite in one shared
  process) it accumulated across test files and broke unrelated assertions
  that the live-container registry (`liveContainers()`, `diagnostics()`'s own
  data source) starts empty.
- **Re-checkpointing under the same name now reliably clears the prior
  checkpoint's artifact on microsandbox too, not just on docker.**
  `GenericContainer.checkpoint(name)`'s replace-semantics pre-removal step
  used to best-effort remove only the freshly-minted NOMINAL ref
  (`checkpointRef(backend.name, name)`), which is deterministic — and
  therefore correct — on docker, but since msb 0.7.1 no longer corresponds
  to where microsandbox actually puts the artifact (a content-addressed
  `snap_<digest>` path — see the ref-layout entry above); the pre-removal
  call was a no-op against a path that was never real, so the prior
  checkpoint's real artifact was silently orphaned on every same-name
  re-checkpoint on that backend. `checkpoint(name)` now looks up the name's
  EXISTING registry entry first (the same lookup `Checkpoints.remove(name)`
  itself uses) and, when one exists for the currently active backend,
  removes the artifact at that entry's own recorded ref — the prior
  checkpoint's actual location, on either backend — before also
  best-effort clearing the nominal ref as before (a harmless no-op on
  docker, where the two refs are the same value). `Checkpoints.remove(name)`
  is no longer required as a manual workaround before re-checkpointing under
  the same name on microsandbox. No public API changes: `checkpoint()`'s
  signature, return type, and error surface are all unchanged.

## [0.7.9] - 2026-09-10

### Changed

- **The pinned microsandbox release is now 0.6.18** (from 0.6.17). Upstream changes
  are release-pipeline fixes plus incremental network-stack work (policy, secrets,
  proxy internals). No CLI surface this library drives changed.

## [0.7.8] - 2026-09-04

### Changed

- **The pinned microsandbox release is now 0.6.17** (from 0.6.16). Upstream changes
  relevant here: outbound SOCKS4/SOCKS5 proxy support (new, additive `--proxy` flags
  this library does not yet drive), a fix preserving the released order of state-db
  migrations across upgrades, and a centralization of sandbox CLI option parsing. No
  CLI surface this library drives changed.

## [0.7.7] - 2026-09-01

### Added

- **The docker backend now works on Windows, against Docker Desktop's named pipe.**
  `DOCKER_HOST` unset now resolves to `\\.\pipe\docker_engine` on win32 (unchanged
  everywhere else: `/var/run/docker.sock`), and a `DOCKER_HOST=npipe://...` value is
  parsed the same way `unix://...` already was. Provider detection (`isSupported()`)
  probes the named pipe's existence the same way it already probes the unix socket,
  so a Windows machine without Docker Desktop running still gets a clean
  `is_supported=false` and a named `unsupportedReason()` rather than a hang or a
  cryptic connection error. No change on unix: same default socket path, same
  fallback behavior for an unparseable `DOCKER_HOST`, same errors. Detection is
  further tightened to require the daemon itself report `"Os":"linux"` via a
  time-bounded probe, so a reachable-but-Windows-containers daemon (or, in
  principle, any non-Linux daemon) now correctly reads as unsupported instead of
  a false positive.
  The process-exit synchronous teardown (`cleanupSync`) also now works on Windows:
  it no longer shells out to `curl --unix-socket` there — curl's `--unix-socket`
  dials an AF_UNIX domain socket, which cannot reach a Windows named pipe — and
  instead runs `docker rm -f`, the same command this backend's reaper watchdog
  already relies on, so a container is torn down promptly on an ordinary graceful
  exit instead of leaking until the next startup sweep.

## [0.7.6] - 2026-08-29

### Changed

- **The pinned microsandbox release is now 0.6.16** (from 0.6.15). Upstream changes
  relevant here: network address slots are recycled instead of exhausting after many
  sandbox creations, single-file mounts are properly isolated, and a failed boot now
  renders a structured boot error in `msb logs`. One change IS behavior-relevant here:
  0.6.16's convergent-lifecycle rework means a workload that finishes quickly is only
  ever observed `Starting`, never `Running`, before its attached `msb run` process exits
  on its own — see the Fixed entry below for how the boot path adapts.

  **Downgrading `MSB_PATH` below 0.6.16 is not safe once anything has run against a
  0.6.16 `MSB_HOME`.** 0.6.16 migrates the shared state database, and an older msb
  binary pointed at an already-migrated `MSB_HOME` refuses outright with "database
  schema is newer than this msb binary".

### Fixed

- **A container whose command finishes quickly no longer fails `start()` on msb 0.6.16.**
  The boot path polls `msb ls` for `Running` while supervising the attached `msb run`
  child; on 0.6.16 a fast-completing workload's sandbox never surfaces as `Running` at
  all, so the child just exits 0 once the microVM has already run to completion — which
  used to be indistinguishable from a genuinely failed boot. It no longer is: when the
  attached child exits 0, `msb ls` reports the sandbox `Stopped`, AND `msb logs --source
  system` carries the boot-completion marker msb's guest agent writes once it comes up,
  the exit is now classified as a workload that completed before the poll could ever
  observe it running, not a boot failure. `stop()` on it remains a safe no-op, and it
  reports as not running like any other stopped sandbox. Any other combination — a
  non-zero exit, a state other than `Stopped`, or a missing marker — still fails exactly
  as before.

## [0.7.5] - 2026-08-26

### Changed

- **The pinned microsandbox release is now 0.6.15** (from 0.6.14). Upstream changes
  relevant here: host DNS on Windows now routes through the system resolver, file
  copies on NTFS only copy allocated ranges, and read-only mounts no longer get
  write-probed. No CLI surface this library drives changed.

### Fixed

- **Host ports that hit a bind conflict are no longer eligible for the immediate retry.**
  The port-retry loop used to return a conflicted port to the allocator before the next
  attempt, so the OS could hand the same proven-contended port straight back. Conflicted
  ports now stay quarantined until the retry loop exits.

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
