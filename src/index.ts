/**
 * `rightsize` — the core entry point.
 *
 * Owns the public API surface every consumer builds on: `GenericContainer`
 * (the builder + async-dispose lifecycle guard), `Network`, the `Wait`
 * strategies, `FreePorts`, `RunId`, the `SandboxBackend`/`BackendProvider`
 * contracts plus the `registerBackend` registry, and the typed error
 * classes. This module depends on no backend — import `rightsize/backend-msb`
 * and/or `rightsize/backend-docker` to register one, or `rightsize/modules`
 * for the eighteen preconfigured containers built on top of this surface.
 *
 * @packageDocumentation
 */
export {
  UnsupportedByBackendError,
  PortBindConflictError,
  ContainerLaunchError,
  BackendError,
  ProvisionError,
  ReuseWithNetworkError,
  IsolationRequiredError,
  CheckpointUnsupportedError,
} from "./core/errors.js";
export type { PortBinding, FileMount, ExecResult, ContainerSpec, Checkpoint } from "./core/model.js";
export type {
  NetworkLink,
  SandboxHandle,
  FollowHandle,
  SandboxBackend,
  BackendProvider,
  ReaperKillCommand,
  BackendCapabilities,
} from "./core/backend.js";
export { registerBackend, Backends } from "./core/backends.js";
export { FreePorts } from "./core/free-ports.js";
export { Wait, HttpWaitStrategy } from "./core/wait.js";
export type { WaitTarget, WaitStrategy } from "./core/wait.js";
export { RunId } from "./core/run-id.js";
export { Network } from "./core/network.js";
export type { NetworkMember } from "./core/network.js";
export { MountableFile } from "./core/mountable-file.js";
export { GenericContainer } from "./core/generic-container.js";
export { diagnostics, registerDiagnostics } from "./core/diagnostics.js";
export type { FailureHook } from "./core/diagnostics.js";
