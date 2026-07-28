import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";
import { DockerImageName } from "../core/docker-image-name.js";

const GUEST_PORT = 27017;
// 180s, not the 60s this module used while it pinned `mongo:8.0`. A loaded Windows CI
// runner was observed failing `rs.initiate` at the 60s mark against the floating default
// (`mongo:latest`, 8.2.12 at the time), on a run whose whole suite took 28 minutes. This
// matches the budget the MySQL and ClickHouse modules already carry for the same reason:
// a first-boot sequence that is comfortable locally and marginal on a contended runner.
const REPLICA_SET_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 500;
const EXPECTED_REPOSITORY = "mongo";
const DEFAULT_IMAGE = "mongo:latest";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A single-node MongoDB container running as a one-member replica set
 * (required for transactions/change streams). `containerIsStarted`
 * initiates the replica set and waits for a primary to be elected before
 * `start()` returns, so `connectionString` is always usable immediately
 * after the container boots.
 *
 * No-arg construction floats to `mongo:latest`, so the version tracks
 * upstream rather than this library's release cycle (verified against
 * `mongo:8.0`).
 */
export class MongoDBContainer extends GenericContainer {
  constructor(image: string | DockerImageName = DEFAULT_IMAGE) {
    super(DockerImageName.requireCompatible(image, EXPECTED_REPOSITORY));
    this.withExposedPorts(GUEST_PORT)
      .withCommand("mongod", "--replSet", "docker-rs", "--bind_ip_all")
      .waitingFor(Wait.forListeningPort());
  }

  static override async start(image: string | DockerImageName = DEFAULT_IMAGE): Promise<MongoDBContainer> {
    return (await new MongoDBContainer(image).start()) as MongoDBContainer;
  }

  protected override async containerIsStarted(): Promise<void> {
    await this.pollUntil("rs.initiate to succeed", async () => {
      const result = await this.exec(
        "mongosh",
        "--quiet",
        "--eval",
        "try { rs.status() } catch (e) { rs.initiate() }",
      );
      return result.exitCode === 0;
    });
    await this.pollUntil("a PRIMARY to be elected", async () => {
      const result = await this.exec("mongosh", "--quiet", "--eval", "db.hello().isWritablePrimary");
      return result.stdout.trim().endsWith("true");
    });
  }

  // Bounded retry through the race between the proxy accepting the
  // published port and mongod actually listening behind it: the same
  // early-accept window the read-probe wait strategy handles for a plain
  // TCP wait also affects the first exec against the guest, so
  // rs.initiate/db.hello() need their own poll rather than a single shot.
  private async pollUntil(what: string, cond: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + REPLICA_SET_TIMEOUT_MS;
    for (;;) {
      let ready = false;
      try {
        ready = await cond();
      } catch {
        ready = false;
      }
      if (ready) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Mongo replica set on ${this.host}:${this.getMappedPort(GUEST_PORT)} did not reach '${what}' within ${REPLICA_SET_TIMEOUT_MS / 1000}s`,
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /** A `mongodb://` connection string for the running container's `test` database. */
  get connectionString(): string {
    return `mongodb://${this.host}:${this.getMappedPort(GUEST_PORT)}/test?directConnection=true`;
  }

  /** Alias for `connectionString`; the container is always a (single-node) replica set. */
  get replicaSetUrl(): string {
    return this.connectionString;
  }
}
