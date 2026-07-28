# Elasticsearch

A single-node Elasticsearch container. Unlike every other module in this
library, there is **no no-arg constructor** — see below.

**Default image:** none — an explicit image is required, e.g. `elasticsearch:9.4.4`
**Exposed ports:** `9200` (REST, what the helpers here use), `9300` (transport)
**Wait strategy:** `Wait.forHttp("/").forPort(9200)`, 300s startup timeout
**Memory:** `withMemoryLimit(2560)`
**Env:** `discovery.type=single-node`, `xpack.security.enabled=false`,
`ES_JAVA_OPTS=-Xms512m -Xmx512m`

| Member | Returns |
|---|---|
| `new ElasticsearchContainer(image)` | Requires an explicit image — no default |
| `ElasticsearchContainer.start(image)` | `Promise<ElasticsearchContainer>` — boots the container; `image` is required |
| `.restUrl` | The REST API's base URL |

## Example

```ts
import { ElasticsearchContainer } from "rightsize/modules";

await using es = await ElasticsearchContainer.start("elasticsearch:9.4.4");

await fetch(`${es.restUrl}/books/_doc/1?refresh=true`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "The Hobbit", author: "Tolkien" }),
});

const search = await fetch(`${es.restUrl}/books/_search`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: { match: { title: "Hobbit" } } }),
});
console.log(await search.text()); // the indexed document, in the hits array
```

## Backend notes

- **No no-arg constructor — Elastic publishes no floating tag.** Every other
  module in this library floats to the image's own `latest` (or an
  equivalent) when no image is given. Elasticsearch has nothing to float to:
  `elasticsearch:latest`, `elasticsearch:9`, and `elasticsearch:8` are all
  404 on Docker Hub — Elastic publishes only full version tags. This module
  was verified against `elasticsearch:9.4.4` (arm64); both the constructor
  and `start()` require an explicit image and have no default parameter.
- **Cluster health never reaches `green` on a single node.** Elasticsearch's
  default replica count is one replica per index, and a single-node cluster
  has nowhere to assign a replica shard — `/_cluster/health` reports
  `yellow` indefinitely. A readiness check that waited for `green` would
  hang until its own timeout; this module waits on a plain HTTP `200` from
  `/` instead, verified reached in 27s on a quiet local machine. The 300s
  startup timeout absorbs a loaded CI runner without masking a real hang.
- **`xpack.security.enabled=false`** means the REST API answers plain HTTP
  with no TLS and no credentials — there is no username/password to
  configure or override here.
- **Memory:** `withMemoryLimit(2560)` — measured ~1.1 GB resident in a
  2.48 GB guest at rest.
- **Compatibility check:** the constructor only accepts images whose
  repository is `elasticsearch` (registry host, tag, and digest stripped).
  A different repository throws `IncompatibleImageError` before any backend
  call; override with
  `DockerImageName.parse(image).asCompatibleSubstituteFor("elasticsearch")`
  for a verified compatible fork or mirror.
