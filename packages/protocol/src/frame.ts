// Frame codec (ADR 0002): uint32 BE header length | header (UTF-8 JSON object) | uint32 BE payload length | payload.
// Pure logic on Uint8Array: no Node APIs, so it also runs in the Electron preload and renderer.

import type { ErrorCode } from "./model.js";

export const MAX_HEADER_BYTES = 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

const LENGTH_PREFIX_BYTES = 4;

/** Violation of the wire format. The connection must be closed after it. */
export class ProtocolError extends Error {
  readonly code: ErrorCode;

  constructor(message: string, code: ErrorCode = "bad_request") {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

export interface Frame {
  /** Parsed header; always a JSON object. Shape is checked by the guards, not here. */
  header: unknown;
  payload: Uint8Array;
}

const encoder = new TextEncoder();

export function encodeFrame(header: unknown, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const json = JSON.stringify(header);
  if (typeof json !== "string") throw new ProtocolError("Header is not JSON-serializable");
  const headerBytes = encoder.encode(json);
  if (headerBytes.length > MAX_HEADER_BYTES) {
    throw new ProtocolError(`Header is ${headerBytes.length} bytes, maximum is ${MAX_HEADER_BYTES}`);
  }
  if (payload.length > MAX_PAYLOAD_BYTES) {
    throw new ProtocolError(`Payload is ${payload.length} bytes, maximum is ${MAX_PAYLOAD_BYTES}`);
  }
  const out = new Uint8Array(LENGTH_PREFIX_BYTES + headerBytes.length + LENGTH_PREFIX_BYTES + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, headerBytes.length, false);
  out.set(headerBytes, LENGTH_PREFIX_BYTES);
  const payloadLengthAt = LENGTH_PREFIX_BYTES + headerBytes.length;
  view.setUint32(payloadLengthAt, payload.length, false);
  out.set(payload, payloadLengthAt + LENGTH_PREFIX_BYTES);
  return out;
}

type Stage = "headerLength" | "header" | "payloadLength" | "payload";

/**
 * Streaming decoder. Feed arbitrary chunks with push(); it returns the frames completed by that chunk.
 * Each stage fills one buffer of exactly the needed size, so byte-wise input stays linear.
 * After a ProtocolError the decoder is spent and rejects further input.
 */
export class FrameDecoder {
  private stage: Stage = "headerLength";
  private buffer = new Uint8Array(LENGTH_PREFIX_BYTES);
  private filled = 0;
  private header: unknown;
  private failure: ProtocolError | undefined;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  push(chunk: Uint8Array): Frame[] {
    if (this.failure) throw this.failure;
    const frames: Frame[] = [];
    try {
      let offset = 0;
      // A zero-length stage completes without input, so the loop also runs when the chunk is used up.
      for (;;) {
        const take = Math.min(this.buffer.length - this.filled, chunk.length - offset);
        this.buffer.set(chunk.subarray(offset, offset + take), this.filled);
        this.filled += take;
        offset += take;
        if (this.filled < this.buffer.length) break;
        const frame = this.completeStage();
        if (frame) frames.push(frame);
        if (offset >= chunk.length && this.buffer.length > 0) break;
      }
    } catch (error) {
      this.failure = error instanceof ProtocolError ? error : new ProtocolError("Frame could not be decoded");
      // Frames completed before the error are still delivered; the error surfaces on the next push().
      if (frames.length > 0) return frames;
      throw this.failure;
    }
    return frames;
  }

  private completeStage(): Frame | undefined {
    switch (this.stage) {
      case "headerLength": {
        const length = new DataView(this.buffer.buffer).getUint32(0, false);
        if (length > MAX_HEADER_BYTES) {
          throw new ProtocolError(`Header is ${length} bytes, maximum is ${MAX_HEADER_BYTES}`);
        }
        this.enter("header", length);
        return undefined;
      }
      case "header": {
        this.header = this.parseHeader(this.buffer);
        this.enter("payloadLength", LENGTH_PREFIX_BYTES);
        return undefined;
      }
      case "payloadLength": {
        const length = new DataView(this.buffer.buffer).getUint32(0, false);
        if (length > MAX_PAYLOAD_BYTES) {
          throw new ProtocolError(`Payload is ${length} bytes, maximum is ${MAX_PAYLOAD_BYTES}`);
        }
        this.enter("payload", length);
        return undefined;
      }
      case "payload": {
        const frame: Frame = { header: this.header, payload: this.buffer };
        this.header = undefined;
        this.enter("headerLength", LENGTH_PREFIX_BYTES);
        return frame;
      }
    }
  }

  private enter(stage: Stage, size: number): void {
    this.stage = stage;
    this.buffer = new Uint8Array(size);
    this.filled = 0;
  }

  private parseHeader(bytes: Uint8Array): unknown {
    let value: unknown;
    try {
      value = JSON.parse(this.decoder.decode(bytes));
    } catch {
      throw new ProtocolError("Header is not valid UTF-8 JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ProtocolError("Header must be a JSON object");
    }
    return value;
  }
}
