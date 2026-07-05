import * as fs from "node:fs";
import type { BackendProvider, SandboxBackend } from "../core/backend.js";
import { DockerBackend } from "./backend.js";
import { DockerClient, socketPathFromDockerHost } from "./client.js";

/**
 * `isSupported()` must be synchronous (the interface's contract — see
 * `../core/backend.ts`), but the daemon's real reachability probe
 * (`GET /_ping`) is inherently async over `node:http`. Rather than fake a
 * synchronous HTTP round trip, this resolves to "the socket path exists and
 * is a socket" via `fs.statSync().isSocket()`, deferring true reachability
 * to first use — an existing-but-dead daemon surfaces a clear error the
 * moment a real call is made. A blocking `/_ping` here would be the
 * stronger check, but JS has no synchronous socket I/O to do it with, and
 * the stat is behaviorally equivalent for backend resolution since a socket
 * file present but genuinely unreachable is vanishingly rare.
 */
export class DockerBackendProvider implements BackendProvider {
  /** `"docker"` — matched case-insensitively against `RIGHTSIZE_BACKEND`. */
  readonly name = "docker";
  readonly priority = 10;

  isSupported(): boolean {
    const socketPath = socketPathFromDockerHost(process.env["DOCKER_HOST"]);
    try {
      return fs.statSync(socketPath).isSocket();
    } catch {
      return false;
    }
  }

  unsupportedReason(): string {
    return "no reachable Docker-API socket (Docker/Podman/Colima not running?)";
  }

  create(): SandboxBackend {
    return new DockerBackend(DockerClient.fromEnv());
  }
}
