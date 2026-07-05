import { describe, it, assert } from "../../test/harness.js";
import { FrameDemuxer, LineAssembler } from "./frames.js";

function frameBytes(streamType: number, payload: Buffer | string): Buffer {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(8);
  header.writeUInt8(streamType, 0);
  header.writeUInt32BE(p.length, 4);
  return Buffer.concat([header, p]);
}

describe("LineAssembler", () => {
  it("feed returns complete lines and buffers the trailing partial", () => {
    const a = new LineAssembler();
    assert.deepEqual(a.feed("line1\nline2\npart"), ["line1", "line2"]);
    assert.deepEqual(a.feed("ial\n"), ["partial"]);
  });

  it("a line straddling two frames reassembles", () => {
    const a = new LineAssembler();
    assert.deepEqual(a.feed("hello "), []);
    assert.deepEqual(a.feed("world\n"), ["hello world"]);
  });

  it("delivers a genuinely-empty interior line as real output, not as a dropped artifact", () => {
    const a = new LineAssembler();
    assert.deepEqual(a.feed("a\n\nb\n"), ["a", "", "b"]);
  });

  it("does not manufacture a phantom trailing empty line from a terminal newline", () => {
    const a = new LineAssembler();
    assert.deepEqual(a.feed("a\n"), ["a"]);
    assert.equal(a.flush(), undefined);
  });

  it("an interior empty line straddling separate feed() calls still comes through once", () => {
    const a = new LineAssembler();
    assert.deepEqual(a.feed("a\n"), ["a"]);
    assert.deepEqual(a.feed("\n"), [""]);
    assert.deepEqual(a.feed("b\n"), ["b"]);
  });

  it("a byte-at-a-time fragmented stream still reassembles", () => {
    const a = new LineAssembler();
    const completed: string[] = [];
    for (const byte of "ab\ncd\n") {
      completed.push(...a.feed(byte));
    }
    assert.deepEqual(completed, ["ab", "cd"]);
  });

  it("flush returns the final unterminated fragment exactly once", () => {
    const a = new LineAssembler();
    assert.deepEqual(a.feed("line1\ntrailing-no-newline"), ["line1"]);
    assert.equal(a.flush(), "trailing-no-newline");
    assert.equal(a.flush(), undefined, "a second flush must not re-deliver it");
  });

  it("flush on a stream that ended exactly on a newline yields nothing", () => {
    const a = new LineAssembler();
    assert.deepEqual(a.feed("line1\n"), ["line1"]);
    assert.equal(a.flush(), undefined);
  });

  it("flush on a stream with no input at all yields nothing", () => {
    const a = new LineAssembler();
    assert.equal(a.flush(), undefined);
  });

  it("feed after flush is harmless but flush stays at-most-once", () => {
    const a = new LineAssembler();
    a.feed("first-partial");
    assert.equal(a.flush(), "first-partial");
    a.feed("more\n");
    assert.equal(a.flush(), undefined);
  });
});

describe("FrameDemuxer", () => {
  it("routes stdout and stderr frames by stream type", () => {
    const d = new FrameDemuxer();
    const bytes = Buffer.concat([frameBytes(1, "out-line\n"), frameBytes(2, "err-line\n")]);
    const frames = d.push(bytes);
    assert.deepEqual(
      frames.map((f) => [f.streamType, f.payload.toString()]),
      [
        ["stdout", "out-line\n"],
        ["stderr", "err-line\n"],
      ],
    );
  });

  it("a frame straddling two Buffer chunks reassembles", () => {
    const d = new FrameDemuxer();
    const whole = frameBytes(1, "hello-across-frames");
    const first = whole.subarray(0, 3);
    const second = whole.subarray(3);
    assert.deepEqual(d.push(first), []);
    const frames = d.push(second);
    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.streamType, "stdout");
    assert.equal(frames[0]?.payload.toString(), "hello-across-frames");
  });

  it("empty-payload frames are handled", () => {
    const d = new FrameDemuxer();
    const bytes = Buffer.concat([frameBytes(1, ""), frameBytes(1, "after-empty\n")]);
    const frames = d.push(bytes);
    assert.deepEqual(
      frames.map((f) => [f.streamType, f.payload.toString()]),
      [
        ["stdout", ""],
        ["stdout", "after-empty\n"],
      ],
    );
  });

  it("a byte-at-a-time fragmented stream still reassembles a full frame", () => {
    const d = new FrameDemuxer();
    const whole = frameBytes(1, "byte-at-a-time");
    const collected: { streamType: string; payload: Buffer }[] = [];
    for (let i = 0; i < whole.length; i++) {
      collected.push(...d.push(whole.subarray(i, i + 1)));
    }
    assert.equal(collected.length, 1);
    assert.equal(collected[0]?.payload.toString(), "byte-at-a-time");
  });

  it("multiple frames arriving in one chunk are all yielded", () => {
    const d = new FrameDemuxer();
    const bytes = Buffer.concat([frameBytes(1, "a"), frameBytes(1, "b"), frameBytes(2, "c")]);
    const frames = d.push(bytes);
    assert.deepEqual(
      frames.map((f) => f.payload.toString()),
      ["a", "b", "c"],
    );
  });
});
