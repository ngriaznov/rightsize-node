# Keycloak

A single-node Keycloak container started with `start-dev` — an in-memory,
dev-mode boot with no external database wiring needed for tests.

**Default image:** `quay.io/keycloak/keycloak:26.0`
**Exposed ports:** `8080` (HTTP/app), `9000` (management interface — health
lives here, not on 8080)
**Wait strategy:** `Wait.forHttp("/health/ready").forPort(9000)`, 120s
startup timeout
**Memory:** `withMemoryLimit(1024)` by default

| Member | Returns |
|---|---|
| `KeycloakContainer.start(image?)` | `Promise<KeycloakContainer>` — boots the container |
| `.withAdminUsername(name)` | `this` — overrides the bootstrap admin username (default `admin`) |
| `.withAdminPassword(pw)` | `this` — overrides the bootstrap admin password (default `admin`) |
| `.adminUsername` / `.adminPassword` | The configured credentials |
| `.authServerUrl` | The auth server's base URL (app HTTP port, 8080) |

## Example

```ts
import { KeycloakContainer } from "rightsize/modules";

await using keycloak = await KeycloakContainer.start();
const discovery = (await (
  await fetch(`${keycloak.authServerUrl}/realms/master/.well-known/openid-configuration`)
).json()) as { issuer: string };
console.log(discovery.issuer);
```

## Backend notes

Two pins here are version-sensitive and were verified against this module's
pinned tag specifically:

- **26.x renamed the bootstrap-admin environment variables** to
  `KC_BOOTSTRAP_ADMIN_USERNAME`/`KC_BOOTSTRAP_ADMIN_PASSWORD` — older
  releases used `KEYCLOAK_ADMIN`/`KEYCLOAK_ADMIN_PASSWORD`, which this image
  no longer recognizes. This module already uses the current names; nothing
  for you to configure.
- **Health lives on the management port (9000), not the app port (8080).**
  26.x splits HTTP from a separate management interface that serves
  `/health/ready`, and `KC_HEALTH_ENABLED=true` (set by this module) is
  required for that endpoint to exist at all.

A four-JVM-adjacent Quarkus boot (Keycloak on Quarkus, with an embedded H2
database) fits comfortably in the 1024MB memory floor this module sets by
default — measured around 55% utilization at rest.
