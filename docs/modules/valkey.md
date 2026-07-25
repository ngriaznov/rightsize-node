# Valkey

A single-node Valkey container — the Redis-protocol-compatible fork,
following [Redis](/modules/redis)'s builder shape exactly.

**Default image:** `valkey/valkey:9.1-alpine`
**Exposed port:** `6379`
**Wait strategy:** `Wait.forLogMessage(".*Ready to accept connections.*", 1)`

| Member | Returns |
|---|---|
| `ValkeyContainer.start(image?)` | `Promise<ValkeyContainer>` — boots the container |
| `.uri` | A `redis://host:port` connection URI |

## Example

```ts
import { ValkeyContainer } from "rightsize/modules";
import { createClient } from "redis";

await using valkey = await ValkeyContainer.start();
const client = createClient({ url: valkey.uri });
await client.connect();
await client.set("k", "v");
console.log(await client.get("k")); // "v"
await client.quit();
```

## Backend notes

- **`.uri` uses `redis://`, not `valkey://`.** Every client this library's
  tests and its users reach for — lettuce, node-redis, or raw RESP over
  TCP — parses `redis://`, and Valkey speaks that same wire protocol. This
  is deliberate, not a copy-paste mistake carried over from the Redis
  module.
- **Readiness anchors on a log line, not a bare port probe**, for the same
  reason as Redis: on a loaded host, msb's loopback forwarder can accept and
  hold a TCP connection before the guest process is actually listening, so a
  bare listening-port wait risks returning before the server serves.
- No memory-limit override is needed; verified booting and answering `PING`
  with no limit set, well under 512 MB.
