# Releasing rightsize

Releases go to [npm](https://www.npmjs.com/) as the unscoped package
`rightsize`. npm has no namespace verification — the first publish claims the
name permanently.

Publishing runs only from CI — the `release` workflow
(`.github/workflows/release.yml`, manual trigger). No local `npm login` is part
of the flow.

## One-time setup

1. Create/log in to the npm account and verify its email address.
2. Enable two-factor authentication on the account (Account Settings →
   Two-Factor Authentication).
3. Create a granular access token with publish permission for this package and
   store it as the `NPM_TOKEN` Actions secret in this repository. The token
   bypasses the 2FA OTP prompt — the deliberate click that replaces it is
   running the workflow.

## Per release

1. Confirm `main` is green in CI, including `msb-windows`.
2. Set `version` in `package.json` (npm versions are plain, no snapshot
   convention — the committed version is the next release's number).
3. Move the CHANGELOG's `Unreleased` content under a dated `## [X.Y.Z]` heading,
   and update the README/docs install snippets if they pin a version.
4. Inspect exactly what would ship:

   ```sh
   npm pack --dry-run
   ```

   The tarball must contain only `dist/`, `LICENSE`, `NOTICE`, `README.md`, and
   `package.json` — no `dist-test`, no fixtures, no sources.
5. Push `main`, then publish from CI: Actions → `release` → Run workflow.
   `prepublishOnly` rebuilds `dist/` and runs typecheck + the node unit suite
   inside the workflow, so a stale or broken build cannot ship, and
   `--provenance` attaches a signed attestation linking the tarball to the
   repository and run. Unscoped packages default to public — no `--access`
   flag needed.
6. Tag and push:

   ```sh
   git tag vX.Y.Z && git push origin main vX.Y.Z
   ```

7. Unpublishing is only easy for 72 hours (npm's policy window); after that,
   treat every published version as permanent. `npm deprecate` is the tool for
   steering users off a bad version.

## Install

```sh
npm install --save-dev rightsize
```
