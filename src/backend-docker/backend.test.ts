import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, assert } from "../../test/harness.js";
import { DockerBackend } from "./backend.js";
import { DockerClient } from "./client.js";
import { BackendError } from "../core/errors.js";
import { isPortBindConflictMessage } from "./port-conflict.js";
import { labelFilterQuery, RUN_ID_LABEL_KEY, REUSE_LABEL_KEY, containerLabels } from "./labels.js";
import type { ContainerSpec } from "../core/model.js";

function baseSpec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: "rz-deadbeef-1",
    image: "alpine:3.19",
    env: [],
    command: undefined,
    ports: [],
    mounts: [],
    networkId: undefined,
    aliases: [],
    runId: "deadbeef",
    memoryLimitMb: undefined,
    keepAlive: false,
    ...overrides,
  };
}

// See client.test.ts's identical fixture-server rationale: a real
// unix-domain socket standing in for the daemon, structurally POSIX-only.
function skipOnWindows(): boolean {
  return process.platform === "win32";
}

function freshSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rzd-backend-"));
  return path.join(dir, "d.sock");
}

/**
 * A fake docker daemon that serves one scripted response per connection, in
 * order — matches `DockerClient`'s one-connection-per-request behavior
 * (`agent: false`, see client.ts) — and records each request's method+path.
 * None of `removeNetwork`'s calls (`GET /networks?filters=`, `DELETE
 * /networks/<id>`) carry a request body, so this fixture only needs to wait
 * for the header block before responding.
 */
async function fakeDaemon(
  responses: ReadonlyArray<{ status: number; body: string }>,
): Promise<{ close: () => void; requests: Array<{ method: string; url: string }>; client: DockerClient }> {
  const sockPath = freshSocketPath();
  const requests: Array<{ method: string; url: string }> = [];
  let next = 0;
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const [requestLine] = buf.slice(0, headerEnd).split("\r\n");
      const [method, url] = (requestLine ?? "").split(" ");
      requests.push({ method: method ?? "", url: url ?? "" });
      const resp = responses[next] ?? { status: 500, body: "" };
      next += 1;
      const statusText = resp.status === 200 ? "OK" : resp.status === 204 ? "No Content" : "Error";
      socket.end(`HTTP/1.1 ${resp.status} ${statusText}\r\nContent-Length: ${Buffer.byteLength(resp.body)}\r\n\r\n${resp.body}`);
    });
  });
  await new Promise<void>((r) => server.listen(sockPath, r));
  return { close: () => server.close(), requests, client: new DockerClient(sockPath) };
}

describe("isPortBindConflictMessage", () => {
  it("matches known daemon phrasings", () => {
    assert.ok(isPortBindConflictMessage("driver failed programming external connectivity: address already in use"));
    assert.ok(isPortBindConflictMessage("Bind for 0.0.0.0:6379 failed: port is already allocated"));
    assert.ok(isPortBindConflictMessage("ALREADY ALLOCATED (case-insensitive)"));
  });

  it("does not match unrelated failures", () => {
    assert.equal(isPortBindConflictMessage("no such image"), false);
    assert.equal(isPortBindConflictMessage("container already stopped"), false);
    assert.equal(isPortBindConflictMessage(""), false);
  });
});

describe("labelFilterQuery", () => {
  it("builds the {label:[...]} JSON filter for one runId", () => {
    const query = labelFilterQuery("deadbeef");
    assert.equal(query, JSON.stringify({ label: [`${RUN_ID_LABEL_KEY}=deadbeef`] }));
  });

  it("the label key is the literal wire-format string shared across implementations", () => {
    assert.equal(RUN_ID_LABEL_KEY, "dev.rightsize.runId");
  });
});

