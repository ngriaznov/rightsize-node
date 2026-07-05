# Apache Pinot

A single-container Apache Pinot QuickStart cluster — controller, broker,
server, and ZooKeeper, all four JVMs colocated in one image, started with
`QuickStart -type EMPTY` for a clean cluster with no demo tables.

**Default image:** `apachepinot/pinot:1.5.1`
**Exposed ports:** `9000` (controller REST), `8000` (broker query — **not**
8099)
**Wait strategy:** `Wait.forHttp("/health").forPort(9000)`, 180s startup
timeout
**Memory:** `withMemoryLimit(4096)` — a hard floor, non-negotiable on
microsandbox

| Member | Returns |
|---|---|
| `PinotContainer.start(image?)` | `Promise<PinotContainer>` — boots the container |
| `.controllerUrl` | The controller's REST base URL (schema/table admin, `/health`) |
| `.brokerUrl` | The broker's query base URL |

## Example

```ts
import { PinotContainer } from "rightsize/modules";

await using pinot = await PinotContainer.start();

const schema = { schemaName: "example", dimensionFieldSpecs: [{ name: "x", dataType: "INT" }] };
await fetch(`${pinot.controllerUrl}/schemas`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(schema),
});
console.log(await (await fetch(`${pinot.controllerUrl}/schemas/example`)).json());
console.log(await (await fetch(`${pinot.brokerUrl}/health`)).text());
```

## Backend notes

- **The broker's query port is 8000, not 8099.** The image exposes several
  internal ports in the 8096–8099 range plus 9000, but QuickStart's broker
  binds 8000 for client queries — 8099 is never opened by this entrypoint.
  This corrects an initially-reasonable guess that turned out wrong against
  the real image.
- **The 4096MB memory floor is measured, not a guess.** The image bakes
  `-Xmx4G` into its QuickStart launch scripts regardless of workload size.
  On microsandbox specifically: 2048/2560MB microVMs get OOM-killed outright;
  3072MB boots but runs at ~99% memory pressure with Helix RPC timeouts under
  any load; 4096MB is the first limit that boots *and* stays stable
  (~74% steady-state utilization). Do not lower this default.
- **180s startup timeout is generous on purpose** — a four-JVM cluster
  cold-booting in one microVM/container is legitimately slow, and the
  broker's own readiness lags the controller's slightly.
