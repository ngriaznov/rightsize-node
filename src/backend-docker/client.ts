import * as http from "node:http";
import type { IncomingMessage } from "node:http";
import { BackendError } from "../core/errors.js";

const DEFAULT_SOCKET_PATH = "/var/run/docker.sock";

/**
 * Ceiling on one unary request/response cycle — connect, write, read
 * headers, read the whole body. Deliberately NOT applied to streaming reads
 * (`followLogs`): that call is meant to block for as long as the workload
 * runs, so bounding it here would kill a perfectly healthy long-lived
 * stream. Unary calls (create/start/stop/exec-inspect/logs/ls) get it
 * because a wedged daemon must fail the caller promptly instead of hanging
 * the whole test run.
 */
const RESPONSE_TIMEOUT_MS = 600_000;

/**
 * Ceiling on connecting to the daemon's unix socket and receiving response
 * headers — the phase before `RESPONSE_TIMEOUT_MS`'s body-reading window
 * even starts. Without this, a request whose connection or header phase
 * never completes (an unresponsive daemon, a wedged socket) hangs `send()`
 * forever with nothing else in this client ever getting the chance to time
 * it out — `request()`'s own timer only starts once `send()` has already
 * resolved with a response. Observed in practice: an intermittent hang here
 * under Bun's `node:http` implementation, not merely a theoretical gap.
 */
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Bounds how many header bytes this client will accumulate before giving up.
 * A well-behaved daemon's status line + header block is at most a few
 * hundred bytes; `node:http` already enforces its own such limit internally,
 * but this constant documents the ceiling this backend would apply if it
 * were parsing headers by hand — kept here as the single source of truth
 * other backend code can cite.
 */
export const MAX_HEADER_BYTES = 8 * 1024;

/** A fully-buffered daemon response, returned by `DockerClient.request`. */
export interface DockerResponse {
  /** The HTTP status code. */
  readonly status: number;
  /** The full response body. */
  readonly body: Buffer;
}

/** A daemon response whose body is left as a live stream, returned by `DockerClient.requestStream` for `exec`/`logs` calls. */
export interface DockerStreamResponse {
  /** The HTTP status code. */
  readonly status: number;
  /** Whether the daemon sent `Transfer-Encoding: chunked` (node:http already de-chunks it transparently either way). */
  readonly chunked: boolean;
  /** The `Content-Length` header value, when present and not chunked. */
  readonly contentLength: number | undefined;
  /** The raw, already-de-chunked response stream — `node:http` handles `Transfer-Encoding` transparently, so the frame demuxer only ever sees raw framed bytes. */
  readonly body: IncomingMessage;
}

/**
 * The pure seam `DockerClient.fromEnv` delegates to: given a `DOCKER_HOST`
 * value (or `undefined`), returns the unix socket path this client should
 * dial. A `tcp://`/`http://` `DOCKER_HOST` falls back to the default socket
 * path rather than attempting a TCP connection — this client has no TCP
 * transport at all (see the module docs on why: sharing an HTTP stack a
 * consumer can bump is exactly the failure mode being avoided).
 */
export function socketPathFromDockerHost(host: string | undefined): string {
  if (host === undefined) {
    return DEFAULT_SOCKET_PATH;
  }
  if (host.startsWith("unix://")) {
    return host.slice("unix://".length);
  }
  if (host.startsWith("/")) {
    return host;
  }
  return DEFAULT_SOCKET_PATH;
}

/**
 * A from-scratch HTTP client over the Docker daemon's unix socket, built on
 * `node:http`'s `socketPath` option rather than a general-purpose Docker SDK
 * (`dockerode`) — the point of hand-rolling is that this client can only
 * ever dial a unix socket path, never a TCP host. A shared HTTP stack a
 * consuming project also depends on has, on another runtime, been observed
 * to misroute a Docker client onto TCP `localhost:2375` instead of the
 * daemon's real unix socket; owning this client end-to-end makes that
 * misrouting structurally impossible; see the standing regression test in
 * `backend.test.ts`.
 *
 * Every daemon endpoint this backend calls returns either a small buffered
 * JSON body (unary calls — `request`) or a stream of raw framed bytes
 * (`exec`/`logs` — `requestStream`). Both go through `POST
 * /exec/{id}/start`-style ordinary responses, never `/attach`'s connection
 * hijack, so `node:http`'s `IncomingMessage` is sufficient for either case —
 * no need to drop to a raw socket.
 */
