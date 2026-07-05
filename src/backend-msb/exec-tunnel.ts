import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import * as net from "node:net";
import { MsbCommands } from "./commands.js";
import type { NetworkLink } from "../core/backend.js";

const RESPAWN_BACKOFF_MS = 200;

// msb's host-port-publish proxy never propagates the target's own TCP
// close back to this host-side socket — a plain end/close on the
// target-to-guest direction therefore never arrives, and a connection would
// otherwise hold the tunnel open forever after its first exchange. Two
// separate idle windows, not one: a generous FIRST_BYTE_DEADLINE tolerates a
// slow-but-real cold response before any target byte has arrived, then the
// much tighter IDLE_WINDOW takes over once data starts flowing, where a gap
// that short really does mean this single client-speaks-first exchange is
// done. Collapsing these into one window either truncates slow cold
// responses (window too short) or wedges the tunnel on every idle target
// (window too long).
const FIRST_BYTE_DEADLINE_MS = 10_000;
const IDLE_WINDOW_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Reads exactly one byte from a stream, or returns undefined if the stream ended with none. */
function firstByte(stream: NodeJS.ReadableStream): Promise<number | undefined> {
  return new Promise((resolveByte) => {
    let settled = false;
    const finish = (value: number | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      stream.removeListener("readable", onReadable);
      stream.removeListener("end", onEnd);
      resolveByte(value);
    };
    const onReadable = (): void => {
      // No setEncoding() was ever called on this stream, so a non-null read
      // is always a Buffer, never a decoded string.
      const chunk = (stream as NodeJS.ReadableStream & { read(size?: number): Buffer | string | null }).read(1);
      if (chunk !== null && chunk.length > 0 && typeof chunk !== "string") {
        finish(chunk.readUInt8(0));
      }
    };
    const onEnd = (): void => finish(undefined);
    stream.on("readable", onReadable);
    stream.on("end", onEnd);
  });
}

/**
 * One `alias:guestPort` route into a consumer sandbox, bridged over `msb exec
 * --stream`. Single connection at a time; the in-guest `nc -l` listener is
 * respawned after each connection with backoff only when a respawn produced
 * no traffic at all (a busy no-traffic loop must not spin `msb exec` at full
 * speed; a connection that was actually served respawns immediately).
 * Client-speaks-first protocols only (HTTP is) — the guest's listener must
 * see a byte before this side opens the real target connection.
 */
export class ExecTunnel {
  private closed = false;
  private current: ChildProcessByStdio<Writable, Readable, null> | undefined;
  private readonly workerDone: Promise<void>;

  constructor(
    private readonly msbPath: string,
    private readonly sandboxName: string,
    private readonly link: NetworkLink,
  ) {
    this.workerDone = this.runWorker();
  }

  private async runWorker(): Promise<void> {
    while (!this.closed) {
      const served = await this.serveOneConnection().catch(() => false);
      if (!this.closed && !served) {
        await sleep(RESPAWN_BACKOFF_MS);
      }
    }
  }

  /** Returns true if a connection was actually relayed, so the worker only backs off on churn. */
  private async serveOneConnection(): Promise<boolean> {
    const args = MsbCommands.execStream(this.sandboxName, ["nc", "-l", "-p", String(this.link.guestPort)]);
    const child = spawn(this.msbPath, args, { stdio: ["pipe", "pipe", "ignore"] });
    this.current = child;
    try {
      const first = await firstByte(child.stdout);
      if (first === undefined) {
        // Listener exited without a client ever connecting: back off and respawn.
        return false;
      }

      const target = net.connect(this.link.targetHostPort, "127.0.0.1");
      target.setNoDelay(true);
      await new Promise<void>((resolveConnect, rejectConnect) => {
        target.once("connect", () => resolveConnect());
        target.once("error", rejectConnect);
      });

      const guestToTarget = (async (): Promise<void> => {
        target.write(Buffer.from([first]));
        await new Promise<void>((resolvePump) => {
          child.stdout.pipe(target, { end: false });
          child.stdout.once("end", () => resolvePump());
          child.stdout.once("error", () => resolvePump());
          target.once("error", () => resolvePump());
        });
      })();

      await this.pumpWithIdleTimeout(target, child.stdin);
      await Promise.race([guestToTarget, sleep(2000)]);
      target.destroy();
      return true;
    } finally {
      child.kill();
      this.current = undefined;
    }
  }

  /**
   * Raw, unbuffered relay from `target` into the guest's stdin, ending the
   * exchange on an idle-read timeout rather than waiting for a close msb's
   * proxy will never deliver. `FIRST_BYTE_DEADLINE_MS` applies until the
   * first byte of the response arrives; from then on the much shorter
   * `IDLE_WINDOW_MS` applies, matching the two-phase contract described at
   * the top of this file.
   */
  private pumpWithIdleTimeout(target: net.Socket, guestStdin: NodeJS.WritableStream): Promise<void> {
    return new Promise((resolvePump) => {
      let sawData = false;
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        target.removeAllListeners("data");
        target.removeAllListeners("timeout");
        target.removeAllListeners("end");
        target.removeAllListeners("error");
        resolvePump();
      };
      target.setTimeout(FIRST_BYTE_DEADLINE_MS);
      target.on("data", (chunk: Buffer) => {
        if (!sawData) {
          sawData = true;
          target.setTimeout(IDLE_WINDOW_MS);
        }
        try {
          guestStdin.write(chunk);
        } catch {
          finish();
        }
      });
      target.on("timeout", () => finish());
      target.on("end", () => finish());
      target.on("error", () => finish());
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.current?.kill();
    await Promise.race([this.workerDone, sleep(2000)]);
  }
}
