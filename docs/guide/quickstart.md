# Quickstart

## Install

Not yet on npm — see the [README](https://github.com/ngriaznov/rightsize-node#status) for the git-dependency form. Once installed:

```ts
import { RedisContainer } from "rightsize/modules";
```

registers nothing on its own — `rightsize/modules` re-exports the container
classes, but a **backend** has to be registered before `start()` can resolve
one. Import whichever backend(s) you want available, once, anywhere before
your first `start()` call (a test setup file is the usual place):

```ts
import "rightsize/backend-msb";
import "rightsize/backend-docker";
```

Importing both is fine and typical — `rightsize` picks the best supported one
automatically (see [Backends](/guide/backends)) and `RIGHTSIZE_BACKEND` can
force a specific one.

## Your first container

```ts runnable
import "rightsize/backend-msb";
import "rightsize/backend-docker";
import { RedisContainer } from "rightsize/modules";

async function main(): Promise<void> {
  await using redis = await RedisContainer.start();
  console.log("redis is up at", redis.uri);
  // ... use redis.uri with any redis client ...
}

await main();
```

Run it under Node or Bun — same source, no flags:

```bash
node --experimental-strip-types quickstart.ts
# or
bun quickstart.ts
```

`await using` disposes `redis` — stopping and removing the container, freeing
its port — the instant `main()`'s scope ends, whether it returns normally or
throws. See [Lifecycle](/guide/lifecycle) for the full mechanics and the
`start()`/`stop()` alternative for test-framework hooks.

## Driving any image directly

Every module is a thin `GenericContainer` subclass. For an image with no
dedicated module, use `GenericContainer` itself:

```ts
import { GenericContainer, Wait } from "rightsize";

await using arango = await new GenericContainer("arangodb:3.11")
  .withEnv("ARANGO_NO_AUTH", "1")
  .withExposedPorts(8529)
  .waitingFor(Wait.forHttp("/_api/version").forPort(8529))
  .start();

const port = arango.getMappedPort(8529); // published on 127.0.0.1
```

## What happens on first run

The first `start()` call resolves a backend (see [Backends](/guide/backends)).
If microsandbox is selected and no `msb` binary is cached yet, it's downloaded
from GitHub releases, SHA-256-verified, and installed under
`~/.cache/rightsize/` — no daemon, no root, nothing to pre-install. Subsequent
runs reuse the cached toolchain.

## More runnable examples

Beyond the snippet above, [`examples/`](https://github.com/ngriaznov/rightsize-node/tree/main/examples)
in the repo has three complete, runnable programs: the same Redis
`await using` lifecycle as a standalone script (`npm run example:redis`), a
two-container `Network` with alias resolution (`npm run example:network`),
and a `node:test` suite built on a module container
(`npm run example:test`). See the
[README's Examples section](https://github.com/ngriaznov/rightsize-node#examples)
for the exact commands and the backend-switch pattern.
