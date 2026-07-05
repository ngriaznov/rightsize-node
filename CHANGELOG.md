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
