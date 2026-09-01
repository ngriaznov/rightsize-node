import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import type { BackendProvider, SandboxBackend } from "../core/backend.js";
import { DockerBackend } from "./backend.js";
import { DockerClient, socketPathFromDockerHost } from "./client.js";

/**
 * The pure decision behind the old presence-only check: given the resolved
 * endpoint path, does anything exist there at all? Kept as a standalone
 * export — still a legitimate cheap primitive, and part of this package's
 * public surface — but `isSupported()` below no longer relies on it alone: a
 * reachable endpoint is necessary but not sufficient, since a Windows
 * host's own Windows-containers daemon (or, in principle, any non-Linux
 * daemon) is reachable at its pipe/socket while still being the wrong kind
 * of daemon for this backend to drive. See `isLinuxDaemonReachable` for the
 * actual `isSupported()` gate.
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
 * Ceiling on the synchronous daemon-OS probe below — connect, request, read
 * the whole response. Provider resolution happens once per process (see
 * `Backends.active()`'s memoization), so this is a one-time cost on the
 * process's first backend resolution, not a per-call one; a wedged or
 * unresponsive daemon must still let `isSupported()` return promptly rather
 * than hang backend resolution indefinitely.
 */
const DAEMON_PROBE_TIMEOUT_MS = 2_000;

/**
 * The `spawnSync` invocation the daemon-OS probe below runs, given the
 * resolved platform and endpoint path — kept pure and separate so the
 * platform split is unit-testable without actually spawning a process
 * (mirrors `cleanupSyncCommand`'s identical pure-argv/impure-executor split
 * in `backend.ts`).
 *
 * POSIX dials the daemon directly over `curl --unix-socket` — the same
 * transport `cleanupSyncCommand` already uses for teardown. Windows can't
 * reuse that: curl's `--unix-socket` dials an AF_UNIX domain socket, a
 * fundamentally different IPC mechanism from a Windows named pipe (see
 * `cleanupSyncCommand`'s own doc in `backend.ts`), so this shells out to
 * `docker version` instead, which already resolves the daemon's endpoint
 * (the named pipe by default, or `DOCKER_HOST`) on its own — the `docker`
 * CLI is already a hard dependency of this backend's Windows teardown path,
 * so this introduces no new precondition there. Both branches print a JSON
 * blob shaped like the raw `GET /version` response: `{{json .Server}}`
 * serializes the exact same `types.Version` struct that endpoint's body
 * unmarshals into, `Os` field included, so `isLinuxDaemonOs` below reads
 * either output identically.
 */
export function daemonOsProbeCommand(
  processPlatform: string,
  socketPath: string,
): { readonly command: string; readonly args: readonly string[] } {
  if (processPlatform === "win32") {
    return { command: "docker", args: ["version", "--format", "{{json .Server}}"] };
  }
  return {
    command: "curl",
    args: [
      "--silent",
      "--max-time",
      String(DAEMON_PROBE_TIMEOUT_MS / 1000),
      "--unix-socket",
      socketPath,
      "http://localhost/version",
    ],
  };
}

/**
 * The pure decision behind `isSupported()`: does this raw probe stdout
 * describe a daemon serving LINUX containers? Rightsize's docker backend
 * only ever runs Linux containers, so a Windows-containers daemon
 * (`"Os":"windows"`) must read as unsupported even though its pipe is
 * perfectly reachable — Docker Desktop on macOS *and* Windows reports
 * `"linux"` here regardless of host OS, since its daemon runs Linux in a
 * VM/WSL2, so this is the correct cross-platform test, never a host-OS
 * check. Empty input, a non-JSON body, and a response missing or misshaping
 * `Os` all fall through to `false` on purpose — indistinguishable, here,
 * from a connect error or a timed-out probe, matching `isSupported()`'s
 * "any failure means unsupported" contract.
 */
export function isLinuxDaemonOs(rawStdout: string): boolean {
  try {
    const parsed: unknown = JSON.parse(rawStdout);
    if (parsed !== null && typeof parsed === "object" && "Os" in parsed) {
      const os = (parsed as { Os?: unknown }).Os;
      return typeof os === "string" && os.toLowerCase() === "linux";
    }
  } catch {
    // Falls through to `false` — see the doc above.
  }
  return false;
}

/** The exact shape of `node:child_process`'s `spawnSync` this probe needs — narrowed down to an injectable seam so tests can fake a probe outcome (success, wrong OS, spawn failure, timeout) without ever spawning a real process. */
export type DaemonProbeRunner = (
  command: string,
  args: readonly string[],
  options: { readonly timeout: number; readonly encoding: "utf8" },
) => { readonly status: number | null; readonly stdout: string; readonly error?: Error };

/**
 * `isSupported()` must be synchronous (the interface's contract — see
 * `../core/backend.ts`), but the daemon's real OS only ever arrives in an
 * HTTP response body (`GET /version`'s `Os` field) that this backend's own
 * `DockerClient` can only fetch over an async `node:http` round trip. JS has
 * no synchronous socket I/O to bridge that gap, so — exactly like
 * `cleanupSync`'s process-exit teardown — this shells out via
 * `child_process.spawnSync` instead of `DockerClient`, bounded by
 * `DAEMON_PROBE_TIMEOUT_MS` so a wedged daemon fails this promptly rather
 * than hanging backend resolution. `runner` defaults to the real
 * `spawnSync`; every real call site relies on that default, and it exists
 * as a parameter purely as the injected-runner test seam (mirrors
 * `DockerClient`'s own injected `connectTimeoutMs` constructor seam).
 *
 * Degrades to `false` on ANY failure: a spawn error (`result.error` —
 * missing `curl`/`docker` binary), a non-zero exit, a timeout (`spawnSync`'s
 * `timeout` option killing a wedged child, which reports back as a `null`
 * exit status), or a malformed/wrong-OS body (`isLinuxDaemonOs`). Never
 * throws — a probe that can't prove "reachable and Linux" is, by this
 * method's contract, simply "not supported."
 */
export function isLinuxDaemonReachable(
  processPlatform: string,
  socketPath: string,
  runner: DaemonProbeRunner = spawnSync,
): boolean {
  const { command, args } = daemonOsProbeCommand(processPlatform, socketPath);
  let result: ReturnType<DaemonProbeRunner>;
  try {
    result = runner(command, args, { timeout: DAEMON_PROBE_TIMEOUT_MS, encoding: "utf8" });
  } catch {
    return false;
  }
  if (result.error !== undefined || result.status !== 0) {
    return false;
  }
  return isLinuxDaemonOs(result.stdout);
}

/**
 * The registered `"docker"` provider. `isSupported()` itself stays a
 * one-line call against the real endpoint/platform — all the actual
 * decision logic (and its test seams) lives in the pure/injectable
 * functions above.
 */
export class DockerBackendProvider implements BackendProvider {
  /** `"docker"` — matched case-insensitively against `RIGHTSIZE_BACKEND`. */
  readonly name = "docker";
  readonly priority = 10;

  isSupported(): boolean {
    return isLinuxDaemonReachable(process.platform, socketPathFromDockerHost(process.env["DOCKER_HOST"]));
  }

  unsupportedReason(): string {
    if (process.platform === "win32") {
      return (
        "no reachable Docker daemon serving Linux containers at the named pipe " +
        "(\\\\.\\pipe\\docker_engine) — is Docker Desktop running in Linux-container mode?"
      );
    }
    return "no reachable Docker-API socket serving Linux containers (Docker/Podman/Colima not running, or serving non-Linux containers?)";
  }

  create(): SandboxBackend {
    return new DockerBackend(DockerClient.fromEnv());
  }
}
