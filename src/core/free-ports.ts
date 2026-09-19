import * as net from "node:net";
import * as dgram from "node:dgram";

const MAX_ALLOCATE_ATTEMPTS = 100;

// Binds are loopback-only (127.0.0.1), not wildcard — the same conservative
// choice used everywhere else a host port is touched (publishing, wait
// probes). A deliberate divergence from binding 0.0.0.0, not an oversight.
const BIND_HOST = "127.0.0.1";

function bindEphemeralPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = net.createServer();
    server.once("error", (err) => {
      rejectPort(err);
    });
    server.listen(0, BIND_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPort(new Error("failed to read an ephemeral port from the bound server"));
        return;
      }
      const port = address.port;
      server.close(() => {
        resolvePort(port);
      });
    });
  });
}

/**
 * The UDP counterpart of `bindEphemeralPort`: a TCP `listen()` proves
 * nothing about UDP's independent OS port table (and vice versa) — a port
 * free on one transport can easily be bound on the other — so a UDP host
 * port must be proven free by binding an actual UDP socket, not inferred
 * from the TCP probe. Same shape as the TCP path: bind ephemeral, read the
 * assigned port back, close, hand the number to the caller.
 */
function bindEphemeralUdpPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", (err) => {
      rejectPort(err);
    });
    socket.bind(0, BIND_HOST, () => {
      const address = socket.address();
      const port = address.port;
      socket.close(() => {
        resolvePort(port);
      });
    });
  });
}

const issued = new Set<number>();
// A separate issued set for UDP: TCP and UDP each have their own OS-level
// port table, so the two pools track uniqueness independently — a port
// issued on one transport says nothing about the other, and a container may
// legitimately be handed the same numeric port on both (see `PortBinding`'s
// own doc on the DNS-53 case).
const issuedUdp = new Set<number>();

/**
 * Allocates a host port this process has not already handed out. Binding
 * `127.0.0.1:0` and immediately closing the socket leaves a window where
 * another process (or another allocate() racing on ITS OWN OS-level choice)
 * could rebind the same port before the caller's container process starts —
 * `GenericContainer`'s port-retry loop is the mitigation for that race, not
 * this function. What this function guarantees is in-process uniqueness:
 * two calls here never return the same port while either is still issued.
 */
export async function allocate(): Promise<number> {
  for (let attempt = 0; attempt < MAX_ALLOCATE_ATTEMPTS; attempt++) {
    const port = await bindEphemeralPort();
    if (!issued.has(port)) {
      issued.add(port);
      return port;
    }
  }
  throw new Error(`could not allocate a unique free port after ${MAX_ALLOCATE_ATTEMPTS} attempts`);
}

/** Releases a port back to the pool. Releasing a port never issued by this process is a harmless no-op. */
export function release(port: number): void {
  issued.delete(port);
}

/**
 * The UDP counterpart of `allocate`: same in-process-uniqueness contract,
 * same retry shape, but proven free by binding a UDP socket (see
 * `bindEphemeralUdpPort`) rather than a TCP listener — a TCP probe cannot
 * stand in for this, since the two transports keep independent OS port
 * tables.
 */
export async function allocateUdp(): Promise<number> {
  for (let attempt = 0; attempt < MAX_ALLOCATE_ATTEMPTS; attempt++) {
    const port = await bindEphemeralUdpPort();
    if (!issuedUdp.has(port)) {
      issuedUdp.add(port);
      return port;
    }
  }
  throw new Error(`could not allocate a unique free UDP port after ${MAX_ALLOCATE_ATTEMPTS} attempts`);
}

/** Releases a UDP port back to its pool — the UDP counterpart of `release`. Releasing a port never issued by this process is a harmless no-op. */
export function releaseUdp(port: number): void {
  issuedUdp.delete(port);
}

/** Test-only observability seam: the ports currently considered issued. */
export function issuedView(): ReadonlySet<number> {
  return new Set(issued);
}

/** Test-only observability seam for the UDP pool — see `issuedView`. */
export function issuedUdpView(): ReadonlySet<number> {
  return new Set(issuedUdp);
}

export const FreePorts = {
  /** Allocates a host port this process has not already handed out — see `allocate` above. */
  allocate,
  /** Releases a port back to the pool — see `release` above. */
  release,
  /** Allocates a UDP host port this process has not already handed out — see `allocateUdp` above. */
  allocateUdp,
  /** Releases a UDP port back to its pool — see `releaseUdp` above. */
  releaseUdp,
  /** Test-only observability seam — see `issuedView` above. */
  issuedView,
  /** Test-only observability seam for the UDP pool — see `issuedUdpView` above. */
  issuedUdpView,
};
