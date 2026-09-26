# Roadmap

Ideas under consideration for future releases, roughly ordered by expected impact.
Items graduate off this page when they ship; the CHANGELOG records what landed.

## Real networks on microsandbox

On docker, a `Network` is a real bridge network: every member gets its own IP
address, and every other member can reach it on any port, over TCP and UDP. On
microsandbox the network is emulated link by link, as an `/etc/hosts` alias plus a
relay for each port a sibling declared, and that emulation has limits a real
network doesn't have:

- A TCP link carries one connection at a time.
- Links are computed once, when a member starts. A sibling that starts later, or
  restarts, never gets linked into members that are already running.
- A UDP datagram over 1472 bytes of payload breaks the receiving sandbox's inbound
  networking (an msb limitation on published ports).
- A member reaches a sibling only through its alias and declared ports. A gossip
  cluster, or any software whose peers dial the address each node advertises,
  can't run on it.

The plan is a small overlay network. rightsize would provision a static guest
agent, `rightsize-netd`, the way it provisions msb: a pinned release, checked
against its SHA-256, cached under the rightsize cache directory, built for musl on
the host's CPU architecture (msb guests always match it). The agent runs in front
of the workload in every member of a `Network`. It creates a TUN device carrying
the member's overlay address, which stays the same across restarts, keeps
`/etc/hosts` current as members join and leave, and tunnels IP packets over UDP to
a switch that the `Network` runs inside the test process. Each member reaches the
switch through its sandbox gateway, opened by one `--net-rule`. TCP and UDP then
run end to end between guests: any number of connections, closes that reach the
other side, and datagrams of any size, fragmented and reassembled by the guest
kernels.

msb already has what this needs. Guests run as root with `/dev/net/tun` present.
The gateway carries UDP to the host when a `--net-rule` allows it, and fragments
large datagrams on that path. `--mount-file` delivers the agent, and `--entrypoint`
runs it before the image's own entrypoint and command, which `msb image inspect`
reports. A restored sandbox gets the agent mounted again with `msb restore -v` and
revived through the same wrapper. Nothing needs tearing down inside a guest, and
the switch closes with its `Network`.

Open questions: throughput under bulk transfers, Windows path handling in
`--mount-file` and `-v`, and whether reused sandboxes can join an overlay.

## Native microVM memory snapshots

Filesystem-level checkpoint/restore now ships on BOTH backends — docker via
image commit, microsandbox via disk snapshot (see
[Checkpoint / restore](/guide/checkpoints)). What remains is true microVM
**memory** snapshots on microsandbox: a restored sandbox that resumes
mid-execution rather than rebooting — near-instant restore, no workload
restart — still gated on upstream microsandbox support this library doesn't
control the timeline for.

## Self-contained archives

Checkpoint export/import ships (see
[Moving checkpoints between machines](/guide/checkpoints#moving-checkpoints-between-machines)),
but the archive never bundles the OCI image, so a restored container still
needs to pull its base image on first boot. Bundling it via microsandbox's
own `--with-image` is possible upstream now; this library doesn't do it
yet. Doing so would make an archive fully offline-restorable, no
registry/network access required on the importing machine.

## Module breadth

The gaps Testcontainers users will hit first: LocalStack, OpenSearch, Vault,
NATS, MSSQL, Oracle Free, and Ollama (LLM-in-a-box testing, which also fits
the isolation story).

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
