import * as fs from "node:fs";
import type { BackendProvider, SandboxBackend } from "../core/backend.js";
import { DockerBackend } from "./backend.js";
import { DockerClient, socketPathFromDockerHost } from "./client.js";

/**
 * The pure decision behind `isSupported()`: given the resolved endpoint
 * path, is it reachable enough to count as "supported"? Parameterized over
 * `processPlatform` purely as the injected-platform test seam — mirrors
 * `PlatformInfo`'s `_currentFor`-style seams in `backend-msb/platform.ts` —
 * every real call site relies on the `process.platform` default.
 *
 * POSIX keeps today's exact check unchanged: `fs.statSync(path).isSocket()`
 * — a plain file sitting at the socket path must never read as "a running
 * daemon." Windows drops the type check to bare stat success instead: Node's
 * `fs.Stats` type-classifier methods (`isSocket()`, `isFIFO()`) are
 * documented-unreliable for entries under Windows' Named Pipe File System
 * (there is no Windows-specific "is a named pipe" stat flag at all), so a
 * successful stat — which fails fast with ENOENT the instant nothing is
 * listening on `\\.\pipe\docker_engine` — is the strongest synchronous,
 * no-spawn signal available. This is the same "attempt and report" treatment
 * `PlatformInfo.virtualizationAvailable` already gives Windows elsewhere in
 * this codebase, for the same underlying reason: no cheap, reliable,
 * synchronous, spawn-free probe exists there beyond "does the entry exist."
 */
export function isEndpointReachable(path: string, processPlatform: string = process.platform): boolean {
  try {
    const stat = fs.statSync(path);
    return processPlatform === "win32" ? true : stat.isSocket();
  } catch {
    return false;
  }
}

/**
 * `isSupported()` must be synchronous (the interface's contract — see
 * `../core/backend.ts`), but the daemon's real reachability probe
 * (`GET /_ping`) is inherently async over `node:http`. Rather than fake a
 * synchronous HTTP round trip, this defers true reachability to first use —
 * an existing-but-dead daemon surfaces a clear error the moment a real call
 * is made — and instead checks the resolved endpoint's mere presence via
 * `isEndpointReachable` (see its own doc for the POSIX/Windows split). A
 * blocking `/_ping` here would be the stronger check, but JS has no
 * synchronous socket I/O to do it with, and the stat is behaviorally
 * equivalent for backend resolution since an endpoint present but genuinely
 * unreachable is vanishingly rare.
 */
export class DockerBackendProvider implements BackendProvider {
  /** `"docker"` — matched case-insensitively against `RIGHTSIZE_BACKEND`. */
  readonly name = "docker";
  readonly priority = 10;

  isSupported(): boolean {
    return isEndpointReachable(socketPathFromDockerHost(process.env["DOCKER_HOST"]));
  }

  unsupportedReason(): string {
    if (process.platform === "win32") {
      return "no reachable Docker Desktop named pipe (\\\\.\\pipe\\docker_engine) — is Docker Desktop running?";
    }
    return "no reachable Docker-API socket (Docker/Podman/Colima not running?)";
  }

  create(): SandboxBackend {
    return new DockerBackend(DockerClient.fromEnv());
  }
}
