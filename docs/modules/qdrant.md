# Qdrant

A single-node Qdrant container — a vector search engine.

**Default image:** `qdrant/qdrant:latest`
**Exposed ports:** `6333` (REST, what the helpers here use), `6334` (gRPC)
**Wait strategy:** `Wait.forHttp("/readyz").forPort(6333)`

| Member | Returns |
|---|---|
| `QdrantContainer.start(image?)` | `Promise<QdrantContainer>` — boots the container |
| `.restUrl` | The REST API's base URL |

## Example

```ts
import { QdrantContainer } from "rightsize/modules";

await using qdrant = await QdrantContainer.start();

await fetch(`${qdrant.restUrl}/collections/books`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ vectors: { size: 4, distance: "Dot" } }),
});

await fetch(`${qdrant.restUrl}/collections/books/points?wait=true`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ points: [{ id: 1, vector: [0.3, 0, 0, 0], payload: { title: "The Hobbit" } }] }),
});

const search = await fetch(`${qdrant.restUrl}/collections/books/points/search`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ vector: [1, 0, 0, 0], limit: 1 }),
});
console.log(await search.text()); // point id 1, score 0.3
```

## Backend notes

- **No-arg construction floats to `qdrant/qdrant:latest`.** Verified against
  `qdrant/qdrant:v1.18.3` (arm64) — note the image's own tags carry a
  leading `v`, unlike most catalog images in this library.
- **No memory limit is set.** A full create-collection/upsert/search
  round-trip was verified with no `withMemoryLimit` override, in a guest
  reporting ~480 MB total.
- **Readiness is immediate.** `/readyz` answered `200` on the very first
  poll in the verified boot, so this module leaves the default startup
  timeout untouched.
- **Compatibility check:** the constructor only accepts images whose
  repository is `qdrant/qdrant` (registry host, tag, and digest stripped).
  A different repository throws `IncompatibleImageError` before any backend
  call; override with
  `DockerImageName.parse(image).asCompatibleSubstituteFor("qdrant/qdrant")`
  for a verified compatible fork or mirror.
