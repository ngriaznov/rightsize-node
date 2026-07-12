import { describe, it, assert } from "../../test/harness.js";
import { Network } from "./network.js";
import type { NetworkMember } from "./network.js";
import type { SandboxBackend } from "./backend.js";

function fakeMember(overrides: Partial<NetworkMember> = {}): NetworkMember {
  return {
    aliases: overrides.aliases ?? [],
    isRunning: overrides.isRunning ?? true,
    exposedGuestPorts: overrides.exposedGuestPorts ?? [],
    mappedPort: overrides.mappedPort ?? (() => {
      throw new Error("mappedPort not stubbed");
    }),
  };
}

function fakeBackend(onRemoveNetwork?: (id: string) => void): SandboxBackend {
  const notImplemented = (): never => {
    throw new Error("not implemented in this fake");
  };
  return {
    name: "fake",
    supportsNativeNetworks: true,
    capabilities: { hardwareIsolated: true, checkpoint: false },
    create: notImplemented,
    start: notImplemented,
    stop: notImplemented,
    remove: notImplemented,
    commitToImage: notImplemented,
    removeByName: notImplemented,
    findRunning: notImplemented,
    reaperKillCommand: notImplemented,
    exec: notImplemented,
    logs: notImplemented,
    followLogs: notImplemented,
    ensureNetwork: async () => {},
    removeNetwork: async (id: string) => {
      onRemoveNetwork?.(id);
    },
    installNetworkLinks: async () => {},
    close: async () => {},
    cleanupSync: () => {},
  };
}

describe("Network.newNetwork", () => {
  it("generates an id shaped rz-net-<8hex>", () => {
    const net = Network.newNetwork();
    assert.match(net.id, /^rz-net-[0-9a-f]{8}$/);
  });

  it("generates distinct ids across instances", () => {
    const a = Network.newNetwork();
    const b = Network.newNetwork();
    assert.ok(a.id !== b.id);
  });
});

describe("Network.resolve", () => {
  it("returns alias:port for a registered alias + guest port", () => {
    const net = Network.newNetwork();
    const member = fakeMember({ aliases: ["redis"], exposedGuestPorts: [6379], mappedPort: () => 54321 });
    net.register(member, ["redis"], fakeBackend());
    assert.equal(net.resolve("redis", 6379), "redis:6379");
  });

  it("throws naming the alias when unregistered", () => {
    const net = Network.newNetwork();
    try {
      net.resolve("ghost", 1234);
      assert.ok(false, "expected resolve to throw");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match((err as Error).message, /ghost/);
    }
  });
});

describe("Network.linksForNewMember", () => {
  it("produces one link per (alias, guestPort) of each running sibling", () => {
    const net = Network.newNetwork();
    const sibling = fakeMember({
      aliases: ["redis", "cache"],
      exposedGuestPorts: [6379, 6380],
      mappedPort: (guestPort) => (guestPort === 6379 ? 40001 : 40002),
    });
    net.register(sibling, ["redis", "cache"], fakeBackend());

    const links = net.linksForNewMember();
    assert.equal(links.length, 4);
    const asSet = new Set(links.map((l) => `${l.alias}:${l.guestPort}:${l.targetHostPort}`));
    assert.ok(asSet.has("redis:6379:40001"));
    assert.ok(asSet.has("redis:6380:40002"));
    assert.ok(asSet.has("cache:6379:40001"));
    assert.ok(asSet.has("cache:6380:40002"));
  });

  it("never links a container to itself: a single member sees no links, but is registered for a later joiner", () => {
    const net = Network.newNetwork();
    const solo = fakeMember({ aliases: ["only"], exposedGuestPorts: [80], mappedPort: () => 8080 });

    // Compute links BEFORE registering (this is the ordering start() must follow).
    const linksForSolo = net.linksForNewMember();
    assert.equal(linksForSolo.length, 0);
    net.register(solo, ["only"], fakeBackend());

    // A second joiner now sees the first as a running sibling.
    const linksForSecond = net.linksForNewMember();
    assert.equal(linksForSecond.length, 1);
    assert.equal(linksForSecond[0]?.alias, "only");
    assert.equal(linksForSecond[0]?.guestPort, 80);
    assert.equal(linksForSecond[0]?.targetHostPort, 8080);
  });

  it("skips a registered member that is not currently running", () => {
    const net = Network.newNetwork();
    const stopped = fakeMember({ aliases: ["gone"], exposedGuestPorts: [80], isRunning: false, mappedPort: () => 8080 });
    net.register(stopped, ["gone"], fakeBackend());
    assert.equal(net.linksForNewMember().length, 0);
  });
});

describe("Network async dispose", () => {
  it("await using calls close(), which removes the network on the backend", async () => {
    let removedId: string | undefined;
    const backend = fakeBackend((id) => {
      removedId = id;
    });
    let netId: string;
    {
      await using net = Network.newNetwork();
      netId = net.id;
      net.register(fakeMember(), [], backend);
    }
    assert.equal(removedId, netId);
  });
});
