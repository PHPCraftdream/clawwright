import { mkdtemp, open, link, unlink, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_TEXT_BYTES = 1024 * 1024;

/** Publish received transformed text atomically without replacing an existing destination. */
export async function publishSsjackText(output: string, value: string): Promise<void> {
  if (typeof output !== "string" || output.length === 0 || output.includes("\0")) {
    throw new Error("SSJACK_TEXT_OUTPUT_FAILED");
  }
  if (typeof value !== "string" || value.includes("\0") || /[\uD800-\uDFFF]/u.test(value) || Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES) {
    throw new Error("SSJACK_TEXT_OUTPUT_FAILED");
  }
  const parent = dirname(output);
  const temporaryDirectory = await mkdtemp(join(parent, ".clawwright-text-"));
  let temporaryFile: string | undefined;
  try {
    const stagedFile = join(temporaryDirectory, "copy");
    const handle = await open(stagedFile, "wx", 0o600);
    temporaryFile = stagedFile;
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryFile, output);
  } catch {
    throw new Error("SSJACK_TEXT_OUTPUT_FAILED");
  } finally {
    if (temporaryFile !== undefined) await unlink(temporaryFile).catch(() => undefined);
    await rmdir(temporaryDirectory).catch(() => undefined);
  }
}
