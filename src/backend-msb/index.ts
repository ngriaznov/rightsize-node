/**
 * `rightsize/backend-msb` — the microsandbox (microVM) backend.
 *
 * Importing this module registers `MsbBackendProvider` with the core
 * registry as a side effect (`priority: 20`, preferred over docker wherever
 * both are supported). Runs every container as an attached `msb run` child
 * process, provisions the pinned `msb` toolchain from GitHub releases on
 * first use, and emulates container-to-container networking with
 * `/etc/hosts` aliases plus TCP relays over `msb exec --stream` — there is
 * no other guest data path on this platform.
 *
 * @packageDocumentation
 */
import { registerBackend } from "../core/backends.js";
import { MsbBackendProvider } from "./provider.js";

registerBackend(new MsbBackendProvider());

export { MsbCliBackend } from "./backend.js";
export { MsbBackendProvider } from "./provider.js";
export { PlatformInfo } from "./platform.js";
export type { Platform } from "./platform.js";
export { ensureInstalled, ensureInstalledAt, MSB_VERSION } from "./provisioner.js";