export class DockerClient {
  constructor(
    private readonly socketPath: string = socketPathFromDockerHost(process.env["DOCKER_HOST"]),
    // Test seam: production call sites never pass this, so every real client
    // gets the real ceiling. A fixture that wants to prove the timeout path
    // itself fires (without actually waiting 30s) constructs with a much
    // smaller override instead.
    private readonly connectTimeoutMs: number = CONNECT_TIMEOUT_MS,
  ) {}

  /** Builds a client honoring `DOCKER_HOST` (a `unix://` path, a bare path, or the daemon's default socket). */
  static fromEnv(): DockerClient {
    return new DockerClient(socketPathFromDockerHost(process.env["DOCKER_HOST"]));
  }

  /** The unix socket path this client dials — never a TCP host. */
  getSocketPath(): string {
    return this.socketPath;
  }

  /**
   * One request whose entire response body is read into memory before
   * returning — every daemon call this backend makes except
   * `exec`/`logs` streaming (`requestStream`). Bounded by
   * `RESPONSE_TIMEOUT_MS` so a wedged daemon fails this call with a named
   * error instead of hanging the caller forever.
   */
  async request(method: string, path: string, body?: string): Promise<DockerResponse> {
    const { res } = await this.send(method, path, body);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolveBody, rejectBody) => {
      const timer = setTimeout(() => {
        res.destroy();
        rejectBody(
          new BackendError(`${method} ${path} to the Docker daemon did not complete within ${RESPONSE_TIMEOUT_MS / 1000}s`),
        );
      }, RESPONSE_TIMEOUT_MS);
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        clearTimeout(timer);
        resolveBody();
      });
      res.on("error", (err) => {
        clearTimeout(timer);
        rejectBody(new BackendError(`reading a response from the Docker daemon: ${err.message}`));
      });
    });
    return { status: res.statusCode ?? 0, body: Buffer.concat(chunks) };
  }

  /**
   * Issues a request and returns the status plus the still-open response
   * stream, for callers (`exec`/`logs`, the frame demuxer) that consume a
   * de-chunked body incrementally rather than buffering it all first.
   * Deliberately NOT wrapped in `RESPONSE_TIMEOUT_MS` — `followLogs` streams
   * for as long as the workload runs, by design.
   */
  async requestStream(method: string, path: string, body?: string): Promise<DockerStreamResponse> {
    const { res } = await this.send(method, path, body);
    const transferEncoding = res.headers["transfer-encoding"];
    const chunked = typeof transferEncoding === "string" && transferEncoding.toLowerCase().includes("chunked");
    const contentLengthHeader = res.headers["content-length"];
    const contentLength =
      typeof contentLengthHeader === "string" && !chunked ? Number.parseInt(contentLengthHeader, 10) : undefined;
    return { status: res.statusCode ?? 0, chunked, contentLength, body: res };
  }

  private send(method: string, path: string, body?: string): Promise<{ res: IncomingMessage }> {
    return new Promise((resolveSend, rejectSend) => {
      const headers: Record<string, string> = {};
      if (body !== undefined) {
        headers["Content-Length"] = String(Buffer.byteLength(body));
        headers["Content-Type"] = "application/json";
      }
      let settled = false;
      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path,
          headers,
          // No connection pooling: `http.globalAgent`'s default keep-alive
          // behavior holds the underlying unix-socket connection open after
          // the response completes, hoping to reuse it for a later request
          // to the same socket path. Nothing in this client ever reuses a
          // connection (every call opens its own), so a pooled socket just
          // sits idle — which keeps a bare `node --test` process (or any
          // short-lived script) alive well past its last container
          // operation, since Node won't exit while a socket handle is open.
          // `agent: false` makes every request its own unshared connection
          // that node:http tears down as soon as the response ends.
          agent: false,
        },
        (res) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(connectTimer);
          resolveSend({ res });
        },
      );
      const connectTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        req.destroy();
        rejectSend(
          new BackendError(
            `${method} ${path} to the Docker daemon at ${this.socketPath} did not connect/respond within ` +
              `${this.connectTimeoutMs / 1000}s — is the daemon running and responsive?`,
          ),
        );
      }, this.connectTimeoutMs);
      req.on("error", (err) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimer);
        rejectSend(
          new BackendError(
            `could not connect to the Docker daemon at ${this.socketPath} — is Docker/Podman/Colima running? (${err.message})`,
          ),
        );
      });
      if (body !== undefined) {
        req.write(body);
      }
      req.end();
    });
  }
}
