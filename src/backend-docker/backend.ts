import { spawnSync } from "node:child_process";
import { BackendError, PortBindConflictError } from "../core/errors.js";
import type { FollowHandle, NetworkLink, SandboxBackend, SandboxHandle } from "../core/backend.js";
import type { ContainerSpec, ExecResult } from "../core/model.js";
import { RunId } from "../core/run-id.js";
import { DockerClient } from "./client.js";
import { FrameDemuxer, LineAssembler } from "./frames.js";
import { extractIds, extractNumber, extractString } from "./json.js";
import { isPortBindConflictMessage } from "./port-conflict.js";
import { labelFilterQuery, RUN_ID_LABEL_KEY } from "./labels.js";

const STOP_TIMEOUT_SECS = 10;

function encodeQueryValue(s: string): string {
  return encodeURIComponent(s);
}

/** `image` split into `[repository, tag]` for `POST /images/create?fromImage=&tag=`; a tag-less reference defaults to `latest`, matching Docker's own convention. */
function splitRepoTag(image: string): [string, string] {
  if (image.includes("@")) {
    return [image, ""];
  }
  // The tag separator is the LAST colon after the last slash, so a registry
  // host:port prefix (`localhost:5000/redis`) isn't mistaken for one.
  const slashIdx = image.lastIndexOf("/") + 1;
  const relColon = image.slice(slashIdx).lastIndexOf(":");
  if (relColon === -1) {
    return [image, "latest"];
  }
  const colon = slashIdx + relColon;
  return [image.slice(0, colon), image.slice(colon + 1)];
}

interface CreateContainerBody {
  Image: string;
  Env: string[];
  Cmd?: string[];
  ExposedPorts: Record<string, Record<string, never>>;
  Labels: Record<string, string>;
  HostConfig: {
    PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>>;
    Binds: string[];
    ExtraHosts: string[];
    Memory?: number;
  };
}

/** Builds the `POST /containers/create` JSON body: port bindings pinned to `127.0.0.1`, read-only/read-write binds, the `host.docker.internal` extra host, and the run-id label. */
function buildCreateBody(spec: ContainerSpec): CreateContainerBody {
  const exposedPorts: Record<string, Record<string, never>> = {};
  const portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  for (const p of spec.ports) {
    const key = `${p.guestPort}/tcp`;
    exposedPorts[key] = {};
    portBindings[key] = [{ HostIp: "127.0.0.1", HostPort: String(p.hostPort) }];
  }

  const binds = spec.mounts.map((m) => `${m.hostPath}:${m.guestPath}:${m.readOnly ? "ro" : "rw"}`);

  const body: CreateContainerBody = {
    Image: spec.image,
    Env: spec.env.map(([k, v]) => `${k}=${v}`),
    ExposedPorts: exposedPorts,
    Labels: { [RUN_ID_LABEL_KEY]: spec.runId },
    HostConfig: {
      PortBindings: portBindings,
      Binds: binds,
      ExtraHosts: ["host.docker.internal:host-gateway"],
    },
  };
  if (spec.command !== undefined) {
    body.Cmd = [...spec.command];
  }
  if (spec.memoryLimitMb !== undefined) {
    body.HostConfig.Memory = spec.memoryLimitMb * 1024 * 1024;
  }
  return body;
}

async function drainFrames(
  body: NodeJS.ReadableStream,
  onStdout: (payload: Buffer) => void,
  onStderr: (payload: Buffer) => void,
): Promise<void> {
  const demuxer = new FrameDemuxer();
  for await (const chunk of body) {
    const frames = demuxer.push(chunk as Buffer);
    for (const frame of frames) {
      if (frame.streamType === "stdout") {
        onStdout(frame.payload);
      } else if (frame.streamType === "stderr") {
        onStderr(frame.payload);
      }
    }
  }
}

/**
 * Drives the Docker daemon over `DockerClient`. This is also the
 * correctness oracle other backends are checked against, since Docker
 * enforces semantics (read-only mounts, native networks) microsandbox only
 * emulates.
 *
 * Unlike the msb backend, a `SandboxHandle` here carries no companion
 * mutable state keyed by id: every operation is a stateless HTTP call
 * against the daemon-assigned container id already on the handle, so
 * there's nothing to look up in a side table.
 */
export class DockerBackend implements SandboxBackend {
  /** `"docker"` — matched against `RIGHTSIZE_BACKEND`. */
  readonly name = "docker";
  readonly supportsNativeNetworks = true;

  private readonly networkIds = new Map<string, string>();

  constructor(private readonly client: DockerClient) {}

  /** Exposed for the transport regression test: the socket path this backend's client actually dials. */
  socketPathForTest(): string {
    return this.client.getSocketPath();
  }

  private async pullIfMissing(image: string): Promise<void> {
    const inspectPath = `/images/${encodeQueryValue(image)}/json`;
    const inspect = await this.client.request("GET", inspectPath);
    if (inspect.status === 200) {
      return;
    }
    const [repo, tag] = splitRepoTag(image);
    const pullPath = `/images/create?fromImage=${encodeQueryValue(repo)}&tag=${encodeQueryValue(tag)}`;
    const resp = await this.client.request("POST", pullPath);
    if (resp.status >= 400) {
      throw new BackendError(`docker could not pull image '${image}' (HTTP ${resp.status}): ${resp.body.toString()}`);
    }
  }