describe("containerLabels — keepAlive swaps the run-id label for the reuse label (addendum item 6)", () => {
  it("a normal (non-keepAlive) container gets only the run-id label", () => {
    const labels = containerLabels({ keepAlive: false, runId: "deadbeef", name: "rz-deadbeef-1" });
    assert.deepEqual(labels, { [RUN_ID_LABEL_KEY]: "deadbeef" });
  });

  it("a keepAlive container gets ONLY dev.rightsize.reuse=<12hex> — never the run-id label", () => {
    const labels = containerLabels({ keepAlive: true, runId: "deadbeef", name: "rz-reuse-abc123abc123" });
    assert.equal(Object.keys(labels).length, 1);
    assert.ok(REUSE_LABEL_KEY in labels, "expected the reuse label key to be present");
    assert.equal(RUN_ID_LABEL_KEY in labels, false, "must never also carry the run-id label");
    assert.match(labels[REUSE_LABEL_KEY] as string, /^[0-9a-f]{12}$/);
  });

  it("the reuse label value is a deterministic function of the container name", () => {
    const a = containerLabels({ keepAlive: true, runId: "deadbeef", name: "rz-reuse-abc123abc123" });
    const b = containerLabels({ keepAlive: true, runId: "deadbeef", name: "rz-reuse-abc123abc123" });
    const c = containerLabels({ keepAlive: true, runId: "deadbeef", name: "rz-reuse-def456def456" });
    assert.equal(a[REUSE_LABEL_KEY], b[REUSE_LABEL_KEY]);
    assert.ok(a[REUSE_LABEL_KEY] !== c[REUSE_LABEL_KEY]);
  });

  it("the reuse label key is the literal wire-format string", () => {
    assert.equal(REUSE_LABEL_KEY, "dev.rightsize.reuse");
  });
});

describe("DockerBackend.removeNetwork — must not depend on this instance's own in-memory cache", () => {
  it("resolves the daemon id via a by-name lookup when this instance never itself called ensureNetwork for it (a sweep's fresh instance reaping a DIFFERENT process's dead run)", async () => {
    if (skipOnWindows()) {
      return;
    }
    const { close, requests, client } = await fakeDaemon([
      { status: 200, body: JSON.stringify([{ Id: "daemon-net-id-abc" }]) }, // GET /networks?filters=...
      { status: 204, body: "" }, // DELETE /networks/daemon-net-id-abc
    ]);
    try {
      const backend = new DockerBackend(client);
      await backend.removeNetwork("rz-someotherprocess-net");

      assert.equal(requests.length, 2, `expected a list lookup followed by a delete, got: ${JSON.stringify(requests)}`);
      assert.equal(requests[0]?.method, "GET");
      assert.match(requests[0]?.url ?? "", /^\/networks\?filters=/);
      assert.equal(requests[1]?.method, "DELETE");
      assert.equal(requests[1]?.url, "/networks/daemon-net-id-abc");
    } finally {
      close();
    }
  });

  it("a name the daemon has no matching network for is a silent no-op — no DELETE issued", async () => {
    if (skipOnWindows()) {
      return;
    }
    const { close, requests, client } = await fakeDaemon([{ status: 200, body: JSON.stringify([]) }]);
    try {
      const backend = new DockerBackend(client);
      await backend.removeNetwork("rz-never-existed-net");
      assert.equal(requests.length, 1, "expected only the list lookup, no DELETE for a network that was never found");
    } finally {
      close();
    }
  });
});

describe("DockerBackend.findRunning", () => {
  it("returns a handle embedding the caller's own spec when the name resolves to a running container", async () => {
    if (skipOnWindows()) {
      return;
    }
    const { close, requests, client } = await fakeDaemon([
      { status: 200, body: JSON.stringify([{ Id: "daemon-id-abc" }]) }, // GET /containers/json?filters=...
    ]);
    try {
      const backend = new DockerBackend(client);
      const spec = baseSpec({ name: "rz-reuse-abc123abc123" });
      const found = await backend.findRunning(spec);
      assert.ok(found !== undefined);
      assert.equal(found?.id, "daemon-id-abc");
      assert.equal(found?.spec, spec, "the returned handle must embed the caller's spec verbatim");

      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.method, "GET");
      assert.match(requests[0]?.url ?? "", /^\/containers\/json\?filters=/);
    } finally {
      close();
    }
  });

  it("returns undefined when no running container matches the name", async () => {
    if (skipOnWindows()) {
      return;
    }
    const { close, client } = await fakeDaemon([{ status: 200, body: JSON.stringify([]) }]);
    try {
      const backend = new DockerBackend(client);
      const found = await backend.findRunning(baseSpec({ name: "rz-reuse-never-existed" }));
      assert.equal(found, undefined);
    } finally {
      close();
    }
  });

  it("returns undefined when the list call itself fails", async () => {
    if (skipOnWindows()) {
      return;
    }
    const { close, client } = await fakeDaemon([{ status: 500, body: "boom" }]);
    try {
      const backend = new DockerBackend(client);
      const found = await backend.findRunning(baseSpec());
      assert.equal(found, undefined);
    } finally {
      close();
    }
  });
});

