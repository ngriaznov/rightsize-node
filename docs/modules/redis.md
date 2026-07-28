# Redis

A single-node Redis container, ready-checked on Redis's own
`Ready to accept connections` log line rather than a listening-port probe: on a
loaded host the port forwarder can accept and hold a connection in the window
between Redis binding its socket and actually serving, which a bare port check
cannot see through.

**Default image:** `redis:latest`
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

- **No-arg construction floats to `redis:latest`.** Verified against
  `redis:8.6-alpine` — `latest` is Debian-based rather than Alpine, larger to
  pull but functionally equivalent.
- **Compatibility check:** the constructor only accepts images whose
  repository is `redis` (registry host, tag, and digest stripped). A
  different repository throws `IncompatibleImageError` before any backend
  call; override with `DockerImageName.parse(image).asCompatibleSubstituteFor("redis")`
  for a verified compatible fork or mirror.
- Redis boots and serves cleanly on both backends with no special handling
  required beyond the above.
