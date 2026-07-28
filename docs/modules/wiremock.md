# WireMock

A single-node WireMock container — the closest thing the TypeScript ecosystem
has to WireMock's usual in-process embedding on the JVM: a real WireMock
server, isolated per test run, reachable over HTTP.

**Default image:** `wiremock/wiremock:latest`
**Exposed port:** `8080`
**Wait strategy:** `Wait.forHttp("/__admin/health").forPort(8080)`

| Member | Returns |
|---|---|
| `WireMockContainer.start(image?)` | `Promise<WireMockContainer>` — boots the container |
| `.baseUrl` | The stubbed API's base URL |
| `.adminUrl` | The admin API's base URL (`/__admin/...`) |

## Example

```ts
import { WireMockContainer } from "rightsize/modules";

await using wiremock = await WireMockContainer.start();

await fetch(`${wiremock.adminUrl}/mappings`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    request: { method: "GET", url: "/hello" },
    response: { status: 200, jsonBody: { message: "hi" } },
  }),
});

console.log(await (await fetch(`${wiremock.baseUrl}/hello`)).json()); // { message: "hi" }
```

## Backend notes

- **No-arg construction floats to `wiremock/wiremock:latest`.** Verified
  against `wiremock/wiremock:3.13.2`.
- **Compatibility check:** the constructor only accepts images whose
  repository is `wiremock/wiremock` (registry host, tag, and digest
  stripped). A different repository throws `IncompatibleImageError` before
  any backend call; override with
  `DockerImageName.parse(image).asCompatibleSubstituteFor("wiremock/wiremock")`
  for a verified compatible fork or mirror.
- Otherwise nothing backend-specific — WireMock boots and serves cleanly on
  both backends; `/__admin/health` (shipped since 3.x) is preferred over
  polling `/__admin/mappings` for readiness, since it reads as "am I
  healthy" rather than "list of stubs so far."
