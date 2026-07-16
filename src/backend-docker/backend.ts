import { spawnSync } from "node:child_process";
import { BackendError, PortBindConflictError } from "../core/errors.js";
import type { BackendCapabilities, FollowHandle, NetworkLink, ReaperKillCommand, SandboxBackend, SandboxHandle } from "../core/backend.js";
import type { ContainerSpec, ExecResult } from "../core/model.js";
import { RunId } from "../core/run-id.js";
import { DockerClient } from "./client.js";
import { FrameDemuxer, LineAssembler } from "./frames.js";
import { extractIds, extractNumber, extractString } from "./json.js";
import { isPortBindConflictMessage } from "./port-conflict.js";
import { labelFilterQuery, containerLabels } from "./labels.js";
import { runDockerCli, DockerCli } from "./cli.js";

const STOP_TIMEOUT_SECS = 10;
// `docker cp` of a directory scales with its contents, not a fixed small
// payload like the other unary daemon calls this backend makes.
const COPY_TIMEOUT_MS = 120_000;

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

/** Builds the `POST /containers/create` JSON body: port bindings pinned to `127.0.0.1`, read-only/read-write binds, the `host.docker.internal` extra host, and the run-id (or reuse) label — see `containerLabels`. */
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
    Labels: containerLabels(spec),
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
  /** Shares the host kernel; can checkpoint a sandbox by committing it to an image, without disturbing the running container. */
  readonly capabilities: BackendCapabilities = {
    /** Containers share the host kernel — no microVM boundary. */
    hardwareIsolated: false,
    /** Commit-to-image checkpointing is available today. */
    checkpoint: true,
    /** Commit-to-image never touches the running container. */
    checkpointRestartsWorkload: false,
  };

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

  /**
   * Resolves a network NAME to its daemon-assigned id via a list filter,
   * never throwing — "not found" (an empty list, or the list call itself
   * failing) resolves to `undefined` rather than rejecting, since both
   * callers (`ensureNetworkGetId`'s create-if-missing path and
   * `removeNetwork`'s best-effort fallback) treat "not found" as their own
   * case rather than an error.
   */
  private async lookupNetworkIdByName(networkId: string): Promise<string | undefined> {
    const filters = JSON.stringify({ name: [networkId] });
    const listPath = `/networks?filters=${encodeQueryValue(filters)}`;
    const list = await this.client.request("GET", listPath).catch(() => undefined);
    if (list === undefined || list.status !== 200) {
      return undefined;
    }
    return extractIds(list.body.toString())[0];
  }

  private async ensureNetworkGetId(networkId: string): Promise<string> {
    const cached = this.networkIds.get(networkId);
    if (cached !== undefined) {
      return cached;
    }

    const found = await this.lookupNetworkIdByName(networkId);
    if (found !== undefined) {
      this.networkIds.set(networkId, found);
      return found;
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

  /**
   * Checkpoint's backend call: the engine's `POST /commit` endpoint, which
   * commits a container's current filesystem to a new image in one call —
   * `ref` is always `rightsize/checkpoint:<12-hex>` (minted by
   * `GenericContainer.checkpoint()`), split into repo/tag the same way
   * `pullIfMissing`'s image argument is. The container itself is undisturbed.
   */
  async createCheckpoint(handle: SandboxHandle, ref: string): Promise<void> {
    const [repo, tag] = splitRepoTag(ref);
    const path = `/commit?container=${encodeQueryValue(handle.id)}&repo=${encodeQueryValue(repo)}&tag=${encodeQueryValue(tag)}`;
    const resp = await this.client.request("POST", path);
    if (resp.status >= 400) {
      throw new BackendError(
        `docker could not commit container ${handle.id} to image '${ref}' (HTTP ${resp.status}): ${resp.body.toString()}`,
      );
    }
  }

  /** Best-effort `DELETE /images/{ref}` — "not found" is success, the same contract as `removeByName`. */
  async removeCheckpoint(ref: string): Promise<void> {
    await this.client.request("DELETE", `/images/${encodeQueryValue(ref)}`).catch(() => {});
  }

  /**
   * `GET /images/{ref}/json` — the same inspect call `pullIfMissing` makes
   * for an ordinary image reference. `200` means the image is there, `404`
   * means it definitely isn't; any other status (daemon unreachable,
   * malformed ref) is a probe failure and throws rather than reporting a
   * silent `false` — see the SPI's own "no best-effort false" contract.
   */
  async hasCheckpoint(ref: string): Promise<boolean> {
    const resp = await this.client.request("GET", `/images/${encodeQueryValue(ref)}/json`);
    if (resp.status === 200) {
      return true;
    }
    if (resp.status === 404) {
      return false;
    }
    throw new BackendError(`docker could not inspect image '${ref}' (HTTP ${resp.status}): ${resp.body.toString()}`);
  }

  /**
   * Best-effort stop+remove of a container identified by NAME — the shape
   * the reaping ledger and sweep need, since they only ever store names,
   * never a daemon-assigned id. Resolves name to id via a list filter
   * first (this backend's `SandboxHandle.id` is always the daemon id, never
   * the name, so there is no shortcut around this lookup); `^/<name>$`
   * anchors the filter to an EXACT match — Docker's name filter is
   * substring-by-default, and an unanchored filter for `rz-abc123-1` would
   * also match `rz-abc123-10`. "Not found" (an empty list, or the list
   * call itself failing) is silently fine.
   */
  async removeByName(name: string): Promise<void> {
    const filters = JSON.stringify({ name: [`^/${name}$`] });
    const listPath = `/containers/json?all=true&filters=${encodeQueryValue(filters)}`;
    const listed = await this.client.request("GET", listPath).catch(() => undefined);
    if (listed === undefined || listed.status !== 200) {
      return;
    }
    const id = extractIds(listed.body.toString())[0];
    if (id === undefined) {
      return;
    }
    await this.client.request("DELETE", `/containers/${id}?force=true`).catch(() => {});
  }

  /**
   * Reuse's adopt-path liveness check: resolves `spec.name` to a daemon id
   * via the same exact-match name filter `removeByName` uses, but restricted
   * to RUNNING containers only (no `all=true`, matching this method's
   * "found and running" contract) — a stopped-but-not-yet-removed container
   * of the same name must never be handed back as adoptable. Not found (or
   * the list call itself failing) resolves to `undefined`.
   */
  async findRunning(spec: ContainerSpec): Promise<SandboxHandle | undefined> {
    const filters = JSON.stringify({ name: [`^/${spec.name}$`] });
    const listPath = `/containers/json?filters=${encodeQueryValue(filters)}`;
    const listed = await this.client.request("GET", listPath).catch(() => undefined);
    if (listed === undefined || listed.status !== 200) {
      return undefined;
    }
    const id = extractIds(listed.body.toString())[0];
    if (id === undefined) {
      return undefined;
    }
    return { id, spec };
  }

  /** The reaper watchdog's kill-command prefixes: `docker rm -f` does both stop and remove in one call, so `stop` is empty. */
  async reaperKillCommand(): Promise<ReaperKillCommand> {
    return { stop: [], remove: ["docker", "rm", "-f"], removeNetwork: ["docker", "network", "rm"] };
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

  /**
   * `docker cp <hostPath> <id>:<containerPath>` — the transfer only;
   * `GenericContainer.copyFileToContainer()` already confirmed the
   * container is running, validated the absolute path, and ran the
   * guest-side `mkdir -p` before this is ever called. Shells out rather
   * than hand-rolling tar encoding against the daemon's raw `PUT
   * /containers/{id}/archive` endpoint — see `cli.ts`'s own doc on why that
   * isn't a new dependency here. A nonzero exit surfaces the tool's own
   * stderr rather than a silent success.
   */
  async copyToContainer(handle: SandboxHandle, hostPath: string, containerPath: string): Promise<void> {
    const result = await runDockerCli(DockerCli.copyIn(hostPath, handle.id, containerPath), COPY_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      throw new BackendError(
        `docker cp into ${handle.id}:${containerPath} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  /** The reverse direction of `copyToContainer` — see its own doc. */
  async copyFromContainer(handle: SandboxHandle, containerPath: string, hostPath: string): Promise<void> {
    const result = await runDockerCli(DockerCli.copyOut(handle.id, containerPath, hostPath), COPY_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      throw new BackendError(
        `docker cp from ${handle.id}:${containerPath} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  async ensureNetwork(networkId: string): Promise<void> {
    await this.ensureNetworkGetId(networkId);
  }

  /**
   * Resolves the network's daemon id from this instance's own cache when
   * available (the common case: this process created the network earlier in
   * its own lifetime), but falls back to the same by-name daemon lookup
   * `ensureNetworkGetId` uses when it isn't — the reaper sweep and watchdog
   * both call this through a FRESH `DockerBackend` instance that never
   * itself called `ensureNetwork` for a network some other (possibly dead)
   * process created, so an in-memory-cache-only lookup would silently no-op
   * every cross-process reap. "Not found" is silently fine either way.
   */
  async removeNetwork(networkId: string): Promise<void> {
    const daemonId = this.networkIds.get(networkId) ?? (await this.lookupNetworkIdByName(networkId));
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
