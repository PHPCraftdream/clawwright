import type { Context } from "../../../core/context.ts";
import { replacePrivateTargetFile } from "../private-config.ts";
import { PrivateDataError, gate, integer, readBounded, safeOperation, strictJson, type JsonValue } from "./internal.ts";

export interface PrivateStateOptions<T> {
  readonly version: number;
  readonly validate?: (value: unknown) => value is T;
}

function validate<T>(value: unknown, options: PrivateStateOptions<T>): void {
  if (options.validate === undefined) return;
  try {
    if (options.validate(value) !== true) throw new PrivateDataError("validation");
  } catch { throw new PrivateDataError("validation"); }
}

/** Reads a strict {version,value} envelope (at most 1 MiB); absent files return undefined.
 * Version mismatch, final symlinks, invalid JSON and failed validators are typed refusals. */
export async function readPrivateState<T = JsonValue>(ctx: Context, path: string, options: PrivateStateOptions<T>): Promise<T | undefined> {
  return safeOperation(async () => {
    integer(options.version, 0, Number.MAX_SAFE_INTEGER);
    const text = await readBounded(ctx, path, 1_048_576);
    if (text === undefined) return undefined;
    let envelope: unknown;
    try { envelope = JSON.parse(text); } catch { throw new PrivateDataError("invalid"); }
    strictJson(envelope);
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)
      || Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, "version") || !Object.hasOwn(envelope, "value")) {
      throw new PrivateDataError("invalid");
    }
    const state = envelope as { version: unknown; value: unknown };
    if (state.version !== options.version) throw new PrivateDataError("version");
    validate(state.value, options);
    strictJson(state.value);
    return state.value as T;
  });
}

/** Atomically publishes a strict versioned JSON envelope, at most 1 MiB, mode 600/parent 700.
 * The validator must accept the value; full backups retain it, migrate/share exclude it. */
export async function writePrivateState<T = JsonValue>(ctx: Context, path: string, value: T, options: PrivateStateOptions<T>): Promise<void> {
  return safeOperation(async () => {
    integer(options.version, 0, Number.MAX_SAFE_INTEGER);
    strictJson(value);
    validate(value, options);
    const text = strictJson({ version: options.version, value });
    if (Buffer.byteLength(text, "utf8") > 1_048_576) throw new PrivateDataError("size");
    await gate(ctx, path);
    await replacePrivateTargetFile(ctx, path, text);
  });
}
