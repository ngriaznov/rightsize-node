/** A published container port: a host port already chosen, mapped to the port the workload listens on inside the guest. */
export interface PortBinding {
  /** The host-side port, pre-allocated by `FreePorts`. */
  readonly hostPort: number;
  /** The port the workload listens on inside the guest. */
  readonly guestPort: number;
}

/** A host path copied into the guest before boot. `readOnly` defaults to `true` via the builder (`withCopyFileToContainer`). */
export interface FileMount {
  /** Absolute host path to copy from. */
  readonly hostPath: string;
  /** Destination path inside the guest. */
  readonly guestPath: string;
  /** Enforced on docker; advisory only on msb (current microsandbox releases do not enforce guest-side read-only mounts). */
  readonly readOnly: boolean;
}

/** The result of a one-shot `exec` inside a running container. */
export interface ExecResult {
  /** The command's process exit code. */
  readonly exitCode: number;
  /** Everything the command wrote to stdout. */
  readonly stdout: string;
  /** Everything the command wrote to stderr. */
  readonly stderr: string;
}

/**
 * The immutable, backend-agnostic description of a container to launch.
 * Built by `GenericContainer` from its builder calls and handed to
 * whichever `SandboxBackend` is active — a spec never changes once built,
 * and building one performs no I/O.
 */
export interface ContainerSpec {
  /** The container's name, `rz-<runId>-<seq>`. */
  readonly name: string;
  /** The image reference, e.g. `"redis:8.6-alpine"`. */
  readonly image: string;
  /**
   * Array of pairs, not a Map: insertion-ordered, with last-write-wins
   * deduping when a builder overwrites a key.
   */
  readonly env: ReadonlyArray<readonly [string, string]>;
  /** `undefined` means the image's own ENTRYPOINT/CMD runs unmodified. */
  readonly command: ReadonlyArray<string> | undefined;
  /**
   * Already-chosen host ports — the core invariant of this library: a
   * backend binds these, it never allocates its own. See `FreePorts`.
   */
  readonly ports: ReadonlyArray<PortBinding>;
  /** Host files/directories to copy into the guest before boot. */
  readonly mounts: ReadonlyArray<FileMount>;
  /** The `Network.id` this container joins, if any. */
  readonly networkId: string | undefined;
  /** Names this container answers to on its network. */
  readonly aliases: ReadonlyArray<string>;
  /** The process-wide `RunId.value` that named this container. */
  readonly runId: string;
  /** An explicit memory ceiling in MB, if the module or caller set one via `withMemoryLimit`. */
  readonly memoryLimitMb: number | undefined;
}
