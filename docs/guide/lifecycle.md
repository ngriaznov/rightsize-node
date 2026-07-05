# Lifecycle: `await using`

`GenericContainer` (and every module built on it) is its own lifecycle guard.
Once `start()` resolves, the instance implements `Symbol.asyncDispose`, so a
`using` declaration disposes it automatically at scope exit:

```ts
import { RedisContainer } from "rightsize/modules";

async function example(): Promise<void> {
  await using redis = await RedisContainer.start();
  // redis.uri, redis.exec(...), redis.logs(), etc. are all live here
} // <- redis is stopped and removed here, even if the block above threw
```

This is the direct TypeScript analog of Kotlin's `AutoCloseable` and Rust's
RAII guard — ordered, awaited teardown with no `finally` block to remember.
Disposal never throws: a failure while stopping the container is swallowed,
the same way a `finally` block's own cleanup shouldn't mask the original
error.

## Multiple containers, LIFO order

Stack several `await using` declarations in one scope and they dispose in
reverse order, last-declared-first — the same ordering `using`/`try`-`finally`
nesting would give you, without writing the nesting:

```ts
import { GenericContainer, Network } from "rightsize";

await using network = Network.newNetwork();
await using db = await new GenericContainer("postgres:18-alpine")
  .withNetwork(network)
  .withNetworkAliases("db")
  .start();
await using app = await new GenericContainer("my-service:latest")
  .withNetwork(network)
  .start();
// disposed in order: app, db, network
```

## Explicit `start()`/`stop()`

`await using` requires a `using` declaration's scope to line up with the
container's lifetime — which doesn't fit every shape. Test-framework hooks
(Jest/Vitest `beforeAll`/`afterAll`, `node:test`'s `before`/`after`) run in
separate callback invocations that don't share a lexical scope with the test
bodies between them, so there's nowhere to put a `using` declaration that
spans "start once, use across many tests, stop at the end." For that shape,
call `start()`/`stop()` explicitly:

```ts
import { before, after, test } from "node:test";
import { RedisContainer } from "rightsize/modules";

let redis: RedisContainer;

before(async () => {
  redis = await RedisContainer.start();
});

after(async () => {
  await redis.stop();
});

test("cache roundtrip", async () => {
  // use redis.uri
});
```

`stop()` is idempotent and safe to call even if `start()` never completed —
the same method `[Symbol.asyncDispose]` calls internally.

## What happens if the process dies first

`await using`'s disposal and an explicit `stop()` are the primary teardown
path, but neither runs if the process exits before either has a chance to —
`process.exit()` called elsewhere, an uncaught rejection, `SIGKILL`. Two
backstops exist under that:

1. **A synchronous best-effort teardown on normal exit / `SIGINT`/`SIGTERM`.**
   Node's `"exit"` handler can't `await`, so each backend tears its live
   containers down with a blocking primitive instead (`child_process.spawnSync`
   for msb, a blocking unix-socket call for Docker).
2. **An orphan reaper at backend startup.** Each new process sweeps up
   containers left behind by a run that died via `SIGKILL` (which bypasses
   even the exit handler), identified by everything NOT carrying this
   process's own run id.

See [How It Works](/guide/how-it-works) for the full mechanics of both.
