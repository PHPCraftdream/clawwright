import { posix } from "node:path";
import { parseSSJackPlaceholder } from "#src/core/values/config/ssjack-secret-refs.ts";

export interface TextStreamSelection {
  readonly profile: string;
  readonly file: string;
  readonly references: readonly string[];
}

export interface TextStreamOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly deadline?: number | Date;
}

export const textStreamFailure = (): Error => new Error("SSJACK_TEXT_STREAM_OPERATION_FAILED");
export const textStreamID = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{22}$/.test(value) && Buffer.from(value, "base64url").toString("base64url") === value;
export const textStreamRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Correlation metadata only; the keeper independently enforces root authority. */
export function textStreamSelection(value: TextStreamSelection, profile: string): TextStreamSelection {
  try {
    if (value.profile !== profile || typeof value.file !== "string" || Buffer.byteLength(value.file) > 4096 || value.file.includes("\0") || /[\uD800-\uDFFF]/u.test(value.file) || !posix.isAbsolute(value.file) || posix.normalize(value.file) !== value.file || !Array.isArray(value.references) || value.references.length < 1 || value.references.length > 16) throw textStreamFailure();
    const selected = new Set<string>();
    let store: string | undefined, snapshot: string | undefined;
    for (const encoded of value.references) {
      if (typeof encoded !== "string" || encoded.length > 1024 || selected.has(encoded)) throw textStreamFailure();
      const reference = parseSSJackPlaceholder(JSON.parse(encoded));
      if (reference === undefined) throw textStreamFailure();
      const canonical = JSON.stringify({ $ssjack: { format: reference.format, object_id: reference.object_id, snapshot_id: reference.snapshot_id, store_id: reference.store_id, version_id: reference.version_id } });
      if (canonical !== encoded || (store !== undefined && store !== reference.store_id) || (snapshot !== undefined && snapshot !== reference.snapshot_id)) throw textStreamFailure();
      store = reference.store_id;
      snapshot = reference.snapshot_id;
      selected.add(encoded);
    }
    return Object.freeze({ profile, file: value.file, references: Object.freeze([...selected]) });
  } catch { throw textStreamFailure(); }
}

export function textStreamHeader(selection: TextStreamSelection, operation: string, ticket?: string): Record<string, unknown> {
  if (!textStreamID(operation) || (ticket !== undefined && !textStreamID(ticket))) throw textStreamFailure();
  const header = { format: "ssjack-text-stream-v2", operation_id: operation, profile: selection.profile, file: selection.file, references: selection.references, ...(ticket === undefined ? {} : { ticket }) };
  if (Buffer.byteLength(JSON.stringify(header)) > 16384) throw textStreamFailure();
  return header;
}

export function textStreamLifetime(options: TextStreamOptions): { signal: AbortSignal; dispose(): void } {
  const entered = Date.now();
  const timeout = options.timeoutMs ?? 60000;
  const requested = options.deadline instanceof Date ? options.deadline.getTime() : options.deadline;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || (requested !== undefined && (typeof requested !== "number" || !Number.isFinite(requested))) || options.signal?.aborted) throw textStreamFailure();
  const remaining = Math.floor(Math.min(entered + timeout, entered + 60000, requested ?? Infinity) - entered);
  if (remaining < 1) throw textStreamFailure();
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const timer = setTimeout(abort, remaining);
  options.signal?.addEventListener("abort", abort, { once: true });
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); } };
}
