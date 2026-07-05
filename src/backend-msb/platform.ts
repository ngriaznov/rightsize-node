import * as fs from "node:fs";

/** The five platforms the pinned microsandbox release ships a build for. */
export type Platform = "darwin-arm64" | "linux-x64" | "linux-arm64" | "win32-x64" | "win32-arm64";

const MSB_ASSETS: Record<Platform, string> = {
  "darwin-arm64": "msb-darwin-aarch64",
  "linux-x64": "msb-linux-x86_64",
  "linux-arm64": "msb-linux-aarch64",
  "win32-x64": "msb-windows-x86_64.exe",
  "win32-arm64": "msb-windows-aarch64.exe",
};

const KRUN_ASSETS: Record<Platform, string> = {
  "darwin-arm64": "libkrunfw-darwin-aarch64.dylib",
  "linux-x64": "libkrunfw-linux-x86_64.so",
  "linux-arm64": "libkrunfw-linux-aarch64.so",
  "win32-x64": "libkrunfw-windows-x86_64.dll",
  "win32-arm64": "libkrunfw-windows-aarch64.dll",
};

// The exact filename msb resolves the library under: it probes `../lib/` next to its
// own binary for `libkrunfw.so.<version>` on Linux, `libkrunfw.<abi>.dylib` on macOS,
// and unversioned `libkrunfw.dll` on Windows (confirmed against install.ps1, the
// upstream Windows installer's own copy step: it moves the extracted bundle's
// `libkrunfw.dll` straight to `lib\libkrunfw.dll`, no version suffix) — never the
// release-asset name — so the provisioner installs the downloaded asset under this
// name. The embedded libkrunfw version/ABI is part of the pinned msb release;
// re-verify all names when bumping the pin.
const KRUN_INSTALL_NAMES: Record<Platform, string> = {
  "darwin-arm64": "libkrunfw.5.dylib",
  "linux-x64": "libkrunfw.so.5.5.0",
  "linux-arm64": "libkrunfw.so.5.5.0",
  "win32-x64": "libkrunfw.dll",
  "win32-arm64": "libkrunfw.dll",
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
  if (processPlatform === "win32" && processArch === "x64") {
    return "win32-x64";
  }
  if (processPlatform === "win32" && processArch === "arm64") {
    return "win32-arm64";
  }
  return undefined;
}

/**
 * Linux needs `/dev/kvm` open for read+write; Apple Silicon's virtualization
 * is available whenever the platform itself resolves (Virtualization.framework
 * needs no device-file probe). Windows is attempt-and-report rather than
 * probed: there is no cheap, reliable no-spawn signal for Windows Hypervisor
 * Platform availability (querying the `HypervisorPlatform` optional feature
 * needs a PowerShell subprocess, which this synchronous method cannot spawn
 * without blocking), and the windows-spike findings (2026-07-05, msb 0.6.3 on
 * windows-2022/windows-2025 hosted runners) showed WHP already enabled out of
 * the box on both — so a detected Windows platform reports true here, exactly
 * as macOS does, and a genuinely WHP-less host finds out from msb's own error
 * at boot (`msb doctor`/`msb run` fail loudly), not a silent Docker downgrade.
 * All branches use the synchronous `fs` calls — never `fs.access` — because
 * `BackendProvider.isSupported()` (the caller, `MsbBackendProvider`) is a
 * synchronous interface method: an async probe here would make
 * `isSupported()` return a Promise, which the pure resolver in
 * `Backends.resolve` would read as truthy ("supported") without ever
 * awaiting it.
 */
function virtualizationAvailable(processPlatform: string, processArch: string): boolean {
  if (processPlatform === "darwin") {
    return currentPlatform(processPlatform, processArch) !== undefined;
  }
  if (processPlatform === "linux") {
    try {
      fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
  if (processPlatform === "win32") {
    return currentPlatform(processPlatform, processArch) !== undefined;
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
  /** The libkrunfw release asset filename for this platform — what it is downloaded as. */
  krunAsset(p: Platform): string {
    return KRUN_ASSETS[p];
  },
  /**
   * The basename the msb binary must be installed under inside `bin/` —
   * suffixless (`msb`) on macOS/Linux, `msb.exe` on Windows (there is no
   * such thing as a suffixless executable on Windows; the OS resolves
   * executables by extension, not an executable permission bit). Derived
   * from the platform rather than a literal `"msb"` constant so the
   * provisioner's install-target path is correct on every platform.
   */
  msbBinaryName(p: Platform): string {
    return p === "win32-x64" || p === "win32-arm64" ? "msb.exe" : "msb";
  },
  /** The filename the library must be installed under for msb to resolve it. */
  krunInstallName(p: Platform): string {
    return KRUN_INSTALL_NAMES[p];
  },
  /** Whether this machine can actually run msb's microVMs right now (KVM access on Linux; always true once the platform itself resolves on macOS or Windows — see `virtualizationAvailable`'s doc comment for why Windows is attempt-and-report). */
  virtualizationAvailable(): boolean {
    return virtualizationAvailable(process.platform, process.arch);
  },
  /** Test seam: exercises the pure decision tables against injected platform/arch strings. */
  _currentFor(processPlatform: string, processArch: string): Platform | undefined {
    return currentPlatform(processPlatform, processArch);
  },
  /** Test seam: exercises `virtualizationAvailable`'s pure per-OS branches against injected platform/arch strings, without a real `/dev/kvm` or host OS. */
  _virtualizationAvailableFor(processPlatform: string, processArch: string): boolean {
    return virtualizationAvailable(processPlatform, processArch);
  },
};
