import { randomBytes } from "node:crypto";
import type { SandboxBackend, NetworkLink } from "./backend.js";
import { untrackNetwork } from "./reaper/init.js";

/**
 * The subset of a running container `Network` needs in order to compute
 * links for a newly-joining sibling: its aliases, its exposed guest ports
 * mapped to host ports, and whether it is currently running (a stopped
 * container never gets linked to).
 */
export interface NetworkMember {
  /** Names this member answers to on the network. */
  readonly aliases: ReadonlyArray<string>;
  /** Whether this member is currently running (a stopped member is never linked to). */
  readonly isRunning: boolean;
  /** Guest ports this member has exposed. */
  readonly exposedGuestPorts: ReadonlyArray<number>;
  /** The host port bound to `guestPort`. */
  mappedPort(guestPort: number): number;
}

interface RegisteredMember {
  readonly member: NetworkMember;
}

/**
 * Alias-based connectivity between containers, on both backends. Docker
 * implements it with a native bridge network; msb — where each container is
 * a fully isolated microVM — emulates it with an `/etc/hosts` alias plus a
 * TCP relay over the sandbox's exec channel. `Network.resolve` returns the
 * same `"alias:port"` string either way, so code written against it doesn't
 * need to know which backend is active.
 *
 * Implements `Symbol.asyncDispose`, so `await using net = Network.newNetwork()`
 * tears the network down at scope exit alongside its member containers.
 */
export class Network implements AsyncDisposable {
  /** This network's process-unique id, `rz-net-<8hex>`. */
  readonly id: string;
  private readonly aliasPorts = new Map<string, Map<number, number>>();
  private readonly members: RegisteredMember[] = [];
  private lastBackend: SandboxBackend | undefined;

  private constructor(id: string) {
    this.id = id;
  }

  /** Creates a new network with a process-unique id (`rz-net-<8hex>`). Pass it to `withNetwork` on each member container. */
  static newNetwork(): Network {
    return new Network(`rz-net-${randomBytes(4).toString("hex")}`);
  }

  /** "alias:guestPort" for a registered (alias, guestPort) pair; throws naming the alias otherwise. */
  resolve(alias: string, guestPort: number): string {
    const ports = this.aliasPorts.get(alias);
    if (ports === undefined || !ports.has(guestPort)) {
      throw new Error(`no container registered on network '${this.id}' with alias '${alias}' exposing guest port ${guestPort}`);
    }
    return `${alias}:${guestPort}`;
  }

  /**
   * Links a newly-starting container needs installed toward every ALREADY
   * RUNNING sibling, computed before `register` runs — so a container can
   * never end up linked to itself, and only genuinely-running siblings
   * (never a half-started or already-stopped one) contribute links.
   */
  linksForNewMember(): ReadonlyArray<NetworkLink> {
    const links: NetworkLink[] = [];
    for (const { member } of this.members) {
      if (!member.isRunning) {
        continue;
      }
      for (const alias of member.aliases) {
        for (const guestPort of member.exposedGuestPorts) {
          links.push({ alias, guestPort, targetHostPort: member.mappedPort(guestPort) });
        }
      }
    }
    return links;
  }

  /**
   * Registers a container as a network member AFTER its links to existing
   * siblings were computed and installed — never before, or the ordering
   * that prevents self-links breaks.
   */
  register(member: NetworkMember, aliases: ReadonlyArray<string>, backend: SandboxBackend): void {
    this.lastBackend = backend;
    this.members.push({ member });
    for (const alias of aliases) {
      let ports = this.aliasPorts.get(alias);
      if (ports === undefined) {
        ports = new Map();
        this.aliasPorts.set(alias, ports);
      }
      for (const guestPort of member.exposedGuestPorts) {
        ports.set(guestPort, member.mappedPort(guestPort));
      }
    }
  }

  /** Removes the backend-native network. Best-effort: safe to call even if no member ever started. */
  async close(): Promise<void> {
    if (this.lastBackend !== undefined) {
      await this.lastBackend.removeNetwork(this.id);
    }
    await untrackNetwork(this.id);
  }

  /** `= close()`. What `await using net = Network.newNetwork()` calls at scope exit. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
