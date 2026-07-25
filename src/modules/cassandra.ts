import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";

const CQL_PORT = 9042;
const STARTUP_TIMEOUT_MS = 300_000;

/**
 * A single-node Cassandra container.
 *
 * ### `GPG_KEYS` must be overridden — this is the difference between booting and aborting
 *
 * `cassandra:5.0.8`'s baked-in `GPG_KEYS` build arg contains a literal TAB
 * character, and msb 0.6.6 panics on any image whose baked env contains one
 * — before the guest even boots:
 *
 * ```
 * sandbox process exited (signal: 6 (SIGABRT)) before agent relay became available
 * ```
 *
 * with `msb logs --source system` showing:
 *
 * ```
 * panicked at msb_krun_vmm-0.1.25/src/builder.rs:1154: ... Err value: InvalidAscii
 * ```
 *
 * `GPG_KEYS` is consumed only at image-build time (verifying the signing
 * keys baked into that layer) — it has no effect on the running container,
 * so overriding it to an empty, tab-free string here is safe and required.
 * Without this override, `start()` never gets far enough to run its own
 * wait strategy at all.
 *
 * ### Heap sized down, memory ceiling measured
 *
 * `MAX_HEAP_SIZE=512M`/`HEAP_NEWSIZE=128M` keep the JVM small; `2560` MB is
 * the verified memory ceiling at that heap size.
 *
 * ### Readiness
 *
 * Anchored on the CQL native-transport log line (`Starting listening for
 * CQL clients`), observed at 58s on a quiet local machine. 300s absorbs a
 * loaded-host boot without masking a real hang — Cassandra is heavier than
 * either Keycloak or MySQL, both of which carry 180s in this library.
 */
export class CassandraContainer extends GenericContainer {
  constructor(image = "cassandra:5.0.8") {
    super(image);
    this.withExposedPorts(CQL_PORT)
      // Required — see the class doc for the exact panic this avoids.
      .withEnv("GPG_KEYS", "")
      .withEnv("MAX_HEAP_SIZE", "512M")
      .withEnv("HEAP_NEWSIZE", "128M")
      .withMemoryLimit(2560)
      .waitingFor(
        Wait.forLogMessage(".*Starting listening for CQL clients.*", 1).withStartupTimeout(STARTUP_TIMEOUT_MS),
      );
  }

  static override async start(image = "cassandra:5.0.8"): Promise<CassandraContainer> {
    return (await new CassandraContainer(image).start()) as CassandraContainer;
  }

  /** `<host>:<port>` for the running container — the shape most CQL drivers want for a contact point. */
  get contactPoint(): string {
    return `${this.host}:${this.getMappedPort(CQL_PORT)}`;
  }

  /** The mapped CQL native-transport port. */
  get cqlPort(): number {
    return this.getMappedPort(CQL_PORT);
  }

  /** This single node's local datacenter name — required by drivers (e.g. the DataStax Node driver) that insist on an explicit value at connect time. */
  get localDatacenter(): string {
    return "datacenter1";
  }
}
