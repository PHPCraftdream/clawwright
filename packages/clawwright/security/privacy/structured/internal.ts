import { maskSecrets, UserError } from "../../../core/io/log.ts";
import type { Context } from "../../../core/context.ts";
import { assertDeclaredPrivatePath } from "./path-policy.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type PrivateRefusalCode = "policy" | "io" | "symlink" | "invalid" | "version" | "validation" | "size" | "secret" | "busy";

/** A content-free refusal; underlying transport and validator errors are never exposed. */
export class PrivateDataError extends UserError {
  readonly code: PrivateRefusalCode;
  constructor(code: PrivateRefusalCode) {
    super(`private structured data refused (${code})`);
    this.name = "PrivateDataError";
    this.code = code;
  }
}

const privateSecrets = new Set<string>();
/** Remembers even short credentials for journal refusal. */
export function rememberPrivateSecret(value: string): void {
  if (value.length > 0) privateSecrets.add(value);
  if (value.trim().length > 0) privateSecrets.add(value.trim());
}

/** Serializes only bounded, lossless plain JSON values. */
export function strictJson(value: unknown): string {
  const ancestors = new Set<object>();
  let nodes = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > 64) throw new PrivateDataError("size");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || item === null || ancestors.has(item)) throw new PrivateDataError("invalid");
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (!array && prototype !== Object.prototype && prototype !== null) throw new PrivateDataError("invalid");
    ancestors.add(item);
    const keys = Reflect.ownKeys(item);
    if (array && keys.length !== item.length + 1) throw new PrivateDataError("invalid");
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || (array && !/^(0|[1-9][0-9]*)$/.test(key))) throw new PrivateDataError("invalid");
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) throw new PrivateDataError("invalid");
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  }
  try {
    visit(value, 0);
    return JSON.stringify(value);
  } catch (error) {
    if (error instanceof PrivateDataError) throw error;
    throw new PrivateDataError("invalid");
  }
}

/** Refuses registered credentials without exposing their values. */
export function refuseSecrets(serialized: string): void {
  if (maskSecrets(serialized) !== serialized) throw new PrivateDataError("secret");
  const hasSecret = (text: string): boolean => [...privateSecrets].some((secret) => text.includes(secret));
  function visit(value: JsonValue): void {
    if (typeof value === "string" && hasSecret(value)) throw new PrivateDataError("secret");
    if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (hasSecret(key)) throw new PrivateDataError("secret");
        visit(item);
      }
    }
  }
  if (hasSecret(serialized)) throw new PrivateDataError("secret");
  visit(JSON.parse(serialized) as JsonValue);
}

/** Checks a bounded integer option. */
export function integer(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new PrivateDataError("invalid");
  return value;
}

/** Applies the existing declared-path policy with content-free errors. */
export async function gate(ctx: Context, path: string): Promise<{ target: string; ledger: string; boundary: string }> {
  try {
    if (typeof path !== "string" || !path.startsWith("/") || ["\0", "\r", "\n"].some(character => path.includes(character))) throw new PrivateDataError("policy");
    return await assertDeclaredPrivatePath(ctx, path, "file");
  } catch { throw new PrivateDataError("policy"); }
}

/** Reads through transport with a byte sentinel; missing differs from failed. */
export async function readBounded(ctx: Context, path: string, maxBytes: number): Promise<string | undefined> {
  const { target } = await gate(ctx, path);
  try {
    const result = await ctx.transport.exec("sh", ["-c",
      'p=$1; [ ! -L "$p" ] || exit 41; if [ ! -e "$p" ]; then d=${p%/*}; while [ ! -e "$d" ]; do [ ! -L "$d" ] || exit 41; [ "$d" != / ] || exit 43; d=${d%/*}; [ -n "$d" ] || d=/; done; [ -d "$d" ] && [ -x "$d" ] || exit 43; exit 42; fi; [ -f "$p" ] || exit 43; head -c "$2" -- "$p"',
      "sh", target, String(maxBytes + 1)], { allowFailure: true, timeoutMs: 10_000 });
    if (result.timedOut) throw new PrivateDataError("io");
    if (result.code === 41) throw new PrivateDataError("symlink");
    if (result.code === 42) return undefined;
    if (result.code !== 0) throw new PrivateDataError("io");
    if (Buffer.byteLength(result.stdout, "utf8") > maxBytes) throw new PrivateDataError("size");
    return result.stdout;
  } catch (error) {
    if (error instanceof PrivateDataError) throw error;
    throw new PrivateDataError("io");
  }
}

/** Converts foreign failures to content-free typed refusals. */
export async function safeOperation<T>(body: () => Promise<T>): Promise<T> {
  try { return await body(); }
  catch (error) {
    if (error instanceof PrivateDataError) throw error;
    throw new PrivateDataError("io");
  }
}
