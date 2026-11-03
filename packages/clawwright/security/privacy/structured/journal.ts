import type { Context } from "../../../core/context.ts";
import { withLockUnlessHeld, lockPath } from "../../../runtime/lock/instance-lock.ts";
import { newOperationId } from "../../../service/operations.ts";
import { replacePrivateTargetFile } from "../private-config.ts";
import { PrivateDataError, gate, integer, readBounded, refuseSecrets, safeOperation, strictJson, type JsonValue } from "./internal.ts";

export interface PrivateJournalOptions {
  readonly maxBytes?: number;
  readonly maxRotations?: number;
}
export interface PrivateJournalReadOptions {
  readonly limit: number;
}
export interface PrivateJournalResult {
  readonly records: ReadonlyArray<{ [key: string]: JsonValue }>;
  readonly corrupt: number;
  readonly truncated: boolean;
}

const active = new Set<string>();
const MAX_BYTES = 1_048_576;
const MAX_ROTATIONS = 8;

function plainRecord(value: unknown): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Appends sanitized plain JSON under the existing instance lock, atomically mode 600/parent 700.
 * UTC `timestamp` is reserved and overwritten. Defaults: 256 KiB/file, 3 rotations; maxima:
 * 1 MiB/file, 8 rotations (0 disables retention of old files). Oversized records refuse.
 * All rotation siblings are gated before writing: exact-file declarations refuse when rotation
 * is needed. Sibling concurrent calls refuse, including inside a reentrant instance lock.
 * Each publication is atomic; multi-file rotation is not transactional on publication failure.
 * Full backups retain personal data; migrate/share exclude it. */
export async function appendPrivateJournal(ctx: Context, path: string, record: { [key: string]: JsonValue }, options: PrivateJournalOptions = {}): Promise<void> {
  return safeOperation(async () => {
    const maxBytes = integer(options.maxBytes ?? 262_144, 1, MAX_BYTES);
    const maxRotations = integer(options.maxRotations ?? 3, 0, MAX_ROTATIONS);
    if (!plainRecord(record)) throw new PrivateDataError("invalid");
    const original = strictJson(record);
    refuseSecrets(original);
    const snapshot = JSON.parse(original) as { [key: string]: JsonValue };
    snapshot.timestamp = new Date().toISOString();
    const line = strictJson(snapshot) + "\n";
    refuseSecrets(line);
    if (Buffer.byteLength(line, "utf8") > maxBytes) throw new PrivateDataError("size");
    const { target } = await gate(ctx, path);
    const resource = `${ctx.transport.description}\0${lockPath(ctx)}`;
    if (active.has(resource)) throw new PrivateDataError("busy");
    active.add(resource);
    try {
      await withLockUnlessHeld(ctx, "private-journal", newOperationId("private-journal"), {}, async () => {
        const current = await readBounded(ctx, target, MAX_BYTES) ?? "";
        if (current !== "" && !current.endsWith("\n")) throw new PrivateDataError("invalid");
        const rotating = Buffer.byteLength(current + line, "utf8") > maxBytes;
        const declaration = await gate(ctx, target);
        if (rotating && declaration.ledger === declaration.boundary) throw new PrivateDataError("policy");
        const siblings: string[] = [];
        if (declaration.ledger !== declaration.boundary) {
          for (let index = 1; index <= MAX_ROTATIONS; index++) {
            siblings.push((await gate(ctx, `${target}.${index}`)).target);
          }
        }
        const previous: Array<string | undefined> = [];
        for (const sibling of siblings) previous.push(await readBounded(ctx, sibling, MAX_BYTES));
        for (let index = siblings.length - 1; index >= 0; index--) {
          const content = index >= maxRotations ? undefined : rotating
            ? (index === 0 ? current : previous[index - 1]) : previous[index];
          if (content !== undefined && rotating && index < maxRotations) {
            await replacePrivateTargetFile(ctx, siblings[index], content);
          } else if (content === undefined && previous[index] !== undefined) {
            await ctx.transport.remove(siblings[index]);
          }
        }
        await replacePrivateTargetFile(ctx, target, rotating ? line : current + line);
      });
    } finally { active.delete(resource); }
  });
}

/** Returns newest-first records; missing files are empty, failed reads/final symlinks refuse.
 * Scans up to 9 files of 1 MiB each and 10,000 lines total; limit is 1..1,000.
 * Corrupt scanned lines are counted, never echoed; truncated signals unscanned records.
 * Rotation siblings outside the declaration are not read. */
export async function readPrivateJournal(ctx: Context, path: string, options: PrivateJournalReadOptions): Promise<PrivateJournalResult> {
  return safeOperation(async () => {
    const limit = integer(options.limit, 1, 1_000);
    const { target, ledger, boundary } = await gate(ctx, path);
    const records: Array<{ [key: string]: JsonValue }> = [];
    let corrupt = 0;
    let scanned = 0;
    for (let rotation = 0; rotation <= MAX_ROTATIONS; rotation++) {
      if (rotation > 0 && ledger === boundary) break;
      const text = await readBounded(ctx, rotation === 0 ? target : `${target}.${rotation}`, MAX_BYTES);
      if (text === undefined || text === "") continue;
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      for (let index = lines.length - 1; index >= 0; index--) {
        if (records.length === limit || scanned === 10_000) return { records, corrupt, truncated: true };
        scanned++;
        try {
          if (index === lines.length - 1 && !text.endsWith("\n")) throw new PrivateDataError("invalid");
          const record: unknown = JSON.parse(lines[index]);
          strictJson(record);
          if (!plainRecord(record) || typeof record.timestamp !== "string"
            || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.timestamp)
            || !Number.isFinite(Date.parse(record.timestamp))) throw new PrivateDataError("invalid");
          records.push(record);
        } catch { corrupt++; }
      }
    }
    return { records, corrupt, truncated: false };
  });
}
