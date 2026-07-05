import * as net from "node:net";
import * as http from "node:http";
import { ContainerLaunchError } from "./errors.js";

/** The read-only view of a starting container a `WaitStrategy` probes against. `GenericContainer` implements this internally; modules never construct one. */
export interface WaitTarget {
  /** The container's host, always `"127.0.0.1"`. */
  readonly host: string;
  /** The host port bound to `guestPort`. */
  mappedPort(guestPort: number): number;
  /** Every guest port this container published via `withExposedPorts`. */
  readonly exposedGuestPorts: ReadonlyArray<number>;
  /** The workload's logs so far. May throw or return an empty string before the workload has produced any output. */
  currentLogs(): Promise<string>;
  /** A short human-readable identifier for this container, used in timeout messages. */
  describe(): string;
}

/** A pluggable readiness check passed to `GenericContainer.waitingFor`. Construct one via `Wait.*`, not directly. */
export interface WaitStrategy {
  /** Poll until ready or throw `ContainerLaunchError` (with `describe()` and the last 50 log lines) at the deadline. */
  waitUntilReady(target: WaitTarget): Promise<void>;
  /** Override the default 60s deadline. Returns the same strategy for chaining. */
  withStartupTimeout(ms: number): WaitStrategy;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;
const LOG_TAIL_LINES = 50;
const READ_PROBE_TIMEOUT_MS = 200;
// Bounds the connect phase itself (before any byte has arrived), distinct
// from READ_PROBE_TIMEOUT_MS which bounds the post-connect idle read below.
// A short but non-trivial ceiling: a loopback connect to an already-bound
// port normally settles in well under a millisecond, so this is generous
// headroom for a slow host, not a tight budget.
const CONNECT_PROBE_TIMEOUT_MS = 2_000;
const HTTP_PROBE_TIMEOUT_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function logTail(target: WaitTarget): Promise<string> {
  let logs: string;
  try {
    logs = await target.currentLogs();
  } catch {
    return "";
  }
  const lines = logs.split("\n");
  return lines.slice(-LOG_TAIL_LINES).join("\n");
}

async function timeoutError(target: WaitTarget): Promise<ContainerLaunchError> {
  const tail = await logTail(target);
  return new ContainerLaunchError(`Timed out waiting for ${target.describe()} to become ready.\n${tail}`);
}

/**
 * Owns the deadline/poll-interval/log-tail plumbing shared by every wait
 * strategy: probe once immediately (a sub-interval timeout must still get
 * one chance to succeed — the off-by-one every naive port-wait gets wrong),
 * then keep polling until either a probe reports ready or the deadline
 * passes.
 */
abstract class AbstractWaitStrategy implements WaitStrategy {
  /** The current startup deadline in milliseconds; defaults to 60s, overridden by `withStartupTimeout`. */
  protected timeoutMs = DEFAULT_TIMEOUT_MS;

  withStartupTimeout(ms: number): this {
    this.timeoutMs = ms;
    return this;
  }

  /** One readiness check attempt; ready iff it resolves `true`. Implemented by each concrete strategy. */
  protected abstract probe(target: WaitTarget): Promise<boolean>;

  async waitUntilReady(target: WaitTarget): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    // do-while: always probe at least once, even if the deadline has
    // already passed by the time we get here (a 1ms timeout must still
    // get its one shot).
    for (;;) {
      if (await this.probe(target)) {
        return;
      }
      if (Date.now() >= deadline) {
        throw await timeoutError(target);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

/**
 * A bare TCP connect succeeds against docker's userland proxy the instant
 * the host port is published — before the guest process has bound its own
 * listening socket. Connect-then-read distinguishes the two: an
 * accept-with-nobody-behind-it proxy closes immediately (EOF/RST) on a
 * zero-byte read, while a real peer either sends data or simply holds the
 * connection open past the read timeout.
 */
function readProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = new net.Socket();
    let settled = false;

    // First-event-wins: whichever of data/timeout/end/error fires first
    // decides the verdict; every listener is torn down immediately so a
    // later event on the same socket can never flip an already-resolved
    // verdict (a chatty peer emitting `data` then `end` must resolve ready
    // on the `data` and ignore the trailing `end`).
    const finish = (ready: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(hardTimer);
      socket.removeAllListeners();
      socket.destroy();
      resolveProbe(ready);
    };

    // Hard backstop, independent of socket.setTimeout(): the socket-level
    // timeout below is only armed AFTER connect succeeds, so a connect that
    // neither succeeds nor errors — just hangs — has nothing to bound it,
    // and a plain JS timer costs nothing to add as a second line of defense
    // regardless. This one call's own AbstractWaitStrategy poll loop can't
    // rescue a probe() that never resolves at all; every module that uses
    // the default Wait.forListeningPort() depends on this call actually
    // settling every time.
    const hardTimer = setTimeout(() => finish(false), READ_PROBE_TIMEOUT_MS + CONNECT_PROBE_TIMEOUT_MS);

    // The connect-phase timeout listener is named (not `.once`) so it can be
    // explicitly removed once connect succeeds — leaving it attached would
    // otherwise also fire on the READ-phase timeout re-armed below and race
    // against that timeout's own "ready" verdict (this connect-phase one
    // means not-ready; the post-connect one means ready — two different
    // meanings for the same event name on the same socket).
    const onConnectTimeout = (): void => finish(false);
    socket.setTimeout(CONNECT_PROBE_TIMEOUT_MS);
    socket.once("error", () => finish(false));
    socket.once("timeout", onConnectTimeout);
    socket.connect(port, host, () => {
      socket.removeListener("timeout", onConnectTimeout);
      socket.setTimeout(READ_PROBE_TIMEOUT_MS);
      socket.once("data", () => finish(true));
      socket.once("timeout", () => finish(true));
      socket.once("end", () => finish(false));
      socket.once("error", () => finish(false));
    });
  });
}

class ListeningPortWaitStrategy extends AbstractWaitStrategy {
  protected async probe(target: WaitTarget): Promise<boolean> {
    if (target.exposedGuestPorts.length === 0) {
      // No exposed ports: nothing to wait for on the network — vacuously ready.
      return true;
    }
    for (const guestPort of target.exposedGuestPorts) {
      const hostPort = target.mappedPort(guestPort);
      if (!(await readProbe(target.host, hostPort))) {
        return false;
      }
    }
    return true;
  }
}

/** Readiness = an HTTP GET against the container returning the expected status code (200 by default). Build via `Wait.forHttp`. */
export class HttpWaitStrategy extends AbstractWaitStrategy {
  private path: string;
  private port: number | undefined;
  private expectedStatus = 200;

