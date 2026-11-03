import { posix } from "node:path";
import { randomUUID } from "node:crypto";
import type { Context } from "#src/core/context.ts";
import type { ExecResult } from "#src/runtime/transport/transport.ts";
import { CLI_HELPER_SERVICE } from "#src/commands/interface/cli-helper.ts";
import { MemoryError, object, modeOf, type MemoryConfig } from "./declaration.ts";
import { readResourceBindings, selectResourceAgents, RESOURCE_SNAPSHOT_SCRIPT, type ResourceBinding } from "./resources.ts";
import { readNativeSnapshot, requireNativeLoaded, type NativeIO } from "./native.ts";
export const OPERATION_MS = 240000, CLEANUP_MS = 60000, CALL_MS = 60000;
const remedy = "Inspect current config/host/exec/plugin tools; approve only source/version-pinned delivery or installation. No automatic install, download or upgrade.";
export interface Consent { spend?: boolean; download?: boolean; checksum?: string; source?: string; version?: string }
export function budget(milliseconds = OPERATION_MS): () => number {
  const end = Date.now() + milliseconds;
  return () => { const left = Math.min(CALL_MS, end - Date.now()); if (left <= 0) throw new MemoryError("DEADLINE", "Budget expired before operation; inspect reachability before retrying."); return left; };
}
export async function cli(ctx: Context, args: string[], remaining: () => number): Promise<ExecResult> {
  const timeoutMs = remaining();
  try { return await ctx.runtime.execInHelper(CLI_HELPER_SERVICE, args, { input: "", allowFailure: true, timeoutMs }); }
  catch (cause) { if (object(cause).code === "HELPER_QUIESCENCE") throw new MemoryError("QUIESCENCE", "Owned process group is unconfirmed; stop mutations and inspect before recovery.", { exitCode: object(cause).exitCode, timedOut: object(cause).timedOut }); throw new MemoryError("UNREACHABLE", "Check target/gateway and explicitly cli-start the cli-helper; no silent one-off or helper start.", cause); }
}
export function decode(result: ExecResult): unknown {
  if (result.code !== 0 || result.timedOut) {
    const diagnostic = result.stderr + result.stdout;
    const code = result.timedOut ? "DEADLINE" : /missing-provider-auth|No API key|authentication/i.test(diagnostic) ? "AUTH" : /missing-model|model-not-found/i.test(diagnostic) ? "MODEL" : /missing-plugin|plugin-not-found/i.test(diagnostic) ? "PLUGIN" : "UNREACHABLE";
    throw new MemoryError(code, remedy, { exitCode: result.code, timedOut: result.timedOut === true });
  }
  try { return JSON.parse(result.stdout); } catch { throw new MemoryError("UNSUPPORTED", "CLI JSON contract unsupported; inspect installed capabilities."); }
}
export function decodeIndex(result: ExecResult): void { if (result.code !== 0 || result.timedOut) decode(result); }
export async function rawStatus(ctx: Context, remaining: () => number, deep = false, agent?: string): Promise<unknown> {
  return decode(await cli(ctx, ["memory", "status", "--json", ...(deep ? ["--deep"] : []), ...(agent ? ["--agent", agent] : [])], remaining));
}
function providerState(s: Record<string, unknown>): unknown {
  const state = object(s.custom).providerState ?? s.providerState;
  return typeof state === "string" ? state : object(state).mode ?? object(state).status;
}
export function failureFacts(error: unknown): Record<string, unknown> {
  const e = error instanceof MemoryError ? error : undefined, cause = object(e?.cause);
  return { code: e?.code ?? "UNREACHABLE", ...(typeof cause.exitCode === "number" ? { exitCode: cause.exitCode } : {}), ...(cause.timedOut === true ? { timedOut: true } : {}), ...(cause.primary ? { primary: failureFacts(cause.primary) } : {}), ...(cause.cleanup ? { cleanup: failureFacts(cause.cleanup) } : {}) };
}
function rowError(row: Record<string, unknown>): string | undefined {
  if (!row.error) return undefined;
  const code = object(row.error).code;
  return typeof code === "string" && ["missing-provider-auth", "missing-model", "missing-plugin", "unsupported", "unreachable", "disabled"].includes(code) ? code : "unknown-error";
}
export function ready(raw: unknown, agent: string, config: MemoryConfig): Record<string, unknown> {
  if (!Array.isArray(raw)) throw new MemoryError("UNSUPPORTED", remedy);
  const rows = raw.filter((v) => object(v).agentId === agent);
  if (rows.length !== 1) throw new MemoryError("UNSUPPORTED", "Selected agent needs exactly one supported status record.");
  const row = object(rows[0]), error = rowError(row);
  if (error) throw new MemoryError(error === "missing-provider-auth" ? "AUTH" : error === "missing-model" ? "MODEL" : error === "missing-plugin" ? "PLUGIN" : error === "unreachable" ? "UNREACHABLE" : error === "disabled" ? "DISABLED" : "UNSUPPORTED", "Agent reported an error; inspect its safe metadata before indexing.");
  const s = object(row.status), mode = modeOf(config);
  if (s.backend !== "builtin") throw new MemoryError("UNSUPPORTED", "Only declared builtin backend is supported.");
  if ((mode === "keyword" ? s.provider !== null && s.provider !== "none" : s.provider !== config.provider) || s.requestedProvider !== config.provider || (mode === "embeddings" && s.model !== config.model)) throw new MemoryError("STALE", "Apply declared leaf settings and restart explicitly before indexing.");
  if (object(s.fts).enabled !== true || object(s.fts).available !== true) throw new MemoryError("FTS", "Keep hybrid enabled and inspect FTS availability.");
  if (mode === "keyword" && object(s.vector).enabled !== false) throw new MemoryError("STALE", "Keyword requires explicitly disabled vector storage.");
  if (mode === "embeddings") {
    const state = providerState(s), failures: Record<string, string> = { "missing-provider-auth": "AUTH", "missing-model": "MODEL", "model-not-found": "MODEL", "missing-plugin": "PLUGIN" };
    if (typeof state === "string" && failures[state]) throw new MemoryError(failures[state], remedy);
    if (state !== "ready") throw new MemoryError("UNSUPPORTED", "Provider readiness pending/unknown; opt into spend/download consent for an explicit deep preflight.");
    if (object(s.vector).enabled !== true || object(s.vector).available !== true) throw new MemoryError("VECTOR", "Explicit available vector metadata is required before embedding indexing.");
  }
  return s;
}
export function safeStatus(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) { const error = rowError(object(raw)); if (error) return [{ agentId: null, ok: false, error: { code: error } }]; throw new MemoryError("UNSUPPORTED", "Unsupported status inventory shape."); }
  if (raw.length > 128) throw new MemoryError("UNSUPPORTED", "Status inventory exceeds the bounded supported contract.");
  return raw.map((v) => {
    const row = object(v), s = object(row.status), custom = object(s.custom);
    const error = rowError(row);
    if (error) return { agentId: typeof row.agentId === "string" ? row.agentId.slice(0, 128) : null, ok: false, error: { code: error } };
    if (typeof row.agentId !== "string" || s.backend !== "builtin") return { agentId: typeof row.agentId === "string" ? row.agentId.slice(0, 128) : null, ok: false, code: "UNSUPPORTED" };
    const state = providerState(s), allowed = ["ready", "pending", "missing-provider-auth", "missing-model", "missing-plugin"];
    return { agentId: row.agentId.slice(0, 128), ok: !rowError(row), ...(rowError(row) ? { error: { code: rowError(row) } } : {}), backend: "builtin", provider: typeof s.provider === "string" ? s.provider.slice(0, 128) : null,
      requestedProvider: typeof s.requestedProvider === "string" ? s.requestedProvider.slice(0, 128) : null,
      files: Number.isSafeInteger(s.files) ? s.files : null, chunks: Number.isSafeInteger(s.chunks) ? s.chunks : null, dirty: typeof s.dirty === "boolean" ? s.dirty : null,
      fts: { enabled: object(s.fts).enabled === true, available: object(s.fts).available === true }, vector: { enabled: object(s.vector).enabled === true, available: object(s.vector).available === true },
      custom: { providerState: allowed.includes(String(state)) ? state : "unknown", indexIdentity: ["valid", "stale", "missing"].includes(String(object(custom.indexIdentity).status)) ? object(custom.indexIdentity).status : "unknown", searchMode: ["hybrid", "keyword", "vector"].includes(String(custom.searchMode)) ? custom.searchMode : "unknown" } };
  });
}
export async function node(ctx: Context, script: string, args: string[], remaining: () => number): Promise<ExecResult> {
  const timeoutMs = remaining();
  if (!ctx.runtime.execCommand) throw new MemoryError("UNSUPPORTED", "Bounded helper execCommand capability required.");
  try { return await ctx.runtime.execCommand(CLI_HELPER_SERVICE, "node", ["-e", script, ...args], { input: "", allowFailure: true, timeoutMs }); }
  catch (cause) { if (object(cause).code === "HELPER_QUIESCENCE") throw new MemoryError("QUIESCENCE", "Owned helper process group unconfirmed; no further mutation authorized.", { exitCode: object(cause).exitCode, timedOut: object(cause).timedOut }); throw cause; }
}
export const MODEL_CHECK_SCRIPT = `const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');(async()=>{const [raw,rawRoot,hash]=process.argv.slice(1),file=path.resolve(raw),root=path.resolve(rawRoot);if(fs.realpathSync(file)!==file||!fs.realpathSync(file).startsWith(fs.realpathSync(root)+path.sep)||!fs.statSync(file).isFile())return 2;const h=crypto.createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex')===hash?0:3})().then(code=>process.exit(code),()=>process.exit(2))`;
export function managedModelPath(path: unknown, root: string): string {
  if (typeof path !== "string" || !posix.isAbsolute(path) || path !== posix.normalize(path) || !path.startsWith(`${posix.normalize(root)}/`) || !path.endsWith(".gguf")) throw new MemoryError("MODEL", "Require canonical lexical GGUF path inside managed models, before filesystem access.");
  return path;
}
export async function localPrerequisites(ctx: Context, config: MemoryConfig, remaining: () => number, consent: Consent, guard: () => Promise<void> = async () => {}): Promise<void> {
  if (modeOf(config) !== "embeddings" || config.provider !== "local") return;
  const root = ctx.paths.toContainer(`${ctx.settings.dataDir}/config/models`), path = managedModelPath(config.local?.modelPath, root);
  if (!consent.checksum || !/^[a-f0-9]{64}$/.test(consent.checksum) || !consent.source || !consent.version) throw new MemoryError("MODEL", "Supply approved model checksum, source and version; use current host/exec tools for deliberate delivery.");
  await guard();
  const result = await node(ctx, MODEL_CHECK_SCRIPT, [path, root, consent.checksum], remaining);
  if (result.code !== 0 || result.timedOut) throw new MemoryError(result.timedOut ? "DEADLINE" : "MODEL", "Managed model missing, symlinked or checksum mismatch; no install/download performed.", { exitCode: result.code, timedOut: result.timedOut === true });
  const io: NativeIO = {
    cli: async (args, _intent) => { await guard(); return cli(ctx, args, remaining); },
    node: async (script, args, _intent) => { await guard(); return node(ctx, script, args, remaining); },
  };
  const snapshot = await readNativeSnapshot(io, ctx.paths.toContainer(`${ctx.settings.dataDir}/config`));
  requireNativeLoaded(snapshot);
}
export function witnessMatch(raw: unknown, path: string, token: string): boolean {
  const results = object(raw).results;
  if (!Array.isArray(results)) throw new MemoryError("UNSUPPORTED", "Unsupported search envelope.");
  return results.some((r) => { const h = object(r); return h.source === "memory" && h.path === path && Number.isInteger(h.startLine) && h.startLine === 1 && Number.isInteger(h.endLine) && typeof h.endLine === "number" && h.endLine >= 1 && typeof h.snippet === "string" && h.snippet.includes(token); });
}
export interface WitnessIdentity { dev: number; ino: number; uid?: number }
export interface WitnessReceipt extends WitnessIdentity { directory?: WitnessIdentity & { created: boolean }; workspace?: WitnessIdentity }
export const WITNESS_CREATE_SCRIPT = `const fs=require('node:fs'),path=require('node:path');const [raw,rawFile,t]=process.argv.slice(1),w=path.resolve(raw),m=path.join(w,'memory'),f=path.resolve(rawFile);let code=0,created=false,dir,ws,owned;function same(p,s){const n=fs.lstatSync(p);return !n.isSymbolicLink()&&n.dev===s.dev&&n.ino===s.ino&&(s.uid===undefined||n.uid===s.uid)}try{if(process.getuid()!==1000||fs.realpathSync(w)!==w||path.dirname(f)!==m)throw Error('boundary');ws=fs.lstatSync(w);try{fs.mkdirSync(m,{mode:0o700});created=true}catch(e){if(e.code!=='EEXIST')throw e}dir=fs.lstatSync(m);if(!dir.isDirectory()||dir.isSymbolicLink()||(created&&(dir.uid!==1000||(process.platform!=='win32'&&(dir.mode&0o077)!==0)))||fs.realpathSync(m)!==m||!same(w,ws))throw Error('boundary');const fd=fs.openSync(f,'wx',0o600);try{owned=fs.fstatSync(fd);if(owned.uid!==1000||(process.platform!=='win32'&&(owned.mode&0o077)!==0))throw Error('ownership');fs.writeFileSync(fd,t+'\\n');console.log(JSON.stringify({dev:owned.dev,ino:owned.ino,uid:owned.uid,directory:{dev:dir.dev,ino:dir.ino,uid:dir.uid,created},workspace:{dev:ws.dev,ino:ws.ino,uid:ws.uid}}))}finally{fs.closeSync(fd)}}catch(e){code=e.code==='EEXIST'?73:74;try{if(owned&&same(w,ws)&&same(m,dir)&&same(f,owned))fs.unlinkSync(f);if(created&&dir&&same(w,ws)&&same(m,dir))fs.rmdirSync(m)}catch{}}if(code)process.exit(code)`;
export const WITNESS_CLEANUP_SCRIPT = `const fs=require('node:fs'),path=require('node:path');const [f,dev,ino,raw]=process.argv.slice(1),receipt=JSON.parse(raw),m=path.dirname(f),w=path.dirname(m);function same(p,s){const n=fs.lstatSync(p);return !n.isSymbolicLink()&&n.dev===s.dev&&n.ino===s.ino&&(s.uid===undefined||n.uid===s.uid)}let code=0;try{if(process.getuid()!==1000||fs.realpathSync(w)!==w||fs.realpathSync(m)!==m)throw Error('boundary');if(receipt.workspace&&!same(w,receipt.workspace))throw Error('workspace replaced');if(receipt.directory&&!same(m,receipt.directory))throw Error('directory replaced');const s=fs.lstatSync(f);if(!s.isFile()||s.isSymbolicLink()||s.uid!==1000||(receipt.uid!==undefined&&s.uid!==receipt.uid)||String(s.dev)!==dev||String(s.ino)!==ino)throw Error('file replaced');fs.unlinkSync(f);let removed=false;if(receipt.directory?.created){if(receipt.directory.uid!==1000||!same(m,receipt.directory))throw Error('directory replaced');try{fs.rmdirSync(m);removed=true}catch(e){if(e.code!=='ENOTEMPTY'&&e.code!=='EEXIST')throw e}}console.log(JSON.stringify({fileRemoved:true,directoryRemoved:removed}))}catch{code=2}if(code)process.exit(code)`;
export async function witness(ctx: Context, agent: string, status: Record<string, unknown>, remaining: () => number, witnessToken = `cfmemory${randomUUID().replaceAll("-", "")}`, guard: (remaining?: () => number) => Promise<void> = async () => {}): Promise<void> {
  const workspace = status.workspaceDir;
  if (typeof workspace !== "string") throw new MemoryError("UNSUPPORTED", "Workspace path metadata is required.");
  const target = ctx.paths.fromContainer(workspace);
  if (!target.startsWith(`${ctx.settings.dataDir}/`) || target.includes("..")) throw new MemoryError("UNSUPPORTED", "Workspace must map inside managed data.");
  const token = witnessToken, relative = `memory/${token}.md`, file = `${workspace}/${relative}`;
  await guard();
  const created = decode(await node(ctx, WITNESS_CREATE_SCRIPT, [workspace, file, token], remaining));
  let primary: unknown, cleanup: unknown;
  try {
    await guard();
    decodeIndex(await cli(ctx, ["memory", "index", "--agent", agent, "--force"], remaining));
    await guard();
    const search = decode(await cli(ctx, ["memory", "search", "--agent", agent, "--query", token, "--json"], remaining));
    if (!witnessMatch(search, relative, token)) {
      const after = await rawStatus(ctx, remaining), rows = Array.isArray(after) ? after : [];
      const s = object(object(rows.find((v) => object(v).agentId === agent)).status);
      const code = s.dirty === true || object(object(s.custom).indexIdentity).status === "stale" ? "STALE" : s.files === 0 || s.chunks === 0 ? "EMPTY" : "SEARCH";
      throw new MemoryError(code, "Post-index consumer did not return owned witness; inspect empty/stale metadata, not private search snippets.");
    }
  } catch (error) { primary = error; }
  if (primary instanceof MemoryError && primary.code === "QUIESCENCE") throw new MemoryError("QUIESCENCE", "Witness cleanup and reindex deferred until owned-group quiescence is confirmed.", { primary });
  const cleanupBudget = budget(CLEANUP_MS);
  try {
    decodeIndex(await node(ctx, WITNESS_CLEANUP_SCRIPT, [file, String(object(created).dev), String(object(created).ino), JSON.stringify(created)], cleanupBudget));
    await guard(cleanupBudget);
    decodeIndex(await cli(ctx, ["memory", "index", "--agent", agent, "--force"], cleanupBudget));
  } catch (error) { cleanup = error; }
  if (cleanup) throw new MemoryError("CLEANUP", "Owned witness removal/reindex failed; inspect without deleting user files.", { primary, cleanup });
  if (primary) throw primary;
}
export async function agents(ctx: Context, selected: string | undefined, all: boolean, remaining: () => number): Promise<readonly string[]> {
  return selectResourceAgents(decode(await cli(ctx, ["agents", "list", "--json"], remaining)), selected, all);
}
export async function consume(ctx: Context, config: MemoryConfig, selected: string | undefined, all: boolean, verify: boolean, consent: Consent = {}): Promise<{ ok: boolean; changed: boolean; resourcePreflightAttempted?: boolean; outcomes: unknown[] }> {
  if (modeOf(config) === "disabled") return { ok: true, changed: false, outcomes: [{ state: "skipped-intentional-disabled" }] };
  const remaining = budget(), ids = await agents(ctx, selected, all, remaining), normal = await rawStatus(ctx, remaining);
  const io = { snapshot: () => node(ctx, RESOURCE_SNAPSHOT_SCRIPT, [], remaining) };
  const bindings = await readResourceBindings(io, config, ids);
  const guard = async (until = remaining) => { await readResourceBindings({ snapshot: () => node(ctx, RESOURCE_SNAPSHOT_SCRIPT, [], until) }, config, ids); };
  const effective = (binding: ResourceBinding): MemoryConfig => ({ ...config, enabled: binding.enabled, provider: binding.provider, fallback: binding.fallback, model: binding.model, local: binding.local ?? config.local, query: { ...config.query, hybrid: { enabled: binding.hybridEnabled } }, store: { ...config.store, vector: { enabled: binding.vectorEnabled } } });
  for (const agent of ids) {
    const approved = effective(bindings.get(agent)!);
    if (approved.provider === "local") managedModelPath(approved.local?.modelPath, ctx.paths.toContainer(`${ctx.settings.dataDir}/config/models`));
  }
  for (const agent of ids) await localPrerequisites(ctx, effective(bindings.get(agent)!), remaining, consent, guard);
  let raw = normal, resourcePreflightAttempted = false;
  if (modeOf(config) === "embeddings" && consent.spend && consent.download) {
    const deepRows: unknown[] = [];
    try {
      for (const agent of ids) {
        await guard(); remaining(); resourcePreflightAttempted = true;
        const scoped = await rawStatus(ctx, remaining, true, agent);
        if (!Array.isArray(scoped) || scoped.some((row) => object(row).agentId !== agent)) throw new MemoryError("UNSUPPORTED", "Scoped deep probe returned an unselected agent or unsupported shape.");
        deepRows.push(...scoped);
      }
      raw = deepRows;
    } catch (e) { const failure = e instanceof MemoryError ? e : new MemoryError("UNREACHABLE", remedy, e); return { ok: false, changed: resourcePreflightAttempted, resourcePreflightAttempted, outcomes: [{ status: safeStatus(normal), ...failureFacts(failure), advice: failure.advice }] }; }
  }
  const outcomes: unknown[] = []; let ok = true, changed = resourcePreflightAttempted;
  for (const agent of ids) {
    try { const s = ready(raw, agent, effective(bindings.get(agent)!)); await guard(); remaining(); changed = true;
      if (verify) await witness(ctx, agent, s, remaining, undefined, guard); else decodeIndex(await cli(ctx, ["memory", "index", "--agent", agent, "--force"], remaining));
      outcomes.push({ agentId: agent, ok: true, state: verify ? "search-proven" : "indexed" });
    } catch (error) { ok = false; const e = error instanceof MemoryError ? error : new MemoryError("UNREACHABLE", remedy, error); outcomes.push({ agentId: agent, ok: false, ...failureFacts(e), advice: e.advice });
      if (e.code === "QUIESCENCE" || object(object(e.cause).cleanup).code === "QUIESCENCE") {
        for (const rest of ids.slice(ids.indexOf(agent) + 1)) outcomes.push({ agentId: rest, ok: false, state: "not-attempted", code: "QUIESCENCE" });
        break;
      }
    }
  }
  return { ok, changed, resourcePreflightAttempted, outcomes };
}
