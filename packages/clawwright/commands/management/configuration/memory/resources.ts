import { posix } from "node:path";
import type { ExecResult } from "#src/runtime/transport/transport.ts";
import { MemoryError, type MemoryConfig } from "./declaration.ts";

export interface ResourceIO { snapshot(): Promise<ExecResult> }
export interface ResourceBinding {
  agentId: string;
  enabled: true;
  provider: string;
  fallback: "none";
  model?: string;
  local?: { modelPath: string };
  vectorEnabled: boolean;
  hybridEnabled: true;
}
export type ResourceBindings = ReadonlyMap<string, ResourceBinding>;
export const RESOURCE_SNAPSHOT_SCRIPT = `(async () => {
  const { readConfigFileSnapshotForWrite } = await import("openclaw/plugin-sdk/config-mutation");
  const { listAgentIds } = await import("openclaw/plugin-sdk/agent-runtime");
  if (typeof readConfigFileSnapshotForWrite !== "function" || typeof listAgentIds !== "function") throw Error("unsupported");
  const { snapshot } = await readConfigFileSnapshotForWrite();
  if (snapshot?.exists !== true || snapshot.valid !== true) throw Error("invalid");
  const config = snapshot.config, agents = config.agents;
  const value = {
    backend: config.memory?.backend,
    agents: {
      defaults: { memorySearch: agents?.defaults?.memorySearch },
      ...(agents?.list === undefined ? {} : { list: agents.list.map(row => ({ id: row.id, ...(row.memorySearch === undefined ? {} : { memorySearch: row.memorySearch }) })) })
    },
    inventory: listAgentIds(config).map(id => ({ id }))
  };
  const output = JSON.stringify(value);
  if (Buffer.byteLength(output, "utf8") > 4 * 1024 ** 2) throw Error("bounded");
  process.stdout.write(output);
})().catch(() => process.exit(2));`;
function fail(code: "STALE" | "UNSUPPORTED", message: string): never { throw new MemoryError(code, message); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("UNSUPPORTED", "Selected memory resource configuration shape unsupported.");
  return value as Record<string, unknown>;
}
function at(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (current === undefined || current === null) return undefined;
    current = record(current)[key];
  }
  return current;
}
function effective(defaults: Record<string, unknown>, overrides: Record<string, unknown>, path: string): unknown {
  return at(overrides, path) ?? at(defaults, path);
}
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every((key) => Object.hasOwn(right, key) && equal((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}
export interface ResourceInventory { readonly ids: readonly string[] }
export function normalizeResourceAgentId(value: unknown): string {
  if (typeof value !== "string") fail("UNSUPPORTED", "Agent IDs must be strings before native normalization.");
  const trimmed = value.trim(), normalized = trimmed.toLowerCase();
  if (!trimmed) return "main";
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)) return normalized;
  return normalized.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "").slice(0, 64) || "main";
}
export function parseAgentInventory(raw: unknown): ResourceInventory {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 128) fail("UNSUPPORTED", "Authoritative native agent inventory unsupported.");
  const ids: string[] = [], seen = new Set<string>();
  for (const value of raw) {
    const key = normalizeResourceAgentId(record(value).id);
    if (seen.has(key)) fail("UNSUPPORTED", "Normalized native agent inventory collision.");
    seen.add(key); ids.push(key);
  }
  return { ids };
}
export function selectResourceAgents(raw: unknown, selected: string | undefined, all: boolean): readonly string[] {
  const inventory = parseAgentInventory(raw);
  if (all) {
    if (selected !== undefined) fail("UNSUPPORTED", "Choose selected agent or all agents, not both.");
    return inventory.ids;
  }
  if (selected === undefined) fail("UNSUPPORTED", "Select an existing native agent.");
  const key = normalizeResourceAgentId(selected);
  if (!inventory.ids.includes(key)) fail("UNSUPPORTED", "Selected agent is absent from authoritative native inventory.");
  return [key];
}
function binding(defaults: Record<string, unknown>, overrides: Record<string, unknown>, approved: Record<string, unknown>, agentId: string): ResourceBinding {
  const get = (path: string) => effective(defaults, overrides, path);
  if (get("enabled") !== true || approved.enabled !== true) fail("STALE", "Selected memory is disabled or differs from approved enabled resources.");
  const provider = get("provider");
  if (typeof provider !== "string" || !provider || provider.trim() !== provider || provider === "auto" || provider !== approved.provider) fail("STALE", "Selected provider differs from explicit approved resources.");
  if (get("fallback") !== "none" || approved.fallback !== "none") fail("STALE", "Selected fallback must remain explicitly none.");
  if (get("query.hybrid.enabled") !== true || at(approved, "query.hybrid.enabled") !== true) fail("STALE", "Selected hybrid resource state differs from approval.");
  const vector = get("store.vector.enabled");
  if (typeof vector !== "boolean" || vector !== at(approved, "store.vector.enabled")) fail("STALE", "Selected vector resource state differs from approval.");
  // Compare only resource boundaries, not ranking, sources, sync or unknown credentials.
  // Remote auth is compared privately; it is never returned in bindings or errors.
  for (const path of ["nodeLlamaCppImportUrl", "local.nodeLlamaCppImportUrl"]) {
    if (at(defaults, path) !== undefined || at(overrides, path) !== undefined || at(approved, path) !== undefined) fail("UNSUPPORTED", "Custom native import resource boundaries are not supported.");
  }
  const paths = [
    ...(provider !== "local" && provider !== "none" ? ["remote.baseUrl", "remote.apiKey", "remote.headers", "remote.nonBatchConcurrency",
      "remote.batch.enabled", "remote.batch.wait", "remote.batch.concurrency", "remote.batch.pollIntervalMs", "remote.batch.timeoutMinutes"] : []),
    "inputType", "queryInputType", "documentInputType", "outputDimensionality", "multimodal.enabled", "multimodal.modalities", "multimodal.maxFileBytes",
    "store.driver", "store.vector.extensionPath", "store.fts.tokenizer", "local.modelCacheDir", "local.contextSize"];
  for (const path of paths) {
    const actual = get(path), expected = at(approved, path);
    if (!equal(actual, expected)) fail("STALE", "Selected resource endpoint, authentication or initialization options differ from approval.");
  }
  if (get("local.modelCacheDir") !== undefined || get("store.vector.extensionPath") !== undefined) fail("UNSUPPORTED", "Local cache or vector extension resource contract is not established.");
  const base: ResourceBinding = { agentId, enabled: true, provider, fallback: "none", vectorEnabled: vector, hybridEnabled: true };
  if (provider === "local") {
    const path = get("local.modelPath"), expected = at(approved, "local.modelPath");
    if (typeof path !== "string" || !posix.isAbsolute(path) || posix.normalize(path) !== path || !path.endsWith(".gguf")) fail("UNSUPPORTED", "Selected local resource requires an explicit canonical GGUF path.");
    if (path !== expected) fail("STALE", "Selected local model path differs from approved resources.");
    // Official provider returns local.modelPath as model identity, not generic model.
    return { ...base, model: path, local: { modelPath: path } };
  }
  if (provider !== "none") {
    const model = get("model");
    if (typeof model !== "string" || !model || model !== approved.model) fail("STALE", "Selected embedding model differs from approved resources.");
    return { ...base, model };
  }
  return base;
}
export function assertResourceBindings(rawAgentsRoot: unknown, config: MemoryConfig, selected: readonly string[], inventory: ResourceInventory): ResourceBindings {
  const root = record(rawAgentsRoot), defaults = record(record(root.defaults).memorySearch), approved = record(config);
  const rawOverrides = root.list === undefined ? [] : root.list;
  if (!Array.isArray(rawOverrides) || rawOverrides.length > 128 || selected.length === 0 || selected.length > 128) fail("UNSUPPORTED", "Selected agent resource inventory unsupported.");
  const authoritative = new Set<string>();
  if (!Array.isArray(inventory.ids) || inventory.ids.length === 0 || inventory.ids.length > 128) fail("UNSUPPORTED", "Authoritative resource inventory required.");
  for (const value of inventory.ids) {
    const key = normalizeResourceAgentId(value);
    if (authoritative.has(key)) fail("UNSUPPORTED", "Normalized authoritative inventory collision.");
    authoritative.add(key);
  }
  const overridesById = new Map<string, Record<string, unknown>>();
  for (const raw of rawOverrides) {
    const row = record(raw), key = normalizeResourceAgentId(row.id);
    if (overridesById.has(key)) fail("UNSUPPORTED", "Ambiguous normalized agent override inventory.");
    overridesById.set(key, row);
  }
  const bindings = new Map<string, ResourceBinding>();
  for (const selectedId of selected) {
    const key = normalizeResourceAgentId(selectedId);
    if (bindings.has(key)) fail("UNSUPPORTED", "Duplicate normalized selected agent resources.");
    if (!authoritative.has(key)) fail("UNSUPPORTED", "Selected agent is absent from authoritative native inventory.");
    binding(defaults, {}, approved, key);
    const row = overridesById.get(key);
    const overrides = row?.memorySearch === undefined ? {} : record(row.memorySearch);
    bindings.set(key, binding(defaults, overrides, approved, key));
  }
  return bindings;
}
function decodeResource(result: ExecResult): unknown {
  if (result.code !== 0 || result.timedOut) throw new MemoryError(result.timedOut ? "DEADLINE" : "UNSUPPORTED", "Selected resource configuration could not be read; no initialization authorized.", { exitCode: result.code, timedOut: result.timedOut === true });
  if (Buffer.byteLength(result.stdout, "utf8") > 4 * 1024 ** 2) fail("UNSUPPORTED", "Selected resource JSON exceeds the supported bounded contract.");
  try { return JSON.parse(result.stdout); } catch { return fail("UNSUPPORTED", "Selected resource JSON contract unsupported."); }
}
export async function readResourceBindings(io: ResourceIO, config: MemoryConfig, selected: readonly string[]): Promise<ResourceBindings> {
  const snapshot = record(decodeResource(await io.snapshot()));
  if (snapshot.backend !== "builtin") fail("UNSUPPORTED", "Only explicit builtin memory backend permits selected resource initialization.");
  const inventory = parseAgentInventory(snapshot.inventory);
  return assertResourceBindings(snapshot.agents, config, selected, inventory);
}
