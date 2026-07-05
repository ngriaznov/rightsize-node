/**
 * `rightsize/backend-docker` — the Docker daemon backend.
 *
 * Importing this module registers `DockerBackendProvider` with the core
 * registry as a side effect (`priority: 10` — used when msb isn't supported,
 * or when `RIGHTSIZE_BACKEND=docker` is set). Talks to the daemon over a
 * hand-rolled unix-socket HTTP client (`node:http` with `socketPath`) rather
 * than a general-purpose Docker SDK, so this backend can only ever dial the
 * daemon's real unix socket — never a TCP host a dependency bump elsewhere
 * could misroute it onto.
 *
 * @packageDocumentation
 */
import { registerBackend } from "../core/backends.js";
import { DockerBackendProvider } from "./provider.js";

registerBackend(new DockerBackendProvider());

export { DockerBackend } from "./backend.js";
export { DockerBackendProvider } from "./provider.js";
export { DockerClient, socketPathFromDockerHost } from "./client.js";
export type { DockerResponse, DockerStreamResponse } from "./client.js";
