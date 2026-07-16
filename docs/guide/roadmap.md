# Roadmap

Ideas under consideration for future releases, roughly ordered by expected impact.
Items graduate off this page when they ship; the CHANGELOG records what landed.

## Native microVM memory snapshots

Filesystem-level checkpoint/restore now ships on BOTH backends — docker via
image commit, microsandbox via disk snapshot (see
[Checkpoint / restore](/guide/checkpoints)). What remains is true microVM
**memory** snapshots on microsandbox: a restored sandbox that resumes
mid-execution rather than rebooting — near-instant restore, no workload
restart — still gated on upstream microsandbox support this library doesn't
control the timeline for.

## Portable checkpoint archives

Named checkpoints ship (see [Checkpoint / restore](/guide/checkpoints)), but
they're only rediscoverable on the same machine, since the registry and the
underlying artifact both live locally. Export/import (`msb snapshot
export`/`docker save` and their inverses) would let a checkpoint travel
between machines and CI caches — build the fixture once, ship the archive,
restore it anywhere.

## Module breadth

The gaps Testcontainers users will hit first: LocalStack, Elasticsearch /
OpenSearch, Vault, MinIO, NATS, Cassandra, MSSQL, Oracle Free, and Ollama
(LLM-in-a-box testing, which also fits the isolation story).

## Framework integrations

One-annotation setup in the frameworks people actually use: Spring Boot
`@ServiceConnection`-style wiring, Quarkus Dev Services, a pytest-style
fixture story, Vitest/Jest global-setup helpers, Axum/sqlx examples.

## Building images from code

Define an ad-hoc image inline in the test (Dockerfile-from-code) instead of
publishing one — for testing your own service, not just its dependencies.

## Host-directory mounts

Runtime file/directory copy in both directions has shipped — see
[Copying files](/guide/copy). What remains is a start-time host-directory
BIND alongside the existing single-file `withCopyFileToContainer`, for
mounting a whole host directory tree into the guest before boot.

## Declarative multi-service groups

A rightsize-native way to declare "these five services, this network, this
startup order" as one artifact, serving the docker-compose need without the
compose file format.

## Warm pools

A background pool of pre-booted sandboxes so `start()` is near-instant —
paired with reuse, this attacks time-to-first-test directly.

## Fault injection

The backend controls the virtual NIC: latency, packet loss, partitions
between sandboxes, kill-and-revive — first-class API instead of a separate
Toxiproxy container.

## Time control

A VM owns its clock: advance time inside the guest to test TTLs, certificate
expiry, and cron logic faithfully — awkward to impossible on a shared
kernel.

## Private registry authentication

Pulling from authenticated registries, documented and tested — table stakes
for enterprise evaluation.
