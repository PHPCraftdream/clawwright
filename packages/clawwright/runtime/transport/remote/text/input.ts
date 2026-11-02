import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { TextDecoder } from "node:util";

const MAX_INPUT_BYTES = 32768;
const failure = (): Error => new Error("SSJACK_TEXT_INPUT_FAILED");

/** Narrow IO seam for deterministic package-internal guard tests; not exposed by the package barrel. */
export interface SsjackTextInputFiles {
  lstat(path: string): Promise<Pick<import("node:fs").Stats, "isFile" | "dev" | "ino" | "size">>;
  open(path: string, flags: number): Promise<{
    stat(): Promise<Pick<import("node:fs").Stats, "isFile" | "dev" | "ino" | "size">>;
    read(buffer: Buffer, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>;
    close(): Promise<void>;
  }>;
}

/** Read bounded UTF-8 through injected IO so race guards can be tested without timing. */
export async function readSsjackTextInputFrom(path: string, files: SsjackTextInputFiles, platform = process.platform): Promise<string> {
  let handle: Awaited<ReturnType<SsjackTextInputFiles["open"]>> | undefined;
  try {
    const before = await files.lstat(path);
    if (!before.isFile()) throw failure();
    if (before.size > MAX_INPUT_BYTES) throw failure();
    if (platform !== "win32" && typeof constants.O_NONBLOCK !== "number") throw failure();
    // Windows Node does not expose O_NONBLOCK: ordinary file opens are synchronous
    // handle opens there. Keep nonblocking FIFO protection on platforms that support it.
    const flags = constants.O_RDONLY |
      (platform === "win32" ? 0 : constants.O_NONBLOCK) |
      (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
    handle = await files.open(path, flags);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > MAX_INPUT_BYTES) {
      throw failure();
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_INPUT_BYTES) {
      const chunk = Buffer.alloc(Math.min(4096, MAX_INPUT_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > MAX_INPUT_BYTES) throw failure();
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, total));
  } catch {
    throw failure();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Read a bounded UTF-8 input without trusting an earlier stat against file growth. */
export async function readSsjackTextInput(path: string): Promise<string> {
  return readSsjackTextInputFrom(path, { lstat, open });
}