  private async connectNetwork(containerId: string, networkId: string, aliases: ReadonlyArray<string>): Promise<void> {
    const body = JSON.stringify({ Container: containerId, EndpointConfig: { Aliases: [...aliases] } });
    const path = `/networks/${networkId}/connect`;
    const resp = await this.client.request("POST", path, body);
    if (resp.status >= 400) {
      throw new BackendError(
        `docker could not connect container ${containerId} to network ${networkId} (HTTP ${resp.status}): ${resp.body.toString()}`,
      );
    }
  }

  private async ensureNetworkGetId(networkId: string): Promise<string> {
    const cached = this.networkIds.get(networkId);
    if (cached !== undefined) {
      return cached;
    }

    const filters = JSON.stringify({ name: [networkId] });
    const listPath = `/networks?filters=${encodeQueryValue(filters)}`;
    const list = await this.client.request("GET", listPath);
    if (list.status === 200) {
      const ids = extractIds(list.body.toString());
      if (ids.length > 0 && ids[0] !== undefined) {
        this.networkIds.set(networkId, ids[0]);
        return ids[0];
      }
    }

    const createBody = JSON.stringify({ Name: networkId });
    const created = await this.client.request("POST", "/networks/create", createBody);
    if (created.status >= 400) {
      throw new BackendError(
        `docker could not create network '${networkId}' (HTTP ${created.status}): ${created.body.toString()}`,
      );
    }
    const id = extractString(created.body.toString(), "Id");
    if (id === undefined) {
      throw new BackendError(
        `docker's network-create response for '${networkId}' had no Id field (body: ${created.body.toString()})`,
      );
    }
    this.networkIds.set(networkId, id);
    return id;
  }

  async create(spec: ContainerSpec): Promise<SandboxHandle> {
    await this.pullIfMissing(spec.image);

    const body = JSON.stringify(buildCreateBody(spec));
    const path = `/containers/create?name=${encodeQueryValue(spec.name)}`;
    const resp = await this.client.request("POST", path, body);
    if (resp.status >= 400) {
      throw new BackendError(
        `docker could not create container '${spec.name}' (HTTP ${resp.status}): ${resp.body.toString()}`,
      );
    }
    const id = extractString(resp.body.toString(), "Id");
    if (id === undefined) {
      throw new BackendError(
        `docker's container-create response for '${spec.name}' had no Id field (body: ${resp.body.toString()})`,
      );
    }

    if (spec.networkId !== undefined) {
      const daemonNetworkId = await this.ensureNetworkGetId(spec.networkId);
      await this.connectNetwork(id, daemonNetworkId, spec.aliases);
    }

    return { id, spec };
  }

  async start(handle: SandboxHandle): Promise<void> {
    const path = `/containers/${handle.id}/start`;
    const resp = await this.client.request("POST", path);
    if (resp.status === 204 || resp.status === 304) {
      return; // 304 = already started; treated as success like the daemon intends.
    }
    const message = resp.body.toString();
    if (resp.status === 500 && isPortBindConflictMessage(message)) {
      throw new PortBindConflictError(`docker could not bind a host port for ${handle.id}: ${message}`);
    }
    throw new BackendError(`docker could not start container ${handle.id} (HTTP ${resp.status}): ${message}`);
  }

  async stop(handle: SandboxHandle): Promise<void> {
    const path = `/containers/${handle.id}/stop?t=${STOP_TIMEOUT_SECS}`;
    await this.client.request("POST", path).catch(() => {}); // best-effort
  }

  async remove(handle: SandboxHandle): Promise<void> {
    const path = `/containers/${handle.id}?force=true`;
    await this.client.request("DELETE", path).catch(() => {}); // best-effort
  }

