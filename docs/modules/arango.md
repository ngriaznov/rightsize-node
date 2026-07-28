# ArangoDB

A single-node ArangoDB container. Auth is disabled by default (`ARANGO_NO_AUTH=1`);
call `withRootPassword` before `start()` to enable auth instead.

**Default image:** `arangodb:latest`
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

- **No-arg construction floats to `arangodb:latest`.** Verified against
  `arangodb:3.11`.
- **Compatibility check:** the constructor only accepts images whose
  repository is `arangodb` (registry host, tag, and digest stripped). A
  different repository throws `IncompatibleImageError` before any backend
  call; override with
  `DockerImageName.parse(image).asCompatibleSubstituteFor("arangodb")` for a
  verified compatible fork or mirror.
- Otherwise nothing backend-specific — ArangoDB boots and serves cleanly on
  both backends.
