# Backends

rightsize ships two implementations of one `SandboxBackend` interface:
`rightsize/backend-msb` (microVMs, via the `msb` CLI) and
`rightsize/backend-docker` (conventional containers, over a hand-rolled
unix-socket HTTP client). Both satisfy the same behavioral contract, verified
by a shared test suite that runs against each — code you write targets
`GenericContainer` and never a backend directly, so the same code runs
unchanged on either.

Importing a backend subpath registers it as a side effect:

```ts
import "rightsize/backend-msb";
import "rightsize/backend-docker";
```

Import whichever backend(s) you want considered; nothing else needs to
change.

## Selection

Selection is lazy and happens once per process, in this order:

1. **`RIGHTSIZE_BACKEND=microsandbox|docker`**, if set, wins outright — and it
   must be usable, or the run fails immediately naming the exact precondition
   that wasn't met (rather than silently falling through to the other
   backend).
2. Otherwise, **microsandbox** if the platform supports it: macOS on Apple
   Silicon, or Linux with a readable `/dev/kvm`.
3. Otherwise, **Docker** if a daemon socket is reachable.
4. Otherwise, fail — naming the exact precondition that failed for every
   registered backend, not just the first one considered.

Internally this is priority-based (microsandbox = 20, Docker = 10 — the
higher-priority *supported* backend wins with no explicit override), but the
four-step list above is the whole story that matters day to day.

| Platform | Backend used |
|---|---|
| macOS (Apple Silicon) | microsandbox (microVMs) |
| Linux x86_64 / arm64 with `/dev/kvm` | microsandbox (microVMs) |
| Windows x86_64 / arm64 (WHP enabled) | microsandbox (microVMs) |
| Intel Mac | Docker (auto-fallback) |
| Windows without WHP | Docker (auto-fallback)¹ |
| Linux without KVM | Docker (auto-fallback) |

¹ See the Docker unix-socket note below — Windows' Docker fallback needs a
daemon reachable over a unix socket, which is not Docker Desktop's default
on Windows.

## Environment variables

| Variable | Effect |
|---|---|
| `RIGHTSIZE_BACKEND` | Force `microsandbox` or `docker`, overriding auto-selection. |
| `MSB_PATH` | Use a pre-installed `msb` binary; skips the download/provisioning step entirely. |
| `RIGHTSIZE_CACHE_DIR` | Relocate the runtime cache (default `~/.cache/rightsize`; `%LOCALAPPDATA%\rightsize` on Windows). |
| `RIGHTSIZE_MSB_SKIP_DOWNLOAD` | `true` = fail with guidance instead of downloading — for air-gapped CI; pair with `MSB_PATH` or a pre-seeded cache. |
| `DOCKER_HOST` | A `unix://` socket path (or bare path); the Docker backend only ever dials a unix socket, never a TCP host — see below. |

## `backend-msb` deep-dive

**Provisioning.** On first use, if no runtime is cached (and `MSB_PATH` isn't
set), rightsize downloads a pinned `msb` release (currently `0.6.3`) plus its
`libkrunfw` companion library from GitHub releases, matched to your
OS/architecture. Every asset is SHA-256-verified against the release's
`checksums.sha256` before anything trusts it. Installation is atomic and
crash-safe: both files download to temp locations first, `libkrunfw` moves
into place, and the `msb` binary moves into place **last** — so the binary's
mere existence is the "install complete" marker. A cross-process file lock
serializes concurrent installs so parallel test workers provision exactly
once instead of racing.

**Attached-mode supervision.** microsandbox's detached mode (`msb run -d`)
does **not** start the image's own ENTRYPOINT — the VM boots with only its
init process, and the workload inside never launches. rightsize therefore
runs every sandbox **attached**: each container is a held child process
supervising its microVM, and the image's ENTRYPOINT/CMD runs exactly as it
would under Docker. Readiness is "the sandbox name shows `Running` in `msb
ls`" — not the attached process's own exit code or stdout; workload logs come
from a separate `msb logs` channel. See [How It Works](/guide/how-it-works).

## `backend-docker` deep-dive: why this client is hand-rolled

The Docker backend talks to the daemon over a client built from scratch on
`node:http`'s `socketPath` option — not `dockerode`, not any general-purpose
Docker SDK. This isn't a style preference: sharing an HTTP stack a consuming
project also depends on has, on another runtime, been observed to misroute a
Docker client onto TCP `localhost:2375` instead of the daemon's real unix
socket, entirely because of an unrelated dependency bump elsewhere in that
project's tree. Owning this client end-to-end — it can only ever dial a unix
socket path — makes that class of misrouting structurally impossible here,
regardless of what else is in your `node_modules`.

**Windows note:** because the client is unix-socket-only by design, the
Docker fallback on Windows needs a daemon reachable over a unix socket — not
Docker Desktop's default named pipe (`//./pipe/docker_engine`). Docker
Desktop's WSL2 backend exposes a unix socket inside its Linux VM
(`/var/run/docker.sock`); point `DOCKER_HOST` at a path reachable from the
Node process (for example, running inside the WSL2 distro itself, or any
other unix-socket-exposing Docker setup). This is a Windows precondition on
the Docker backend specifically, unrelated to microsandbox/WHP.

## Backend differences

The two backends are contract-equivalent — the same shared test suite passes
against both — but a handful of edges are genuinely backend-specific rather
than incidental timing quirks:

- **Read-only mounts aren't enforced in-guest on microsandbox 0.6.3.**
  `withCopyFileToContainer`'s read-only flag is honored by the Docker
  backend — the bind mount is genuinely read-only inside the container. On
  microsandbox, the guest currently gets a writable mount regardless. Don't
  rely on guest-side write protection under `RIGHTSIZE_BACKEND=microsandbox`.
- **`followOutput`'s tail-flush on microsandbox is a watchdog, not a stream
  close.** `msb logs -f` doesn't exit when its sandbox stops, so the
  microsandbox backend polls in the background and replays only the
  not-yet-delivered tail once the sandbox is confirmed stopped. Callers see
  the same ordered, no-duplicate output on either backend, but a subscriber
  on microsandbox can see its last line arrive slightly *after* the sandbox
  reports stopped, rather than exactly at stream EOF the way a Docker log
  stream closes.
- **Network-alias tunnels on microsandbox serve one connection at a time.**
  See [Networking](/guide/networking#limits-on-the-microsandbox-backend) —
  this is a real capability gap versus Docker's native bridge networking, not
  a timing quirk, and it means sustained bidirectional sibling traffic (a
  cross-container consumer reading continuously from a broker on a sibling
  microVM) isn't something the microsandbox backend supports.
