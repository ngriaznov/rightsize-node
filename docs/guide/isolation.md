# Isolation

The two backends give genuinely different isolation guarantees, not just
different implementations of the same one. Most tests never need to care
which — but a test that runs code you don't fully trust (a plugin, a
user-submitted script, a dependency you haven't audited) does.

## The guarantee, per backend

| | microsandbox | docker |
|---|---|---|
| Execution model | each sandbox is its own microVM, with its own kernel | containers share the host kernel |
| `capabilities.hardwareIsolated` | `true` | `false` |
| `capabilities.checkpoint` | `true` (filesystem-level, via disk snapshot) | `true` (filesystem-level, via commit-to-image) |
| `capabilities.checkpointRestartsWorkload` | `true` (the stop/snapshot/reboot cycle boots a fresh microVM) | `false` (commit-to-image never touches the running container) |
| A kernel-level exploit inside the workload | contained to that microVM | reaches every other container on the host, and the host itself |

`capabilities` is a small object on every `SandboxBackend`, exposed for
exactly this kind of API-level decision — see
[Backends](/guide/backends) for the rest of the SPI.

```ts
import "rightsize/backend-msb";
import { Backends } from "rightsize";

const caps = Backends.active().capabilities;
console.log(caps.hardwareIsolated, caps.checkpoint);
```

## Requiring it

`.withRequireIsolation()` turns "the docker fallback would silently work
here, just with a weaker guarantee" into a fail-fast error instead — for
tests where that silent degradation is the wrong default:

```ts
import { GenericContainer, IsolationRequiredError } from "rightsize";

async function runUntrustedScript(): Promise<void> {
  try {
    await using sandbox = await new GenericContainer("python:3.12-alpine")
      .withRequireIsolation()
      .withCommand("sleep", "60")
      .start();
    // ...exec the untrusted script inside `sandbox`...
  } catch (err) {
    if (err instanceof IsolationRequiredError) {
      // The active backend (named on err.backend) can't provide
      // hardware-virtualized isolation — for example, docker on a
      // machine with no microsandbox support at all.
    }
    throw err;
  }
}
```

The check runs at the very top of `start()`, before any network setup, port
allocation, or backend `create()` call — a rejected request never boots
anything, on either backend. `IsolationRequiredError.message` names the
active backend and the fix:

```
withRequireIsolation() demands hardware-virtualized isolation, but the
active backend ('docker') does not provide it — set
RIGHTSIZE_BACKEND=microsandbox to use the microsandbox backend, or drop
withRequireIsolation() to accept the docker fallback's shared-kernel
isolation.
```

## When to require it

Reach for `.withRequireIsolation()` when the workload inside the container
is untrusted in a way ordinary container isolation doesn't cover — running
arbitrary user-submitted code, a plugin/extension sandbox, evaluating a
dependency you haven't audited. For everything else (the databases and
brokers every module in this library wraps), the default — whichever
backend `RIGHTSIZE_BACKEND` resolves to, isolated or not — is the right
choice; forcing microsandbox everywhere would just make the docker fallback
unusable for ordinary test suites.

## Guidance for untrusted code

`hardwareIsolated: true` buys you a real kernel boundary, but it isn't a
substitute for basic hygiene inside the sandbox itself:

- **Set a memory limit.** `withMemoryLimit(megabytes)` caps what the
  workload can consume — untrusted code has no reason to be trusted with an
  unbounded ceiling either. See [Configuration](/guide/configuration).
- **Never put secrets in `withEnv`.** Environment variables are visible to
  anything running inside the container, including the code you don't
  trust. Pass secrets in only if the workload specifically needs them, and
  treat anything you do pass as compromised once untrusted code runs
  alongside it.
- **Pair isolation with a tight `waitingFor`/timeout budget.** A
  microVM contains a *kernel* exploit; it doesn't stop untrusted code from
  spinning forever or trying to exhaust its own resource ceiling — bound how
  long you're willing to wait.
- **Prefer `.withRequireIsolation()` over trusting the auto-selected
  backend.** Auto-selection exists for convenience on ordinary test
  workloads; for untrusted code, an explicit fail-fast beats a machine that
  happens to fall back to docker silently running something you meant to
  keep hardware-isolated.
