import { TextDecoder } from "node:util";

export const TEXT_STREAM_LIMITS = Object.freeze({ chunk: 32768, bytes: 64 * 1024 * 1024, frames: 4096, wireFrame: 48 * 1024, wire: 96 * 1024 * 1024 });
const fail = (): Error => new Error("SSJACK_TEXT_STREAM_INVALID");
const operationValid = (value: string): boolean => typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export async function* encodeTextFrames(input: AsyncIterable<Uint8Array>, operation: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
  if (!operationValid(operation)) throw fail();
  const buffer = Buffer.alloc(TEXT_STREAM_LIMITS.chunk);
  let used = 0, total = 0, frames = 0;
  const data = (): Buffer => {
    if (signal?.aborted || frames >= TEXT_STREAM_LIMITS.frames) throw fail();
    const result = Buffer.from(`${JSON.stringify({ type: "data", operation_id: operation, sequence: frames, data: buffer.subarray(0, used).toString("base64") })}\n`);
    frames += 1;
    buffer.fill(0, 0, used);
    used = 0;
    return result;
  };
  try {
    for await (const chunk of input) {
      if (signal?.aborted || !(chunk instanceof Uint8Array) || chunk.byteLength > TEXT_STREAM_LIMITS.bytes - total) throw fail();
      total += chunk.byteLength;
      let offset = 0;
      while (offset < chunk.byteLength) {
        const count = Math.min(buffer.length - used, chunk.byteLength - offset);
        buffer.set(chunk.subarray(offset, offset + count), used);
        used += count;
        offset += count;
        if (used === buffer.length) yield data();
      }
    }
    if (signal?.aborted) throw fail();
    if (used !== 0) yield data();
    yield Buffer.from(`${JSON.stringify({ type: "complete", operation_id: operation, sequence: frames, bytes: total, frames })}\n`);
  } finally {
    buffer.fill(0);
  }
}

function parseFrame(line: Buffer): Record<string, unknown> {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(line);
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw fail();
    // The keeper emits compact flat records. Exact round-trip rejects duplicate
    // keys, ambiguous numbers and alternate string encodings before interpretation.
    if (JSON.stringify(value) !== text) throw fail();
    return value as Record<string, unknown>;
  } catch {
    throw fail();
  }
}

/** Yield tentative bytes only; publication requires successful exhaustion. */
export async function* decodeTextFrames(input: AsyncIterable<Uint8Array>, operation: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
  if (!operationValid(operation)) throw fail();
  let pending = Buffer.alloc(0);
  let total = 0, frames = 0, wire = 0;
  let complete = false;
  try {
    for await (const chunk of input) {
      if (signal?.aborted || !(chunk instanceof Uint8Array) || chunk.byteLength > TEXT_STREAM_LIMITS.wire - wire || complete) throw fail();
      wire += chunk.byteLength;
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      let offset = 0;
      while (offset < bytes.length) {
        if (complete) throw fail();
        const newline = bytes.indexOf(10, offset);
        const end = newline < 0 ? bytes.length : newline;
        if (pending.length + end - offset > TEXT_STREAM_LIMITS.wireFrame) throw fail();
        const line = Buffer.concat([pending, bytes.subarray(offset, end)]);
        pending.fill(0);
        pending = Buffer.alloc(0);
        if (newline < 0) { pending = line; break; }
        offset = newline + 1;
        let frame: Record<string, unknown>;
        try { frame = parseFrame(line); } finally { line.fill(0); }
        if (frame.operation_id !== operation || !integer(frame.sequence) || frame.sequence !== frames) throw fail();
        const required = frame.type === "data" ? ["type", "operation_id", "sequence", "data"] : ["type", "operation_id", "sequence", "bytes", "frames"];
        if (Object.keys(frame).length !== required.length || required.some((key) => !Object.hasOwn(frame, key))) throw fail();
        if (frame.type === "complete") {
          if (!integer(frame.bytes) || frame.bytes !== total || !integer(frame.frames) || frame.frames !== frames) throw fail();
          complete = true;
          continue;
        }
        if (frame.type !== "data" || frames >= TEXT_STREAM_LIMITS.frames || typeof frame.data !== "string" || frame.data.length === 0 || frame.data.length > 4 * Math.ceil(TEXT_STREAM_LIMITS.chunk / 3)) throw fail();
        const decoded = Buffer.from(frame.data, "base64");
        if (decoded.length === 0 || decoded.length > TEXT_STREAM_LIMITS.chunk || decoded.toString("base64") !== frame.data || decoded.length > TEXT_STREAM_LIMITS.bytes - total) throw fail();
        total += decoded.length;
        frames += 1;
        yield decoded;
      }
    }
    if (signal?.aborted || !complete || pending.length !== 0) throw fail();
  } finally {
    pending.fill(0);
  }
}
