import * as fs from "node:fs";

/** The three platforms the pinned microsandbox release ships a build for. */
export type Platform = "darwin-arm64" | "linux-x64" | "linux-arm64";

const MSB_ASSETS: Record<Platform, string> = {
  "darwin-arm64": "msb-darwin-aarch64",
  "linux-x64": "msb-linux-x86_64",
  "linux-arm64": "msb-linux-aarch64",
};

const KRUN_ASSETS: Record<Platform, string> = {
  "darwin-arm64": "libkrunfw-darwin-aarch64.dylib",
  "linux-x64": "libkrunfw-linux-x86_64.so",
  "linux-arm64": "libkrunfw-linux-aarch64.so",
};

function currentPlatform(processPlatform: string, processArch: string): Platform | undefined {
  if (processPlatform === "darwin" && processArch === "arm64") {
    return "darwin-arm64";
  }
  if (processPlatform === "linux" && processArch === "x64") {
    return "linux-x64";
  }
  if (processPlatform === "linux" && processArch === "arm64") {
    return "linux-arm64";
  }
  return undefined;
}

/**
 * Linux needs `/dev/kvm` open for read+write; Apple Silicon's virtualization
 * is available whenever the platform itself resolves (Virtualization.framework
 * needs no device-file probe). Both branches use the synchronous `fs` calls —
 * never `fs.access` — because `BackendProvider.isSupported()` (the caller,
 * `MsbBackendProvider`) is a synchronous interface method: an async probe
 * here would make `isSupported()` return a Promise, which the pure resolver
 * in `Backends.resolve` would read as truthy ("supported") without ever
 * awaiting it.
 */
function virtualizationAvailable(processPlatform: string): boolean {
  if (processPlatform === "darwin") {
    return currentPlatform(process.platform, process.arch) !== undefined;
  }
  if (processPlatform === "linux") {
    try {
      fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Platform detection and per-platform msb/krun asset naming, backing `MsbBackendProvider.isSupported`. */
export const PlatformInfo = {
  /** This process's msb platform, or `undefined` if msb ships no build for it. */
  current(): Platform | undefined {
    return currentPlatform(process.platform, process.arch);
  },
  /** The `msb` release asset filename for this platform. */
  msbAsset(p: Platform): string {
    return MSB_ASSETS[p];
  },
  /** The libkrunfw release asset filename for this platform. */
  krunAsset(p: Platform): string {
    return KRUN_ASSETS[p];
  },
  /** Whether this machine can actually run msb's microVMs right now (KVM access on Linux; always true once the platform itself resolves on macOS). */
  virtualizationAvailable(): boolean {
    return virtualizationAvailable(process.platform);
  },
  /** Test seam: exercises the pure decision tables against injected platform/arch strings. */
  _currentFor(processPlatform: string, processArch: string): Platform | undefined {
    return currentPlatform(processPlatform, processArch);
  },
};
