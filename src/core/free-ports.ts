import * as net from "node:net";

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

const issued = new Set<number>();

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

/** Test-only observability seam: the ports currently considered issued. */
export function issuedView(): ReadonlySet<number> {
  return new Set(issued);
}

export const FreePorts = {
  /** Allocates a host port this process has not already handed out — see `allocate` above. */
  allocate,
  /** Releases a port back to the pool — see `release` above. */
  release,
  /** Test-only observability seam — see `issuedView` above. */
  issuedView,
};
