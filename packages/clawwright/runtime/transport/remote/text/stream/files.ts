import { constants } from "node:fs";
import { lstat, open, mkdtemp, link, unlink, rmdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import { TEXT_STREAM_LIMITS } from "./frames.ts";

const fail = (): Error => new Error("SSJACK_TEXT_STREAM_FILE_FAILED");
const validPath = (path: string): boolean => typeof path === "string" && path.length > 0 && !path.includes("\0") && !/[\uD800-\uDFFF]/u.test(path);

/** One opened regular file, read twice by position; paths are not reopened. */
export class TextStreamTemplate {
  readonly #handle: FileHandle;
  readonly #size: number;
  readonly #device: number;
  readonly #inode: number;
  #reading = false;
  #closed = false;

  private constructor(handle: FileHandle, size: number, device: number, inode: number) {
    this.#handle = handle;
    this.#size = size;
    this.#device = device;
    this.#inode = inode;
  }

  static async open(path: string): Promise<TextStreamTemplate> {
    let handle: FileHandle | undefined;
    try {
      if (!validPath(path)) throw fail();
      const before = await lstat(path);
      if (!before.isFile() || before.size > TEXT_STREAM_LIMITS.bytes) throw fail();
      if (process.platform !== "win32" && typeof constants.O_NONBLOCK !== "number") throw fail();
      const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK) |
        (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
      handle = await open(path, flags);
      const after = await handle.stat();
      if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) throw fail();
      return new TextStreamTemplate(handle, after.size, after.dev, after.ino);
    } catch {
      await handle?.close().catch(() => undefined);
      throw fail();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#handle.close();
  }

  async #check(): Promise<void> {
    if (this.#closed) throw fail();
    const current = await this.#handle.stat();
    if (!current.isFile() || current.size !== this.#size || current.dev !== this.#device || current.ino !== this.#inode) throw fail();
  }

  /** Chunks own their bytes; the keeper binds both passes. */
  async *read(signal?: AbortSignal): AsyncGenerator<Buffer> {
    if (this.#reading || this.#closed || signal?.aborted) throw fail();
    this.#reading = true;
    const buffer = Buffer.alloc(TEXT_STREAM_LIMITS.chunk);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let position = 0;
    try {
      await this.#check();
      for (;;) {
        if (signal?.aborted) throw fail();
        const count = Math.min(buffer.length, TEXT_STREAM_LIMITS.bytes - position + 1);
        const { bytesRead } = await this.#handle.read(buffer, 0, count, position);
        if (bytesRead === 0) break;
        if (bytesRead > TEXT_STREAM_LIMITS.bytes - position || buffer.subarray(0, bytesRead).includes(0)) throw fail();
        decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
        position += bytesRead;
        yield Buffer.from(buffer.subarray(0, bytesRead));
      }
      decoder.decode();
      if (position !== this.#size || signal?.aborted) throw fail();
      await this.#check();
    } catch {
      throw fail();
    } finally {
      buffer.fill(0);
      this.#reading = false;
    }
  }
}

/** The iterator must fail unless received framing and full body EOF were verified. */
export async function publishTextStreamCopy(destination: string, input: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<void> {
  if (!validPath(destination) || signal?.aborted) throw fail();
  let directory: string | undefined;
  let staged: string | undefined;
  let handle: FileHandle | undefined;
  try {
    directory = await mkdtemp(join(dirname(destination), ".clawwright-text-"));
    staged = join(directory, "copy");
    handle = await open(staged, "wx", 0o600);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let total = 0;
    for await (const chunk of input) {
      if (signal?.aborted || !(chunk instanceof Uint8Array) || chunk.byteLength > TEXT_STREAM_LIMITS.chunk || chunk.byteLength > TEXT_STREAM_LIMITS.bytes - total || chunk.includes(0)) throw fail();
      decoder.decode(chunk, { stream: true });
      total += chunk.byteLength;
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null);
        if (bytesWritten < 1 || bytesWritten > chunk.byteLength - offset || signal?.aborted) throw fail();
        offset += bytesWritten;
      }
    }
    decoder.decode();
    if (signal?.aborted) throw fail();
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (signal?.aborted) throw fail();
    await link(staged, destination);
  } catch {
    throw fail();
  } finally {
    await handle?.close().catch(() => undefined);
    if (staged !== undefined) await unlink(staged).catch(() => undefined);
    if (directory !== undefined) await rmdir(directory).catch(() => undefined);
  }
}
