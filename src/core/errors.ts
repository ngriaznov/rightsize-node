/**
 * `feature` stays a noun phrase ("network links", "read-only mount
 * enforcement") and advice lives in `remedy`; the two are composed with an
 * em-dash so every backend renders the same sentence shape.
 *
 * @param feature - A noun phrase naming the unsupported capability.
 * @param backend - The active backend's name (e.g. `"microsandbox"`).
 * @param remedy - Optional actionable advice, appended after an em-dash.
 */
export class UnsupportedByBackendError extends Error {
  constructor(
    /** A noun phrase naming the unsupported capability. */
    readonly feature: string,
    /** The active backend's name (e.g. `"microsandbox"`). */
    readonly backend: string,
    /** Optional actionable advice, appended after an em-dash in the rendered message. */
    readonly remedy?: string,
  ) {
    super(`Feature '${feature}' is not supported by the '${backend}' backend${remedy ? ` — ${remedy}` : ""}`);
    this.name = "UnsupportedByBackendError";
  }
}

/**
 * Thrown when a backend's `start()` fails because a chosen host port is
 * already bound by something else. `GenericContainer`'s start loop classifies
 * this (typed-first, message-substring fallback) and retries with fresh
 * ports rather than surfacing it directly — it only escapes after every
 * retry attempt is exhausted.
 */
export class PortBindConflictError extends Error {
  constructor(
    message: string,
    /** The underlying error or daemon response this classification was derived from, if any. */
    readonly cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "PortBindConflictError";
  }
}

/** Thrown when a wait strategy never observes readiness before its deadline. */
export class ContainerLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerLaunchError";
  }
}

/** Thrown on subprocess/daemon failures; message carries full stderr/body. */
export class BackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendError";
  }
}

/** Thrown when the msb toolchain provisioner can't get a runnable `msb` binary in place (download, checksum, or lock failure). */
export class ProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionError";
  }
}

/**
 * Thrown at `start()` when a container is both marked `withReuse()` and
 * joined to a `Network` via `withNetwork()` — reuse's identity hash covers
 * only the container's own spec, never cross-container network topology, so
 * an adopted sandbox from an earlier process could never be correctly
 * re-linked to today's siblings. Thrown only once reuse is actually double
 * opt-in active (API marker AND `RIGHTSIZE_REUSE`); an API-marked-but-env-
 * disabled container never reaches this check; the whole start() attempt is
 * still aborted before any port allocation, ledger tracking, or backend call.
 */
export class ReuseWithNetworkError extends Error {
  constructor() {
    super(
      "withReuse() cannot be combined with withNetwork() — reuse's identity hash does not cover network " +
        "topology, so an adopted sandbox could not be correctly re-linked to today's siblings. Drop either " +
        "withReuse() or withNetwork() on this container.",
    );
    this.name = "ReuseWithNetworkError";
  }
}

/**
 * Thrown at `start()` when a container is marked `withRequireIsolation()`
 * but the active backend's `capabilities.hardwareIsolated` is `false` — the
 * docker fallback shares the host kernel and cannot provide the
 * hardware-virtualized isolation the caller demanded. Thrown before any
 * create/network work: no sandbox is created.
 */
export class IsolationRequiredError extends Error {
  constructor(
    /** The active backend's name (e.g. `"docker"`). */
    readonly backend: string,
  ) {
    super(
      `withRequireIsolation() demands hardware-virtualized isolation, but the active backend ('${backend}') ` +
        "does not provide it — set RIGHTSIZE_BACKEND=microsandbox to use the microsandbox backend, or drop " +
        "withRequireIsolation() to accept the docker fallback's shared-kernel isolation.",
    );
    this.name = "IsolationRequiredError";
  }
}

/**
 * Thrown by `checkpoint()` when the active backend's
 * `capabilities.checkpoint` is `false` — microsandbox has no upstream
 * microVM snapshot support today. Thrown before any backend call: the
 * generic layer gates on the capability itself rather than letting the
 * backend's own `commitToImage` reject.
 */
export class CheckpointUnsupportedError extends Error {
  constructor(
    /** The active backend's name (e.g. `"microsandbox"`). */
    readonly backend: string,
  ) {
    super(
      `checkpoint() is not supported by the '${backend}' backend — checkpoint/restore is implemented via image ` +
        "commit on the docker backend today; native microVM memory snapshots for microsandbox are on the " +
        "roadmap. Set RIGHTSIZE_BACKEND=docker to use checkpoint/restore.",
    );
    this.name = "CheckpointUnsupportedError";
  }
}
