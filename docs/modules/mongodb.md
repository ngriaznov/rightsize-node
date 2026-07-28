# MongoDB

A single-node MongoDB container running as a one-member replica set
(required for transactions and change streams). A post-start hook runs
`rs.initiate()` and polls for a writable primary before `start()` returns —
so `connectionString` is always usable immediately, with no manual
replica-set setup.

**Default image:** `mongo:latest`
**Exposed port:** `27017`
**Command:** `mongod --replSet docker-rs --bind_ip_all`

| Member | Returns |
|---|---|
| `MongoDBContainer.start(image?)` | `Promise<MongoDBContainer>` — boots the container, initiates the replica set, and waits for a primary |
| `.connectionString` | A `mongodb://host:port/test?directConnection=true` connection string |
| `.replicaSetUrl` | Alias for `.connectionString` — the container is always a (single-node) replica set |

## Example

```ts
import { MongoDBContainer } from "rightsize/modules";
import { MongoClient } from "mongodb";

await using mongo = await MongoDBContainer.start();
const client = new MongoClient(mongo.connectionString);
await client.connect();
const db = client.db("test");
await db.collection("docs").insertOne({ k: "v" });
console.log(await db.collection("docs").findOne({ k: "v" }));
await client.close();
```

## Backend notes

- **No-arg construction floats to `mongo:latest`.** Verified against
  `mongo:8.0`.
- **Compatibility check:** the constructor only accepts images whose
  repository is `mongo` (registry host, tag, and digest stripped). A
  different repository throws `IncompatibleImageError` before any backend
  call; override with `DockerImageName.parse(image).asCompatibleSubstituteFor("mongo")`
  for a verified compatible fork or mirror.
- The replica-set initiation races the same early-accept behavior every
  `Wait.forListeningPort()` container has to account for (see
  [Wait strategies](/guide/wait-strategies)) — the first `rs.initiate()`
  attempt can hit the container before `mongod` is genuinely ready to serve
  it. This module's post-start hook retries both `rs.initiate()` and the
  writable-primary check in a bounded loop for exactly this reason; no action
  needed on your part.
