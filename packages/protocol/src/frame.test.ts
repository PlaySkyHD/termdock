import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, MAX_HEADER_BYTES, MAX_PAYLOAD_BYTES, ProtocolError } from "./frame.js";

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("encodeFrame / FrameDecoder", () => {
  it("roundtrips header and binary payload", () => {
    const payload = Uint8Array.from([0, 255, 27, 91, 72, 0x80, 10]);
    const header = { kind: "event", event: "session.output", text: "äö€" };
    const frames = new FrameDecoder().push(encodeFrame(header, payload));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.header).toEqual(header);
    expect(Array.from(frames[0]?.payload ?? [])).toEqual(Array.from(payload));
  });

  it("encodes the documented wire layout", () => {
    const bytes = encodeFrame({ a: 1 }, Uint8Array.from([7, 8]));
    expect(Array.from(bytes)).toEqual([
      ...[0, 0, 0, 7],
      ...Array.from(text('{"a":1}')),
      ...[0, 0, 0, 2],
      7,
      8,
    ]);
  });

  it("yields empty payload when none is given", () => {
    const [frame] = new FrameDecoder().push(encodeFrame({ a: 1 }));
    expect(frame?.payload).toBeInstanceOf(Uint8Array);
    expect(frame?.payload.length).toBe(0);
  });

  it("reassembles a frame split into two chunks", () => {
    const bytes = encodeFrame({ a: 1 }, Uint8Array.from([1, 2, 3]));
    const decoder = new FrameDecoder();
    expect(decoder.push(bytes.subarray(0, 6))).toEqual([]);
    const frames = decoder.push(bytes.subarray(6));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.header).toEqual({ a: 1 });
  });

  it("reassembles a frame fed byte by byte and emits it only at the last byte", () => {
    const bytes = encodeFrame({ a: "x" }, Uint8Array.from([9, 9, 9]));
    const decoder = new FrameDecoder();
    const seen = [];
    for (let i = 0; i < bytes.length; i++) {
      const frames = decoder.push(bytes.subarray(i, i + 1));
      if (i < bytes.length - 1) expect(frames).toEqual([]);
      seen.push(...frames);
    }
    expect(seen).toHaveLength(1);
    expect(Array.from(seen[0]?.payload ?? [])).toEqual([9, 9, 9]);
  });

  it("returns several frames from one chunk in order", () => {
    const chunk = concat(
      encodeFrame({ n: 1 }),
      encodeFrame({ n: 2 }, Uint8Array.from([5])),
      encodeFrame({ n: 3 }),
    );
    const frames = new FrameDecoder().push(chunk);
    expect(frames.map((f) => f.header)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(Array.from(frames[1]?.payload ?? [])).toEqual([5]);
  });

  it("does not alias the input chunk", () => {
    const bytes = encodeFrame({ a: 1 }, Uint8Array.from([1, 2]));
    const [frame] = new FrameDecoder().push(bytes);
    bytes.fill(0);
    expect(Array.from(frame?.payload ?? [])).toEqual([1, 2]);
  });

  it("accepts a payload of exactly 4 MiB", () => {
    const payload = new Uint8Array(MAX_PAYLOAD_BYTES).fill(1);
    const [frame] = new FrameDecoder().push(encodeFrame({ a: 1 }, payload));
    expect(frame?.payload.length).toBe(MAX_PAYLOAD_BYTES);
  });

  it("rejects a header length prefix above 1 MiB without waiting for the header", () => {
    const decoder = new FrameDecoder();
    expect(() => decoder.push(u32(MAX_HEADER_BYTES + 1))).toThrow(ProtocolError);
  });

  it("rejects a payload length prefix above 4 MiB", () => {
    const header = text('{"a":1}');
    const decoder = new FrameDecoder();
    expect(() => decoder.push(concat(u32(header.length), header, u32(MAX_PAYLOAD_BYTES + 1)))).toThrow(
      /payload/i,
    );
  });

  it("refuses to encode oversized header or payload", () => {
    expect(() => encodeFrame({ big: "x".repeat(MAX_HEADER_BYTES) })).toThrow(ProtocolError);
    expect(() => encodeFrame({ a: 1 }, new Uint8Array(MAX_PAYLOAD_BYTES + 1))).toThrow(ProtocolError);
  });

  it("rejects broken JSON with bad_request", () => {
    const header = text("{kaputt");
    const decoder = new FrameDecoder();
    try {
      decoder.push(concat(u32(header.length), header, u32(0)));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe("bad_request");
    }
  });

  it("rejects invalid UTF-8 and non-object headers", () => {
    const bad = Uint8Array.from([0xff, 0xfe]);
    expect(() => new FrameDecoder().push(concat(u32(2), bad, u32(0)))).toThrow(ProtocolError);
    for (const json of ["[1]", "42", "null", '"s"']) {
      const header = text(json);
      expect(() => new FrameDecoder().push(concat(u32(header.length), header, u32(0)))).toThrow(
        ProtocolError,
      );
    }
  });

  it("stays failed after a protocol error", () => {
    const decoder = new FrameDecoder();
    expect(() => decoder.push(u32(MAX_HEADER_BYTES + 1))).toThrow(ProtocolError);
    expect(() => decoder.push(encodeFrame({ a: 1 }))).toThrow(ProtocolError);
  });
});
