# Spring Cloud Config

A Spring Cloud Config Server container, ready-checked via its actuator
health endpoint.

**Default image:** `hyness/spring-cloud-config-server:latest`
**Exposed port:** `8888`
**Wait strategy:** `Wait.forHttp("/actuator/health").forPort(8888)`
**Memory:** `withMemoryLimit(1024)` by default

| Member | Returns |
|---|---|
| `SpringCloudConfigContainer.start(image?)` | `Promise<SpringCloudConfigContainer>` — boots the container |
| `.uri` | The config server's base URL |

## Example

```ts
import { SpringCloudConfigContainer } from "rightsize/modules";

await using config = await SpringCloudConfigContainer.start();
console.log(await (await fetch(`${config.uri}/actuator/health`)).json());
```

## Backend notes

**The 1024MB memory floor is required on microsandbox, not optional.**
Paketo's memory calculator sizes this JVM image's fixed regions (measured
around 705MB) above microsandbox's default microVM RAM (~450MB) — without
`withMemoryLimit(1024)`, the container never becomes ready on microsandbox
(times out around 180s); with it, boot completes in roughly 19s. This is set
by the module by default; you don't need to configure it, and it's harmless
on Docker.
