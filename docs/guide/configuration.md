# Configuration

## Environment variables

| Variable | Effect |
|---|---|
| `RIGHTSIZE_BACKEND` | Force `microsandbox` or `docker`, overriding auto-selection. |
| `MSB_PATH` | Use a pre-installed `msb` binary; skips the download/provisioning step entirely. |
| `RIGHTSIZE_CACHE_DIR` | Relocate the runtime cache (default `~/.cache/rightsize`). |
| `RIGHTSIZE_MSB_SKIP_DOWNLOAD` | `true` = fail with guidance instead of downloading — for air-gapped CI; pair with `MSB_PATH` or a pre-seeded cache. |
| `RIGHTSIZE_REAPER` | `on` (default) / `sweep` / `off` — controls orphan reaping. See [Orphan reaping](/guide/reaping). |
| `RIGHTSIZE_REUSE` | `true` or `1` — the second half of reuse's double opt-in (paired with `.withReuse()` on the builder). See [Container reuse](/guide/reuse). |
| `DOCKER_HOST` | A `unix://` socket path (or bare path) for the Docker backend to dial instead of the default `/var/run/docker.sock`. |

See [Backends](/guide/backends) for how these combine with automatic
selection.

## Runtime support

| Runtime | Minimum |
|---|---|
| Node.js | `>=22.11` (the 22.x "Jod" LTS line) |
| Bun | `>=1.1` |

The library is authored in TypeScript using `await using`, and compiled to
ES2022 plus the downlevelled explicit-resource-management helpers — the
shipped `dist/**.js` runs unmodified on both runtimes with no flags. Node
22.11+ carries the `Symbol.asyncDispose` global those helpers dispatch to;
Bun ships it natively. See the [Lifecycle guide](/guide/lifecycle) for what
this buys you.

## Development

```bash
npm install                 # installs dependencies
npm run build                # compiles src/ to dist/
npm run typecheck            # tsc --noEmit
npm test                     # unit suite, both runtimes (test:node + test:bun)
npm run coverage:core        # core coverage, 80% line floor
```

Integration tests boot real containers and are gated behind
`RIGHTSIZE_IT=1`, forcing a backend explicitly:

```bash
RIGHTSIZE_BACKEND=microsandbox npm run test:node:it   # needs Apple Silicon or Linux + /dev/kvm
RIGHTSIZE_BACKEND=docker npm run test:node:it         # needs a reachable Docker daemon
```

Docs:

```bash
npm run docs:dev             # local dev server
npm run docs:build           # static build
npm run docs:verify          # extracts every fenced ts/typescript block from
                              # README.md + docs/** and typechecks it
npm run docs:api-check       # fails on any undocumented public API surface
```
