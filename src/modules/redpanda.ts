import { GenericContainer } from "../core/generic-container.js";
import { Wait } from "../core/wait.js";
import { DockerImageName } from "../core/docker-image-name.js";
import type { ContainerSpec } from "../core/model.js";

const EXTERNAL_PORT = 9092;
const INTERNAL_PORT = 9093;
const SCHEMA_REGISTRY_PORT = 8081;
const EXPECTED_REPOSITORY = "redpandadata/redpanda";
const DEFAULT_IMAGE = "redpandadata/redpanda:latest";

// The alias siblings resolve INTERNAL through — native docker networks, or
// the msb exec-tunnel alias emulation.
const INTERNAL_ALIAS = "redpanda";

/**
 * A single-node Redpanda broker (Kafka API-compatible) with its schema
 * registry enabled.
 *
 * No-arg construction floats to `redpandadata/redpanda:latest`, so the
 * version tracks upstream rather than this library's release cycle
 * (verified against `redpandadata/redpanda:v24.2.4`). This module previously
 * pinned a versioned tag instead of floating, reasoning that
 * `docker.redpanda.com` rate-limits anonymous pulls and a versioned tag made
 * a one-time image seed (`docker save <img> | msb load`, ahead of
 * microsandbox runs) reproducible — that rate limit is a pull-frequency
 * property, not a tag one, and applies to `:latest` exactly the same as any
 * other tag; seed the image into the cache once regardless of which
 * reference you use.
 */
export class RedpandaContainer extends GenericContainer {
  constructor(image: string | DockerImageName = DEFAULT_IMAGE) {
    super(DockerImageName.requireCompatible(image, EXPECTED_REPOSITORY));
    this.withExposedPorts(EXTERNAL_PORT, INTERNAL_PORT, SCHEMA_REGISTRY_PORT).waitingFor(
      Wait.forLogMessage(".*Successfully started Redpanda.*"),
    );
  }

  static override async start(
    image: string | DockerImageName = DEFAULT_IMAGE,
  ): Promise<RedpandaContainer> {
    return (await new RedpandaContainer(image).start()) as RedpandaContainer;
  }

  /**
   * The advertised listener must carry the mapped host port, known only now
   * (ports were allocated before boot) — the reason this hook exists at
   * all. EXTERNAL advertises that mapped host port for host clients;
   * INTERNAL advertises the fixed alias:port siblings resolve on the
   * container network. See `KafkaContainer.customizeSpec` for the same
   * trick applied to a single advertised listener.
   */
  protected override customizeSpec(spec: ContainerSpec, mapped: (guest: number) => number): ContainerSpec {
    const command = [
      "redpanda",
      "start",
      "--mode",
      "dev-container",
      "--smp",
      "1",
      "--kafka-addr",
      `EXTERNAL://0.0.0.0:${EXTERNAL_PORT},INTERNAL://0.0.0.0:${INTERNAL_PORT}`,
      "--advertise-kafka-addr",
      `EXTERNAL://127.0.0.1:${mapped(EXTERNAL_PORT)},INTERNAL://${INTERNAL_ALIAS}:${INTERNAL_PORT}`,
      "--schema-registry-addr",
      `0.0.0.0:${SCHEMA_REGISTRY_PORT}`,
    ];
    return { ...spec, command };
  }

  /** The `PLAINTEXT://` bootstrap-servers address for the running broker (EXTERNAL listener). */
  get bootstrapServers(): string {
    return `PLAINTEXT://${this.host}:${this.getMappedPort(EXTERNAL_PORT)}`;
  }

  /** The schema registry's base URI for the running broker. */
  get schemaRegistryUrl(): string {
    return `http://${this.host}:${this.getMappedPort(SCHEMA_REGISTRY_PORT)}`;
  }
}
