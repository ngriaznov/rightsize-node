# Contributing

## tsconfig files

There are four `tsconfig*.json` files, each driving a different npm script.
None of them are interchangeable — pick the one that matches what you're
doing:

| File | Purpose | Driven by |
|---|---|---|
| `tsconfig.json` | Base config for editors/typecheck/lint — covers all sources, `src/**` and `test/**` alike; no emit assumed | `npm run typecheck`, `npm run lint` |
| `tsconfig.build.json` | Compiles `src/` only into the shipped `dist/` | `npm run build` |
| `tsconfig.test.json` | Compiles `src/` + `test/` into `dist-test/` for the test runners | `npm run test:node`, `npm run test:node:it`, `npm run coverage*` (via their `pre*` steps) |
| `tsconfig.examples.json` | Compiles `examples/` into `dist-examples/` | `npm run examples:build`, `npm run example:*` |

`tsconfig.build.json`, `tsconfig.test.json`, and `tsconfig.examples.json` all
`extend` the base config and only override `outDir`/`rootDir`/emit flags.

## npm scripts that matter

- `npm run build` — compiles `src/` to `dist/`; this is what gets published.
- `npm run typecheck` — `tsc --noEmit` against the base config (same as
  `lint`, which is currently identical).
- `npm test` — runs `test:node` then `test:bun`: the full unit suite on both
  runtimes.
  - `npm run test:node` — compiles via `tsconfig.test.json`, then
    `node --test` against `dist-test/**/*.test.js`.
  - `npm run test:bun` — runs the same `.test.ts` sources directly under
    `bun test`.
- Integration tests (real containers, gated behind `RIGHTSIZE_IT=1`):
  - `RIGHTSIZE_BACKEND=microsandbox npm run test:node:it` — needs Apple
    Silicon or Linux+KVM.
  - `RIGHTSIZE_BACKEND=docker npm run test:node:it` — needs a reachable
    Docker daemon.
  - Swap `test:node:it` for `test:bun:it` to run the same integration suite
    under Bun.
- `npm run coverage:core` — core coverage with an 80% line floor.
- `npm run docs:verify` — typechecks every code sample embedded in the
  README and `docs/guide/**`; run this after touching any documented
  snippet.
- `npm run examples:run` — builds and runs all three `examples/*` end to
  end (see the README's Examples section).

## Integration-test conventions

- Integration tests only run when `RIGHTSIZE_IT=1` is set — without it
  they're skipped, so the plain unit suite works with no container runtime
  at all.
- They run serially (`--test-concurrency=1` for `node --test`, no parallel
  workers for `bun test`) because they create and tear down real sandboxes
  by backend — concurrent runs would fight over ports and container names.
- Pick a backend explicitly with `RIGHTSIZE_BACKEND=microsandbox` or
  `RIGHTSIZE_BACKEND=docker`; the suite is written once and runs unchanged
  against either.
- Every test cleans up its own sandbox/network before returning. A test
  that leaks a container or a held port is a bug in that test, not
  something a later test should have to tolerate — CI expects the runtime
  to be in the same state after the suite as before it.

> **macOS in CI:** there is no `msb-macos` job — GitHub's hosted Apple Silicon
> runners are themselves VMs without nested virtualization, so microVMs cannot
> boot there (Hypervisor.framework rejects VM creation). macOS support is
> verified on real Apple Silicon hardware before release.
