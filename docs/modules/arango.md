# ArangoDB

A single-node ArangoDB container. Auth is disabled by default (`ARANGO_NO_AUTH=1`);
call `withRootPassword` before `start()` to enable auth instead.

**Default image:** `arangodb:3.11`
**Exposed port:** `8529`
**Wait strategy:** `Wait.forHttp("/_api/version").forPort(8529).forStatusCode(200)`

| Member | Returns |
|---|---|
| `ArangoContainer.start(image?)` | `Promise<ArangoContainer>` — boots the container |
| `.withRootPassword(password)` | `this` — enables auth, replacing the no-auth default |
| `.endpoint` | The HTTP API base URL |

## Example

```ts
import { ArangoContainer } from "rightsize/modules";

await using arango = await ArangoContainer.start();
const res = await fetch(`${arango.endpoint}/_api/version`);
console.log(await res.json());
```

With auth enabled:

```ts
import { ArangoContainer } from "rightsize/modules";

await using arango = await new ArangoContainer().withRootPassword("s3cret").start();
```

## Backend notes

None — ArangoDB boots and serves cleanly on both backends.