  constructor(path: string) {
    super();
    this.path = path;
  }

  /** Probe this guest port instead of the first exposed one. */
  forPort(port: number): this {
    this.port = port;
    return this;
  }

  /** Expect this status code instead of 200. */
  forStatusCode(status: number): this {
    this.expectedStatus = status;
    return this;
  }

  /** One HTTP GET attempt; ready iff the response status matches `forStatusCode` (default 200). Internal — called by the base class's poll loop. */
  protected async probe(target: WaitTarget): Promise<boolean> {
    const guestPort = this.port ?? target.exposedGuestPorts[0];
    if (guestPort === undefined) {
      return false;
    }
    const hostPort = target.mappedPort(guestPort);
    return new Promise((resolveProbe) => {
      let settled = false;
      const finish = (ready: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(hardTimer);
        resolveProbe(ready);
      };
      // Hard backstop alongside the `timeout` option below — see readProbe's
      // comment in this same file for why a socket-level timeout alone isn't
      // trusted as the only bound here.
      const hardTimer = setTimeout(() => {
        req.destroy();
        finish(false);
      }, HTTP_PROBE_TIMEOUT_MS + 500);
      const req = http.request(
        { host: target.host, port: hostPort, path: this.path, method: "GET", timeout: HTTP_PROBE_TIMEOUT_MS },
        (res) => {
          res.resume();
          finish(res.statusCode === this.expectedStatus);
        },
      );
      req.once("timeout", () => {
        req.destroy();
        finish(false);
      });
      req.once("error", () => finish(false));
      req.end();
    });
  }
}

class LogMessageWaitStrategy extends AbstractWaitStrategy {
  constructor(
    private readonly pattern: RegExp,
    private readonly times: number,
  ) {
    super();
  }

  protected async probe(target: WaitTarget): Promise<boolean> {
    // times === 0 means "ready on the first probe, regardless of whether
    // logs are even fetchable yet" — a command-only container's first probe
    // may see currentLogs() throw or return "", and count() >= 0 is
    // trivially true, so this branch never needs to touch the logs.
    if (this.times === 0) {
      return true;
    }
    let logs: string;
    try {
      logs = await target.currentLogs();
    } catch {
      return false;
    }
    let matches = 0;
    for (const line of logs.split("\n")) {
      // A line matching both whole-line and as a substring still counts
      // once per line — `test()` on the whole line, not a global exec loop.
      if (this.pattern.test(line)) {
        matches++;
      }
    }
    return matches >= this.times;
  }
}

/** Factory namespace for the built-in wait strategies; pass the result to `GenericContainer.waitingFor`. */
export const Wait = {
  /** Ready once every exposed port accepts a real peer (read-probed, not just connect — see `readProbe` above). The default strategy when none is set. */
  forListeningPort(): WaitStrategy {
    return new ListeningPortWaitStrategy();
  },
  /** Ready once an HTTP GET to `path` returns the expected status. Chain `.forPort(n)` / `.forStatusCode(n)`. */
  forHttp(path: string): HttpWaitStrategy {
    return new HttpWaitStrategy(path);
  },
  /** Ready once `pattern` has matched at least `times` distinct log lines (default 1). `times=0` is ready immediately, without needing logs to be fetchable yet. */
  forLogMessage(pattern: string, times = 1): WaitStrategy {
    return new LogMessageWaitStrategy(new RegExp(pattern), times);
  },
};
