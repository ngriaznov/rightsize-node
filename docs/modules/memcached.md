# Memcached

A single-node Memcached container. Memcached never speaks first on connect
and never logs anything at startup, so neither a listening-port wait nor a
log-message wait can tell "up" from "still booting." This module ships a
bespoke `WaitStrategy` (`MemcachedRespondsStrategy`) that sends a `version`
command over the wire and requires a real `VERSION` reply before declaring
readiness.

**Default image:** `memcached:1.6-alpine`
**Exposed port:** `11211`

| Member | Returns |
|---|---|
| `MemcachedContainer.start(image?)` | `Promise<MemcachedContainer>` — boots the container |
| `.address` | The `host:port` address of the running container |

## Example

```ts
import { MemcachedContainer } from "rightsize/modules";
import * as net from "node:net";

await using cache = await MemcachedContainer.start();
const [host, port] = cache.address.split(":");

// A minimal raw-protocol round-trip (any memcached client works the same way):
const socket = net.connect(Number(port), host);
await new Promise<void>((resolve) => socket.once("connect", resolve));
socket.write("version\r\n");
const reply = await new Promise<string>((resolve) => socket.once("data", (d) => resolve(d.toString())));
console.log(reply.startsWith("VERSION")); // true
socket.end();
```

## Backend notes

None specific to this module — the protocol-level wait strategy exists
precisely so this container is trustworthy readiness-wise on either backend,
sidestepping the userland-proxy-accepts-early behavior both backends share
for a bare port wait (see [Wait strategies](/guide/wait-strategies)).
