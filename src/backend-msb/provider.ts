import type { BackendProvider, SandboxBackend } from "../core/backend.js";
import { PlatformInfo } from "./platform.js";
import { ensureInstalled } from "./provisioner.js";
import { MsbCliBackend } from "./backend.js";

export class MsbBackendProvider implements BackendProvider {
  /** `"microsandbox"` — matched case-insensitively against `RIGHTSIZE_BACKEND`. */
  readonly name = "microsandbox";
  readonly priority = 20;

  isSupported(): boolean {
    // Both sides of this && are synchronous (platform.ts never uses async
    // fs.access) — this method must never return a Promise, or the pure
    // resolver in Backends.resolve would read a truthy Promise as "supported"
    // without ever awaiting it.
    return PlatformInfo.current() !== undefined && PlatformInfo.virtualizationAvailable();
  }

  unsupportedReason(): string {
    if (PlatformInfo.current() === undefined) {
      return `no msb build for ${process.platform}/${process.arch} (Intel Mac: use the docker backend)`;
    }
    if (process.platform === "win32") {
      return (
        "Windows Hypervisor Platform is not enabled (run 'msb doctor --fix' in an elevated " +
        "terminal, which may require a reboot), or use the docker backend"
      );
    }
    return "/dev/kvm is not accessible (need KVM, or run on Apple Silicon macOS)";
  }

  create(): SandboxBackend {
    // create() is a synchronous ServiceLoader-style factory, but
    // locating/installing msb is inherently async. The backend holds the
    // provisioning promise and awaits it lazily on first use. The
    // liveness-blind per-backend sweep that used to run here has been
    // replaced by the ledger-based sweep in `core/reaper`, triggered once
    // per process from `Backends.active()`'s resolution gate — see
    // `core/reaper/init.ts`.
    return new MsbCliBackend(ensureInstalled());
  }
}