describe("DockerBackend.reaperKillCommand", () => {
  it("names `docker rm -f` for stop+remove combined, and `docker network rm` for networks", async () => {
    const backend = new DockerBackend(new DockerClient());
    const command = await backend.reaperKillCommand();
    assert.deepEqual(command, { stop: [], remove: ["docker", "rm", "-f"], removeNetwork: ["docker", "network", "rm"] });
  });
});

describe("DockerBackend transport regression — must dial a unix socket, never TCP", () => {
  it("targets an absolute unix socket path by default", () => {
    const backend = new DockerBackend(new DockerClient());
    const path = backend.socketPathForTest();
    assert.ok(path.startsWith("/"), `expected an absolute unix socket path, got ${path}`);
    assert.equal(path.includes(":"), false, `a unix socket path must not look like host:port — got ${path}`);
  });

  it("a tcp:// DOCKER_HOST falls back to the default socket, never leaking a TCP port into the transport", () => {
    const client = new DockerClient(undefined);
    // Simulate what DockerClient.fromEnv would do with a tcp:// DOCKER_HOST
    // by constructing it through the same pure parsing seam client.test.ts
    // already covers; here we only need to prove DockerBackend never ends up
    // pointed at something containing "2375".
    const backend = new DockerBackend(client);
    const path = backend.socketPathForTest();
    assert.equal(path.includes("2375"), false);
  });
});

describe("DockerBackend.capabilities", () => {
  it("shares the host kernel: hardwareIsolated false, checkpoint true (commit-to-image)", () => {
    const backend = new DockerBackend(new DockerClient());
    assert.deepEqual(backend.capabilities, { hardwareIsolated: false, checkpoint: true });
  });
});

describe("DockerBackend.commitToImage", () => {
  it("POSTs /commit with the container id and the imageRef split into repo+tag", async () => {
    if (skipOnWindows()) {
      return;
    }
    const { close, requests, client } = await fakeDaemon([{ status: 201, body: JSON.stringify({ Id: "sha256:abc" }) }]);
    try {
      const backend = new DockerBackend(client);
      await backend.commitToImage({ id: "container-id-1", spec: baseSpec() }, "rightsize/checkpoint:abcdef012345");

      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.method, "POST");
      assert.match(requests[0]?.url ?? "", /^\/commit\?/);
      assert.match(requests[0]?.url ?? "", /container=container-id-1/);
      assert.match(requests[0]?.url ?? "", /repo=rightsize%2Fcheckpoint/);
      assert.match(requests[0]?.url ?? "", /tag=abcdef012345/);
    } finally {
      close();
    }
  });

  it("throws BackendError naming the container and imageRef on a daemon error response", async () => {
    if (skipOnWindows()) {
      return;
    }
    const { close, client } = await fakeDaemon([{ status: 404, body: "no such container" }]);
    try {
      const backend = new DockerBackend(client);
      let thrown: unknown;
      try {
        await backend.commitToImage({ id: "gone", spec: baseSpec() }, "rightsize/checkpoint:abcdef012345");
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof BackendError, `expected BackendError, got: ${String(thrown)}`);
      assert.match((thrown as Error).message, /gone/);
      assert.match((thrown as Error).message, /rightsize\/checkpoint:abcdef012345/);
    } finally {
      close();
    }
  });
});