  async exec(handle: SandboxHandle, cmd: ReadonlyArray<string>): Promise<ExecResult> {
    const createBody = JSON.stringify({ AttachStdout: true, AttachStderr: true, Cmd: [...cmd] });
    const createPath = `/containers/${handle.id}/exec`;
    const created = await this.client.request("POST", createPath, createBody);
    if (created.status >= 400) {
      throw new BackendError(
        `docker could not create an exec for container ${handle.id} (HTTP ${created.status}): ${created.body.toString()}`,
      );
    }
    const execId = extractString(created.body.toString(), "Id");
    if (execId === undefined) {
      throw new BackendError(
        `docker's exec-create response for container ${handle.id} had no Id field (body: ${created.body.toString()})`,
      );
    }

    const startPath = `/exec/${execId}/start`;
    const startBody = JSON.stringify({ Detach: false });
    const { status, body } = await this.client.requestStream("POST", startPath, startBody);
    if (status >= 400) {
      throw new BackendError(`docker could not start exec ${execId} for container ${handle.id} (HTTP ${status})`);
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    await drainFrames(
      body,
      (p) => stdoutChunks.push(p),
      (p) => stderrChunks.push(p),
    );

    const inspectPath = `/exec/${execId}/json`;
    const inspected = await this.client.request("GET", inspectPath);
    const exitCode = extractNumber(inspected.body.toString(), "ExitCode") ?? -1;

    return {
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString(),
      stderr: Buffer.concat(stderrChunks).toString(),
    };
  }

  async logs(handle: SandboxHandle): Promise<string> {
    const path = `/containers/${handle.id}/logs?stdout=1&stderr=1&tail=1000`;
    const { status, body } = await this.client.requestStream("GET", path);
    if (status >= 400) {
      throw new BackendError(`docker could not fetch logs for container ${handle.id} (HTTP ${status})`);
    }
    const assembler = new LineAssembler();
    let out = "";
    await drainFrames(
      body,
      (p) => {
        for (const line of assembler.feed(p.toString())) {
          out += line + "\n";
        }
      },
      (p) => {
        for (const line of assembler.feed(p.toString())) {
          out += line + "\n";
        }
      },
    );
    const tail = assembler.flush();
    if (tail !== undefined) {
      out += tail + "\n";
    }
    return out;
  }

  /** Docker's stream ends cleanly on its own once the workload stops — unlike msb's `logs -f`, so no watchdog is needed here. */
  async followLogs(handle: SandboxHandle, consumer: (line: string) => void): Promise<FollowHandle> {
    const path = `/containers/${handle.id}/logs?stdout=1&stderr=1&follow=1&tail=all`;
    const { status, body } = await this.client.requestStream("GET", path);
    if (status >= 400) {
      throw new BackendError(`docker could not follow logs for container ${handle.id} (HTTP ${status})`);
    }

    let closeRequested = false;
    const demuxer = new FrameDemuxer();
    const assembler = new LineAssembler();
    const readerDone = (async (): Promise<void> => {
      try {
        for await (const chunk of body) {
          if (closeRequested) {
            return;
          }
          for (const frame of demuxer.push(chunk as Buffer)) {
            if (frame.streamType !== "stdout" && frame.streamType !== "stderr") {
              continue;
            }
            for (const line of assembler.feed(frame.payload.toString())) {
              if (closeRequested) {
                return;
              }
              consumer(line);
            }
          }
        }
      } catch {
        // Best-effort: a stream error just ends delivery.
        return;
      }
      if (closeRequested) {
        return; // stop delivery, never flush — an explicit close beat the stream to its own end.
      }
      const tail = assembler.flush();
      if (tail !== undefined) {
        consumer(tail);
      }
    })();

    return {
      close: async (): Promise<void> => {
        closeRequested = true;
        body.destroy();
        await readerDone.catch(() => {});
      },
    };
  }

  /** No-op: docker relies entirely on native networks (`ensureNetwork`/`create`'s connect step) — there is nothing to emulate here, unlike msb's exec-tunnel links. */
  async installNetworkLinks(_handle: SandboxHandle, _links: ReadonlyArray<NetworkLink>): Promise<void> {}

  async ensureNetwork(networkId: string): Promise<void> {
    await this.ensureNetworkGetId(networkId);
  }

  async removeNetwork(networkId: string): Promise<void> {
    const daemonId = this.networkIds.get(networkId);
    this.networkIds.delete(networkId);
    if (daemonId !== undefined) {
      await this.client.request("DELETE", `/networks/${daemonId}`).catch(() => {}); // best-effort
    }
  }

  /** Removes every container carrying this run's label — the reaper safety net's normal-exit counterpart. */
  async close(): Promise<void> {
    const filters = labelFilterQuery(RunId.value);
    const path = `/containers/json?all=true&filters=${encodeQueryValue(filters)}`;
    const listed = await this.client.request("GET", path).catch(() => undefined);
    if (listed === undefined || listed.status !== 200) {
      return; // best-effort: nothing more to do if even listing fails.
    }
    const ids = extractIds(listed.body.toString());
    for (const id of ids) {
      await this.client.request("DELETE", `/containers/${id}?force=true`).catch(() => {});
    }
  }

  /**
   * Synchronous, blocking teardown for the process-exit path. Node has no
   * synchronous HTTP client, so this shells out to `curl --unix-socket` via
   * `child_process.spawnSync` — curl ships on macOS and virtually every
   * Linux CI image, and `spawnSync` genuinely blocks the exiting process the
   * way the `"exit"` handler requires. If curl is unavailable, this is a
   * silent no-op: the label-scoped orphan reaper each backend runs at
   * startup (`close()`'s own reaping plus the next run's sweep) is the real
   * safety net for that case, not this best-effort fast path.
   */
  cleanupSync(id: string): void {
    const socketPath = this.client.getSocketPath();
    try {
      spawnSync("curl", [
        "--silent",
        "--max-time",
        "5",
        "--unix-socket",
        socketPath,
        "-X",
        "DELETE",
        `http://localhost/containers/${id}?force=true`,
      ]);
    } catch {
      // Best-effort — see the doc above.
    }
  }
}
