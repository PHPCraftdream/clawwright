import { posix } from "node:path";
import { UserError } from "#src/core/io/log.ts";
import { manual } from "#src/core/io/invocation/advice.ts";
export type Mode = "disabled" | "keyword" | "embeddings";
export interface Operation { path: string; value: unknown }
export interface MemoryConfig {
  enabled: boolean; provider?: string; model?: string; fallback?: string;
  query?: { hybrid?: { enabled?: boolean } }; store?: { vector?: { enabled?: boolean } };
  local?: { modelPath?: string }; remote?: { apiKey?: unknown };
}
export const MEMORY_PATH = "agents.defaults.memorySearch";
export class MemoryError extends UserError {
  readonly code: string;
  constructor(code: string, remedy: string, cause?: unknown) {
    super(`MEMORY_${code}`, { advice: [manual(remedy)], cause }); this.name = "MemoryError"; this.code = code;
  }
}
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function declaration(text: string): Operation[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (cause) { throw new MemoryError("DECLARATION", "Repair canonical desired-state JSON before target contact.", cause); }
  if (!Array.isArray(raw) || raw.some((v) => typeof object(v).path !== "string" || !("value" in object(v)))) throw new MemoryError("DECLARATION", "Use native {path,value} operations.");
  const ops = raw as Operation[], paths = ops.map((v) => v.path);
  if (paths.some((p, i) => !p || p.split(".").some((k) => ["__proto__", "constructor", "prototype", ""].includes(k)) || paths.some((q, j) => i !== j && (p === q || p.startsWith(`${q}.`))))) throw new MemoryError("DECLARATION", "Resolve unsafe, overlapping or duplicate declaration paths.");
  return ops;
}
export function leaves(path: string, value: unknown): Operation[] {
  const entries = Object.entries(object(value));
  if (entries.length === 0 || Array.isArray(value) || object(value).source !== undefined) return [{ path, value }];
  return entries.flatMap(([key, child]) => {
    if (["__proto__", "constructor", "prototype"].includes(key) || key.includes(".")) throw new MemoryError("DECLARATION", "Remove ambiguous declaration keys.");
    return leaves(`${path}.${key}`, child);
  });
}
export function declaredMemory(ops: Operation[]): MemoryConfig {
  const config: Record<string, unknown> = {};
  const relevant = ops.flatMap((op) => {
    if (op.path === MEMORY_PATH || op.path.startsWith(`${MEMORY_PATH}.`)) return leaves(op.path, op.value);
    if (!MEMORY_PATH.startsWith(`${op.path}.`)) return [];
    let value = op.value;
    for (const key of MEMORY_PATH.slice(op.path.length + 1).split(".")) value = object(value)[key];
    return value === undefined ? [] : leaves(MEMORY_PATH, value);
  });
  for (const op of relevant) {
    if (!op.path.startsWith(`${MEMORY_PATH}.`)) continue;
    const keys = op.path.slice(MEMORY_PATH.length + 1).split("."); let at = config;
    for (const key of keys.slice(0, -1)) { at[key] = object(at[key]); at = object(at[key]); }
    at[keys.at(-1)!] = structuredClone(op.value);
  }
  return config as unknown as MemoryConfig;
}
export function modeOf(c: MemoryConfig): Mode {
  if (c.enabled === false) return "disabled";
  if (c.enabled === true && c.provider === "none" && c.fallback === "none" && c.query?.hybrid?.enabled === true && c.store?.vector?.enabled === false) return "keyword";
  if (c.enabled === true && typeof c.provider === "string" && c.provider !== "none" && typeof c.model === "string" && c.model !== "" && c.fallback === "none" && c.query?.hybrid?.enabled === true && c.store?.vector?.enabled === true) return "embeddings";
  throw new MemoryError("UNDECLARED", "Declare disabled, exact keyword semantics or explicit embedding provider/model.");
}
export function ownedPatch(mode: Mode, provider?: string, model?: string, env?: string, modelPath?: string): Operation[] {
  const patch: Operation[] = [{ path: "memory.backend", value: "builtin" }, { path: `${MEMORY_PATH}.enabled`, value: mode !== "disabled" }];
  if (mode === "disabled") return patch;
  const values: Record<string, unknown> = { provider: mode === "keyword" ? "none" : provider, fallback: "none", "query.hybrid.enabled": true, "store.vector.enabled": mode === "embeddings" };
  if (mode === "embeddings") {
    if (provider === "local" && (!modelPath || !posix.isAbsolute(modelPath) || posix.normalize(modelPath) !== modelPath || modelPath.includes("\\") || !modelPath.endsWith(".gguf") || (model !== undefined && model !== modelPath))) throw new MemoryError("MODEL", "Local model identity must equal its explicit absolute modelPath, not an arbitrary label.");
    values.model = provider === "local" ? modelPath : model;
    if (env !== undefined) values["remote.apiKey"] = { source: "env", id: env };
    if (modelPath !== undefined) values["local.modelPath"] = modelPath;
  }
  return [...patch, ...Object.entries(values).map(([path, value]) => ({ path: `${MEMORY_PATH}.${path}`, value }))];
}
export function configure(ops: Operation[], mode: Mode, provider?: string, model?: string, env?: string, modelPath?: string): Operation[] {
  const credential = declaredMemory(ops).remote?.apiKey;
  if (env !== undefined && credential !== undefined && !(object(credential).source === "env" && object(credential).id === env)) throw new MemoryError("CREDENTIAL", "Preserve the existing credential; review replacement separately.");
  const patch = ownedPatch(mode, provider, model, env, modelPath), owned = new Set(patch.map((v) => v.path));
  const expanded = ops.flatMap((op) => {
    if (!patch.some((p) => p.path.startsWith(`${op.path}.`))) return [op];
    if (op.path === MEMORY_PATH) return leaves(op.path, op.value);
    if (op.path !== "memory") throw new MemoryError("DECLARATION", "Split only the memorySearch declaration boundary explicitly; unrelated ancestor operations are preserved, not rewritten.");
    return Object.entries(object(op.value)).map(([key, value]) => ({ path: `memory.${key}`, value }));
  });
  const result = [...expanded.filter((op) => !owned.has(op.path)), ...patch];
  return declaration(JSON.stringify(result));
}
