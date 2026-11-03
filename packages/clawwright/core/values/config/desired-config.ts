import { configPathParts, mergePatchDiff, pruneConfigPath, readConfigPath, setConfigPath } from "./config-selectors.ts";

export interface DesiredConfigEntry { readonly path: string; readonly value: unknown }
export interface DesiredConfigResult {
  readonly desired: Record<string, unknown>;
  readonly patch: unknown;
  readonly affectedPaths: string[];
}

/** Computes the one desired configuration used by apply and inspection. */
export function desiredConfig(
  live: unknown,
  declared: readonly DesiredConfigEntry[],
  recorded: readonly DesiredConfigEntry[],
): DesiredConfigResult {
  const before: Record<string, unknown> = live === undefined ? {} : live !== null && typeof live === "object" && !Array.isArray(live)
    ? structuredClone(live as Record<string, unknown>) : (() => { throw new Error("live configuration must be an object"); })();
  const desired = structuredClone(before);
  const declaredPaths = new Set(declared.map((entry) => entry.path));
  const removed = recorded.filter((entry) => !declaredPaths.has(entry.path));
  for (const entry of removed) pruneConfigPath(desired, entry.path, entry.value);
  for (const entry of declared) setConfigPath(desired, entry.path, structuredClone(entry.value));
  const patch = mergePatchDiff(before, desired);
  const affectedPaths: string[] = [];
  const seen = new Set<string>();
  for (const entry of [...declared, ...removed]) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    if (!jsonEqual(readForOwnership(before, entry.path), readForOwnership(desired, entry.path))) affectedPaths.push(entry.path);
  }
  return { desired, patch, affectedPaths };
}
function readForOwnership(root: unknown, path: string): unknown {
  try {
    const parts = configPathParts(path);
    return readConfigPath(root, path, parts.at(-1)?.kind === "selector" ? "set" : "single");
  } catch { return undefined; }
}
function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  const ak = Object.keys(a as object).sort(), bk = Object.keys(b as object).sort();
  return ak.length === bk.length && ak.every((k, i) => k === bk[i] && jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
