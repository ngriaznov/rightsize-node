# Releasing rightsize

Releases go to [npm](https://www.npmjs.com/) as the unscoped package
`rightsize`. npm has no namespace verification — the first publish claims the
name permanently.

## One-time setup

1. Create/log in to the npm account and verify its email address.
2. Enable two-factor authentication on the account **before** the first publish
   (Account Settings → Two-Factor Authentication). With 2FA in "auth and
   writes" mode, every publish prompts for an OTP — that prompt is the only
   confirmation step in the whole flow.
3. `npm login` on the publishing machine.

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
5. Publish:

   ```sh
   npm publish
   ```

   `prepublishOnly` rebuilds `dist/` and runs typecheck + the node unit suite
   first, so a stale or broken build cannot ship. Unscoped packages default to
   public — no `--access` flag needed.
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
