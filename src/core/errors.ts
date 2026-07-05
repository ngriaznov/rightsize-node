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
