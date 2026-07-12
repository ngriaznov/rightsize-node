# Failure diagnostics

When a test fails, the useful evidence is usually sitting in a container
that's about to be torn down: what image was it, what ports did it map, what
did it log right before things went wrong. `diagnostics()` assembles that
into one human-readable report instead of leaving you to reconstruct it by
hand from scattered `logs()` calls after the fact.

```ts
import { diagnostics } from "rightsize";

const report = await diagnostics();
console.error(report);
```

## What it reports

Every container this process currently has running — in the order each one
started — with its image, mapped ports, and a bounded tail of its logs:

```
== rightsize diagnostics: 2 running container(s) ==
-- rz-a1b2c3d4-1 (redis:8.6-alpine) --
state: running   host: 127.0.0.1   ports: 6379->54213
last 50 log lines:
  1:M 11 Jul 2026 10:00:00.000 * Ready to accept connections tcp
-- rz-a1b2c3d4-2 (postgres:16-alpine) --
state: running   host: 127.0.0.1   ports: 5432->54214
last 50 log lines:
  database system is ready to accept connections
```

Every entry is, by construction, currently running — `start()` adds a
container to the registry the instant it boots, `stop()` removes it the
instant it tears down — so `state:` is always `running`. `host` is always
`127.0.0.1`, the same loopback-only invariant every mapped port has (see
[Backends](/guide/backends)).

If a container's `logs()` call itself fails (the daemon is gone, the
sandbox already died), that one entry degrades to a one-line note instead of
throwing and hiding every other container's report:

```
-- rz-a1b2c3d4-3 (rabbitmq:4-alpine) --
state: running   host: 127.0.0.1   ports: 5672->54215
logs: unavailable (connect ECONNREFUSED)
```

With nothing running, `diagnostics()` returns a single line:

```
== rightsize diagnostics: no running containers ==
```

The format is identical across rightsize's Kotlin, Rust, and TypeScript
implementations — a polyglot team debugging the same CI failure across
languages reads the same report shape either way.

A [reuse](/guide/reuse)-active container (`.withReuse()` plus
`RIGHTSIZE_REUSE`) is never in the registry `diagnostics()` reads from —
it's meant to outlive this process, and isn't torn down by it either.

## Wiring it into test failures

`diagnostics()` is framework-neutral: call it wherever a failure handler
runs. Two shapes cover most setups.

**Manual, in any framework** — call it from a `catch` around the
assertions you care about:

```ts
import { GenericContainer, diagnostics } from "rightsize";

async function example(): Promise<void> {
  await using redis = await new GenericContainer("redis:8.6-alpine").withExposedPorts(6379).start();
  try {
    // ...assertions against redis...
  } catch (err) {
    console.error(await diagnostics());
    throw err;
  }
}
```

**vitest's `onTestFailed`** — `registerDiagnostics` is a dependency-free
helper matching the shape of vitest's own failure hook: pass it the real
`onTestFailed`, once, and every failing test in that file prints the report
to stderr automatically.

```ts
import { registerDiagnostics, type FailureHook } from "rightsize";

// Stand-in so this sample typechecks without a vitest dependency — in a
// real vitest suite, pass the real export instead:
//   import { onTestFailed } from "vitest";
//   registerDiagnostics(onTestFailed);
const onTestFailed: FailureHook = (callback) => {
  void callback;
};

registerDiagnostics(onTestFailed);
```

`registerDiagnostics` takes an optional second argument if you want the
report routed somewhere other than `process.stderr.write` — a test
reporter's own attachment API, for instance:

```ts
import { registerDiagnostics, type FailureHook } from "rightsize";

const onTestFailed: FailureHook = (callback) => {
  void callback;
};

registerDiagnostics(onTestFailed, (report) => {
  process.stderr.write(report);
});
```

`node:test` has no equivalent single failure hook to wire once per file —
use the manual `catch` shape above, or call `diagnostics()` from the
test's own `t.after()` when a prior assertion in the same test left a flag
set.
