import { maskSecrets, regexEscape } from "../core/io/log.ts";
import { registerPrivateSecret } from "../security/privacy/private-config.ts";
import { RecipeKitRefusal, REQUEST_BYTES_MAX } from "./types.ts";

export function limit(value: number | undefined, fallback: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > 2_147_483_647) throw new RecipeKitRefusal("invalid-request");
  return n;
}

export function bytes(text: string): number {
  let count = 0;
  for (const c of text) {
    const n = c.codePointAt(0) ?? 0;
    count += n <= 0x7f ? 1 : n <= 0x7ff ? 2 : n <= 0xffff ? 3 : 4;
  }
  return count;
}

export function cap(text: string, max: number): string {
  let count = 0;
  let end = 0;
  for (const c of text) {
    count += bytes(c);
    if (count > max) break;
    end += c.length;
  }
  return text.slice(0, end);
}

export function requestValue(text: string): void {
  if (typeof text !== "string") throw new RecipeKitRefusal("invalid-request");
  const controls = [...text].some((c) => {
    const n = c.codePointAt(0) ?? 0;
    return n <= 9 || n === 11 || n === 12 || (n >= 14 && n <= 31) || (n >= 127 && n <= 159);
  });
  if (typeof text !== "string" || text.length > REQUEST_BYTES_MAX || bytes(text) > REQUEST_BYTES_MAX || controls) {
    throw new RecipeKitRefusal("invalid-request");
  }
}

export function sanitize(secrets: readonly string[] = []): (text: string) => string {
  const patterns: RegExp[] = [];
  for (const secret of [...new Set(secrets)].sort((a, b) => b.length - a.length)) {
    requestValue(secret);
    if (!secret) continue;
    registerPrivateSecret(secret);
    const pattern = [...secret].map((c) => {
      const unicode = Array.from({ length: c.length }, (_, i) => `\\\\[uU]${c.charCodeAt(i).toString(16).padStart(4, "0").replace(/[a-f]/g, (x) => `[${x}${x.toUpperCase()}]`)}`).join("");
      return `(?:${regexEscape(c)}|${regexEscape(JSON.stringify(c).slice(1, -1))}|${unicode})`;
    }).join("");
    patterns.push(new RegExp(pattern, "g"));
  }
  return (text) => {
    // Explicit (including short) values go first so registry overlap cannot expose tails.
    let result = text;
    for (const pattern of patterns) result = result.replace(pattern, "***");
    return maskSecrets(result);
  };
}

export async function deadline<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RecipeKitRefusal("timeout")), timeoutMs); }),
    ]);
  } catch (error) {
    if (error instanceof RecipeKitRefusal) throw error;
    throw new RecipeKitRefusal("transport");
  } finally {
    clearTimeout(timer);
  }
}
