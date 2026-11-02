import { open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { posix, resolve } from "node:path";
import { defineAction, multiActionBody, type ArgumentSpec, type PrepareCall, type LocalScope, type Values } from "#src/core/command/index.ts";
import * as kinds from "#src/core/values/kinds.ts";
import { emit } from "#src/core/io/output.ts";
import { guardedWith } from "#src/runtime/lock/instance-lock.ts";
import { declaration, configure, declaredMemory, modeOf, MemoryError } from "./declaration.ts";
import { SETUP } from "./setup/action.ts";
import { sha256 } from "./values.ts";
import { budget, consume, rawStatus, safeStatus, type Consent } from "./consumer.ts";
const JSON_ARGUMENT = { name: "json", description: "Structured outcome", kind: "flag" } as const;
const MODEL = [
  { name: "model-checksum", description: "Approved GGUF SHA256", kind: "option", valueName: "sha256", value: sha256() },
  { name: "model-source", summary: "Approved source", description: "Approved model source", kind: "option", valueName: "source", value: kinds.text("an approved model source") },
  { name: "model-version", summary: "Approved revision", description: "Approved model version", kind: "option", valueName: "version", value: kinds.text("an approved model version") },
] as const;
const CONSENT = [
  { name: "allow-spend", summary: "Probe spend", description: "Consent to provider probe spend", kind: "flag" },
  { name: "allow-download", summary: "Probe downloads", description: "Consent to provider probe downloads", kind: "flag" },
] as const;
const CONFIG = [
  { name: "mode", summary: "Memory mode", description: "Intentional memory mode", kind: "option", valueName: "mode", required: true, value: kinds.choice(["embeddings", "keyword", "disabled"] as const) },
  { name: "backend", description: "Explicit backend", kind: "option", valueName: "backend", required: true, value: kinds.choice(["builtin"] as const) },
  { name: "provider", summary: "Embedding provider", description: "Explicit embedding provider", kind: "option", valueName: "id", value: kinds.providerId() },
  { name: "model", summary: "Embedding model", description: "Explicit embedding model", kind: "option", valueName: "model", value: kinds.text("an embedding model") },
  { name: "env", summary: "Target SecretRef", description: "Existing target SecretRef name", kind: "option", valueName: "var", value: kinds.envVar() },
  { name: "model-path", summary: "Managed GGUF path", description: "Existing managed container GGUF path", kind: "option", valueName: "path", value: kinds.text("an existing managed GGUF path") },
  ...MODEL, JSON_ARGUMENT,
] as const satisfies readonly ArgumentSpec[];
const SELECT = [
  { name: "agent", description: "Existing agent id", kind: "option", valueName: "id", value: kinds.providerId() },
  { name: "all-agents", summary: "Every agent", description: "Select every existing agent", kind: "flag" },
  ...CONSENT, ...MODEL, JSON_ARGUMENT,
] as const satisfies readonly ArgumentSpec[];
function consent(v: Record<string, unknown>): Consent { return { spend: v["allow-spend"] === true, download: v["allow-download"] === true, checksum: v["model-checksum"] as string | undefined, source: v["model-source"] as string | undefined, version: v["model-version"] as string | undefined }; }
export async function atomicDeclaration(path: string, before: string, after: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`, handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(after, "utf8"); await handle.sync(); await handle.close();
    if (await readFile(path, "utf8") !== before) throw new MemoryError("DECLARATION_CHANGED", "Declaration changed concurrently; review and retry.");
    await rename(temporary, path);
  } finally { await handle.close().catch(() => undefined); await unlink(temporary).catch((e: unknown) => { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }); }
}
async function localDeclaration(local: LocalScope) {
  const path = resolve(local.deployment().dir, "config", "desired-state.json"), before = await local.readText(path);
  if (before === undefined) throw new MemoryError("DECLARATION", "Canonical desired-state file must already exist.");
  return { path, before, ops: declaration(before) };
}
async function prepareConfig(call: PrepareCall<Values<typeof CONFIG>>, local: LocalScope) {
  const v = call.values;
  if (v.mode !== "embeddings" && (v.provider || v.model || v.env || v["model-path"])) return call.refuse("mode", "keyword/disabled refuse embedding options");
  if (v.mode === "embeddings" && (!v.provider || v.provider === "none" || (v.provider !== "local" && !v.model))) return call.refuse("provider", "embeddings require provider and model");
  if (v.provider === "local" && (!v["model-path"] || !v["model-checksum"] || !v["model-source"] || !v["model-version"])) return call.refuse("model-path", "local requires existing managed path and approved checksum/source/version");
  if (v["model-path"] && (!posix.isAbsolute(v["model-path"]) || posix.normalize(v["model-path"]) !== v["model-path"] || v["model-path"].includes("\\") || !v["model-path"].endsWith(".gguf"))) return call.refuse("model-path", "requires absolute persistent GGUF path");
  if (v.provider !== "local" && (v["model-path"] || v["model-checksum"] || v["model-source"] || v["model-version"])) return call.refuse("model-path", "local model approvals only apply to local provider");
  if (v.provider === "local" && v.env) return call.refuse("env", "local uses no remote credential");
  if (v.provider === "local" && v.model !== undefined && v.model !== v["model-path"]) return call.refuse("model", "local model identity must equal model-path; omit model to infer it");
  const model = v.provider === "local" ? v["model-path"] : v.model;
  const d = await localDeclaration(local), next = configure(d.ops, v.mode, v.provider, model, v.env, v["model-path"]);
  return { ...v, model, ...d, next };
}
// A remote credential reference and local model approvals describe different providers.
const CONFIG_RULES = [{ rule: "conflicts", name: "env", with: ["model-path", "model-checksum", "model-source", "model-version"] }] as const;
const plan = defineAction({ summary: "Preview the memory settings a mode implies (local)", effect: "read", needs: "local", arguments: CONFIG, rules: CONFIG_RULES, prepare: prepareConfig,
  async run(_local, p) { emit(`${JSON.stringify({ ok: true, changed: false, mode: p.mode, owned: p.next.filter((op) => op.path.startsWith("agents.defaults.memorySearch.") || op.path === "memory.backend").map((op) => op.path), targetPreflightDeferred: p.provider === "local" })}\n`); } });
const configureAction = defineAction({ summary: "Write the memory settings into desired-state.json", effect: "destroy", needs: "local", arguments: CONFIG, rules: CONFIG_RULES, prepare: prepareConfig,
  async run(_local, p) { const after = `${JSON.stringify(p.next, null, 2)}\n`, changed = after !== p.before; if (changed) await atomicDeclaration(p.path, p.before, after);
    emit(`${JSON.stringify({ ok: true, changed, mode: p.mode, applied: false, next: "Review desired leaf batch, explicitly apply-config, then restart; target local-model prerequisites are checked before indexing." })}\n`); } });
const statusArgs = [JSON_ARGUMENT, { name: "deep", summary: "Provider probe", description: "Explicit provider readiness probe", kind: "flag", effect: "destroy" }, ...CONSENT] as const;
const status = defineAction({ summary: "Each agent's memory state; --deep probes the provider", effect: "read", arguments: statusArgs,
  rules: [{ rule: "requires", name: "deep", with: ["allow-spend", "allow-download"] }, { rule: "requires", name: "allow-spend", with: ["deep"] }, { rule: "requires", name: "allow-download", with: ["deep"] }],
  async prepare(_call, local) { const d = await localDeclaration(local); return { ..._call.values, disabled: declaredMemory(d.ops).enabled === false }; },
  async run(ctx, v) {
    if (v.disabled) { emit(`${JSON.stringify({ ok: true, changed: false, state: "intentional-disabled", status: [] })}\n`); return; }
    const run = async () => { const remaining = budget(), normal = safeStatus(await rawStatus(ctx, remaining)); let deep: unknown, failure: unknown;
      if (v.deep) { try { deep = safeStatus(await rawStatus(ctx, remaining, true)); } catch (e) { failure = e instanceof MemoryError ? { code: e.code, advice: e.advice } : { code: "UNREACHABLE" }; } }
      const ok = !failure && normal.every((row) => (row as { ok?: boolean }).ok !== false) && (!Array.isArray(deep) || deep.every((row) => (row as { ok?: boolean }).ok !== false));
      emit(`${JSON.stringify({ ok, changed: v.deep, status: normal, ...(v.deep ? { deep: deep ?? null, error: failure ?? null } : {}) })}\n`); return ok ? 0 : 1; };
    if (v.deep) return guardedWith(ctx, "memory status deep", { breakLock: false }, run); return run();
  } });
function consumerAction(verify: boolean) {
  return defineAction({ summary: verify ? "Prove memory search finds a fresh test note" : "Rebuild the memory index of the selected agents", effect: "destroy", arguments: SELECT,
    rules: [{ rule: "requires", name: "allow-spend", with: ["allow-download"] }, { rule: "requires", name: "allow-download", with: ["allow-spend"] }, { rule: "oneOf", groups: [["agent"], ["all-agents"]], required: true }],
    async prepare(call, local) { const d = await localDeclaration(local), config = declaredMemory(d.ops); modeOf(config);
      if (!d.ops.some((op) => op.path === "memory.backend" && op.value === "builtin")) return call.refuse("agent", "requires explicit builtin declaration");
      const v = call.values;
      if (modeOf(config) !== "embeddings" && (v["allow-spend"] || v["allow-download"] || v["model-checksum"] || v["model-source"] || v["model-version"])) return call.refuse("agent", "keyword/disabled refuse embedding consent and model approvals");
      if (modeOf(config) === "embeddings" && config.provider === "local" && (!v["model-checksum"] || !v["model-source"] || !v["model-version"])) return call.refuse("model-checksum", "local indexing requires approved SHA256/source/version before target contact");
      if (config.provider !== "local" && (v["model-checksum"] || v["model-source"] || v["model-version"])) return call.refuse("model-checksum", "model approvals apply only to local provider");
      return { ...v, config }; },
    async run(ctx, p) { const work = () => consume(ctx, p.config, p.agent, p["all-agents"], verify, consent(p));
      const result = modeOf(p.config) === "disabled" ? await work() : await guardedWith(ctx, verify ? "memory verify" : "memory index", { breakLock: false }, work);
      emit(`${JSON.stringify(result)}\n`); return result.ok ? 0 : 1; },
  });
}
export const MEMORY = multiActionBody({ effect: "read", action: { description: "Memory action" }, actions: { plan, configure: configureAction, setup: SETUP, status, index: consumerAction(false), verify: consumerAction(true) } });
