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
  /**
   * `true` for a container meant to outlive this process — set by
   * `GenericContainer`'s reuse builder (`.withReuse()`), `false` otherwise.
   * Backends and the reaping ledger consult it to keep a reusable sandbox
   * out of every own-run cleanup path; a container carrying this flag is
   * never appended to the ledger's `.sandboxes` file at all, so a sweep can
   * never reach it.
   */
  readonly keepAlive: boolean;
  /**
   * Set by `GenericContainer.fromCheckpoint()` to the source `Checkpoint`'s
   * `ref`; `undefined` for every ordinary container. Never part of the reuse
   * identity hash — reuse and `fromCheckpoint` is not a supported
   * combination (see `ReuseFromCheckpointError`). docker ignores it (the ref
   * IS an image, so the normal create path already boots from it via
   * `image`); microsandbox boots via `msb run --snapshot <ref>` instead of
   * its normal image boot when this is set.
   */
  readonly checkpointRef: string | undefined;
}

/**
 * The result of `GenericContainer.checkpoint()`: a ref to the committed
 * state plus the source container's spec, everything
 * `GenericContainer.fromCheckpoint()` needs to boot an equivalent container.
 * A checkpoint is a FILESYSTEM capture, not a memory snapshot — a restored
 * container's processes start from scratch against the captured filesystem.
 */
export interface Checkpoint {
  /**
   * The captured state's ref: a committed image tag
   * (`rightsize/checkpoint:<12-hex>`) on docker, a snapshot name
   * (`rz-ckpt-<12-hex>`) on microsandbox — random per checkpoint, never
   * reused.
   */
  readonly ref: string;
  /** The backend that created this checkpoint. Restoring it under a DIFFERENT active backend throws `CheckpointBackendMismatchError` before any backend call. */
  readonly backend: string;
  /** The source container's spec (env, command, exposed ports, memory limit — everything needed to boot an equivalent container from `ref`). */
  readonly spec: ContainerSpec;
}
