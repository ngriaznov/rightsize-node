# Redis

A single-node Redis container, ready-checked with a plain listening-port wait
— Redis speaks first on connect, so the bare read-probe wait is sufficient
here (contrast [Memcached](/modules/memcached), which needs a protocol-level
probe).

**Default image:** `redis:8.6-alpine`
**Exposed port:** `6379`

| Member | Returns |
|---|---|
| `RedisContainer.start(image?)` | `Promise<RedisContainer>` — boots the container |
| `.uri` | A `redis://host:port` connection URI |

## Example

```ts
import { RedisContainer } from "rightsize/modules";
import { createClient } from "redis";

await using redis = await RedisContainer.start();
const client = createClient({ url: redis.uri });
await client.connect();
await client.set("k", "v");
console.log(await client.get("k")); // "v"
await client.quit();
```

## Backend notes

None — Redis boots and serves cleanly on both backends with no special
handling required.
