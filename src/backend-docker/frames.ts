/**
 * The Docker daemon's log-stream multiplexing frame format, present whenever
 * a container is created without a TTY — this backend never allocates one,
 * so this is the only shape `exec`/`logs`/`followLogs` ever see:
 *
 *   frame   = header ++ payload
 *   header  = [ streamType: u8, 0u8, 0u8, 0u8, len: u32_be ]   (8 bytes)
 *   payload = [u8; len]
 *   streamType: 0 = stdin, 1 = stdout, 2 = stderr
 *
 * `FrameDemuxer` accepts arbitrary Buffer chunks — frames straddle chunk
 * boundaries with no relationship to how the daemon happened to flush its
 * write buffer — and buffers a partial header/payload across `push()` calls,
 * yielding only the frames a given chunk completes.
 */

export type StreamType = "stdin" | "stdout" | "stderr";

export interface Frame {
  readonly streamType: StreamType;
  readonly payload: Buffer;
}

function streamTypeFromByte(b: number): StreamType | undefined {
  switch (b) {
    case 0:
      return "stdin";
    case 1:
      return "stdout";
    case 2:
      return "stderr";
    default:
      return undefined;
  }
}

const HEADER_LEN = 8;

/** Stateful frame reassembler: feed it raw bytes as they arrive, get back every frame a call completes. */
export class FrameDemuxer {
  private buffered: Buffer = Buffer.alloc(0);

  /** Appends `chunk` to the pending buffer and returns every frame now fully available. */
  push(chunk: Buffer): Frame[] {
    this.buffered = this.buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffered, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      if (this.buffered.length < HEADER_LEN) {
        break;
      }
      const len = this.buffered.readUInt32BE(4);
      if (this.buffered.length < HEADER_LEN + len) {
        break;
      }
      const streamType = streamTypeFromByte(this.buffered.readUInt8(0));
      const payload = this.buffered.subarray(HEADER_LEN, HEADER_LEN + len);
      if (streamType !== undefined) {
        frames.push({ streamType, payload: Buffer.from(payload) });
      }
      // An unrecognized stream-type byte is dropped rather than throwing —
      // the frame's length prefix is still trustworthy, so skipping past it
      // cleanly (instead of aborting the whole stream) is the same
      // tolerant-of-drift posture as the msb ls-json scanner.
      this.buffered = this.buffered.subarray(HEADER_LEN + len);
    }
    return frames;
  }
}

/**
 * Reassembles complete lines out of a stream of text chunks whose
 * boundaries are a chunking artifact, not a line break. A single log line
 * can straddle two (or more) frames or Buffer reads with no relationship to
 * where the actual `\n` falls; `feed` buffers a trailing partial line across
 * calls and returns only the lines a given call completes. `flush` hands
 * back that trailing fragment once at stream end — idempotent, since a
 * terminal stream event (`end`/`close`) can legitimately fire more than once
 * for the same close.
 */
export class LineAssembler {
  private pending = "";
  private flushedOnce = false;

  feed(text: string): string[] {
    this.pending += text;
    if (!this.pending.includes("\n")) {
      return [];
    }
    const endsWithNewline = this.pending.endsWith("\n");
    const parts = this.pending.split("\n");
    // split("a\nb\n", "\n") => ["a","b",""] — the trailing "" is the
    // "nothing pending" marker when the chunk ended exactly on a newline;
    // split("a\nb", "\n") => ["a","b"], where "b" is genuinely pending.
    // Either way the last element is never a completed line.
    const tail = parts.pop() ?? "";
    this.pending = endsWithNewline ? "" : tail;
    // A genuinely-empty interior line (a blank line the workload printed) is
    // real output and must be delivered — do not filter it out. Only the
    // trailing "nothing pending" marker popped above is ever dropped; that's
    // handled by the pop(), not by filtering here. Mirrors msb's replay
    // contract in follow-replay.ts, so both backends agree on blank lines.
    return parts;
  }

  /** Returns the trailing unterminated fragment exactly once, or undefined if there was none (or this was already called). */
  flush(): string | undefined {
    if (this.flushedOnce) {
      return undefined;
    }
    this.flushedOnce = true;
    if (this.pending.length === 0) {
      return undefined;
    }
    const tail = this.pending;
    this.pending = "";
    return tail;
  }
}
