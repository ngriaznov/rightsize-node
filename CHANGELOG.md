# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project has not yet made a tagged release.

## [Unreleased]

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
