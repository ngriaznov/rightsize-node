# Floci

A [floci.io](https://floci.io) cloud emulator — one native image per cloud
provider, each speaking that provider's REST APIs against an in-memory
backing store. One module covers all three provider variants; pick one via
a factory function.

**Default images:** `floci/floci:1.5.30` (AWS), `floci/floci-az:0.8.0`
(Azure), `floci/floci-gcp:0.4.0` (GCP)
**Exposed ports:** `4566` (AWS), `4577` (Azure), `4588` (GCP)
**Wait strategy:** `Wait.forHttp("/health").forPort(...)` — works uniformly
across all three variants

| Member | Returns |
|---|---|
| `FlociContainer.aws(image?)` | `FlociContainer` — the AWS emulator (S3, DynamoDB, SQS, etc.) |
| `FlociContainer.azure(image?)` | `FlociContainer` — the Azure emulator |
| `FlociContainer.gcp(image?)` | `FlociContainer` — the GCP emulator |
| `.start()` | `Promise<FlociContainer>` — boots the chosen variant |
| `.endpointUrl` | The base URL for every emulated API call |

There is no bare `new FlociContainer(...)` or generic `static start()` — one
of the three factory functions is the only entry point, since each pins its
own provider's image and port.

## Example

```ts
import { FlociContainer } from "rightsize/modules";

await using floci = await FlociContainer.aws().start();

// The AWS variant's S3-shaped REST endpoints accept unsigned requests.
await fetch(`${floci.endpointUrl}/my-bucket`, { method: "PUT" });
await fetch(`${floci.endpointUrl}/my-bucket/key`, { method: "PUT", body: "hello" });
console.log(await (await fetch(`${floci.endpointUrl}/my-bucket/key`)).text()); // "hello"
```

## Backend notes

**No signing needed for the AWS variant.** Its S3-shaped endpoints
(create-bucket, put-object, get-object) accept unsigned requests with no
`Authorization` header at all — no SigV4, no AWS SDK dependency required, as
shown above. All three images are small native binaries with no memory-limit
override needed on either backend.
