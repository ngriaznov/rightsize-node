# rightsize

**Testcontainers-style integration testing on microVMs. No Docker required.**

rightsize runs your integration-test containers as hardware-isolated
[microsandbox](https://github.com/superradcompany/microsandbox) microVMs — one
microVM per container — behind a strict-mode ESM TypeScript API whose flagship
lifecycle is TC39 explicit resource management. The runtime self-provisions on
first use (no install step), and a hand-rolled Docker backend covers the
platforms microVMs can't reach.

```ts
import { RedisContainer } from "rightsize/modules";
import { createClient } from "redis";

await using redis = await RedisContainer.start(); // boots a real microVM
const client = createClient({ url: redis.uri }); // redis://127.0.0.1:<mapped port>
await client.connect();
// ... your test ...
```

`await using` is the whole story: `redis` is disposed automatically at the end
of its scope, ordered and awaited, the same way a `try`/`finally` would — no
framework required. See the [quickstart](/guide/quickstart) for a runnable
version and [Lifecycle](/guide/lifecycle) for how disposal actually works.

## Where to go next

- **New to rightsize?** Start with the [Quickstart](/guide/quickstart) — install,
  your first `await using` container, and what happens on first run.
- **Want to run something right now?** See the runnable examples under
  [`examples/`](https://github.com/ngriaznov/rightsize-node/tree/main/examples)
  (`npm run example:redis`, `npm run example:network`, `npm run example:test`)
  — the [README's Examples section](https://github.com/ngriaznov/rightsize-node#examples)
  has the full list and exact commands.
- **Need a specific container?** Jump to [Modules](/modules/) for the full
  catalog of eighteen preconfigured containers.
- **Choosing a backend, or hitting a backend-specific limit?** See
  [Backends](/guide/backends) and [Networking](/guide/networking).

## Status

On npm as [`rightsize`](https://www.npmjs.com/package/rightsize):

```sh
npm install --save-dev rightsize
```

## License

[Apache-2.0](https://github.com/ngriaznov/rightsize-node/blob/main/LICENSE)
