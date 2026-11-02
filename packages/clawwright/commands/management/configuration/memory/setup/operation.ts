import { posix } from "node:path";
import { randomUUID } from "node:crypto";
import type { Context } from "#src/core/context.ts";
import type { ExecResult } from "#src/runtime/transport/transport.ts";
import { CLI_HELPER_SERVICE } from "#src/commands/interface/cli-helper.ts";
import { MemoryError, object, declaredMemory, modeOf, type Operation } from "#src/commands/management/configuration/memory/declaration.ts";
import { readResourceBindings, assertResourceBindings, parseAgentInventory, selectResourceAgents, RESOURCE_SNAPSHOT_SCRIPT, type ResourceInventory } from "#src/commands/management/configuration/memory/resources.ts";
import { ready } from "#src/commands/management/configuration/memory/consumer.ts";
import { readNativeSnapshot, requireNativeLoaded, installNativePlugin, type NativeIO, type NativeIntent } from "#src/commands/management/configuration/memory/native.ts";
import { approveModel, type ModelApproval } from "./approval.ts";
import { MODEL_SETUP_SCRIPT, type ModelReceipt, type FileIdentity } from "./model.ts";
import { MODEL_ROOT_SCRIPT, type RootFacts } from "./root.ts";

export interface SetupMount {
  readonly source: string;
  readonly destination: string;
  readonly type: string;
  readonly writable: boolean;
}
export interface SetupMountInventory {
  readonly gateway: readonly SetupMount[];
  readonly helper: readonly SetupMount[];
}
export interface SetupPorts {
  readDeclaration(): Promise<readonly Operation[]>;
  readMounts(timeoutMs: number): Promise<SetupMountInventory>;
}
export interface SetupRequest {
  readonly approval: ModelApproval;
  readonly allowInstall: boolean;
  readonly allowDownload: boolean;
  readonly agent?: string;
  readonly allAgents?: boolean;
}
export interface SetupActivity {
  nativeRecordReadAttempted: boolean;
  rootCreationAttempted: boolean;
  pluginInstallAttempted: boolean;
  modelDownloadAttempted: boolean;
  deepProbeAttempted: boolean;
  retainedMaterial: "none" | "confirmed" | "unknown";
  staging: "none" | "confirmed" | "unknown";
}
export interface SetupOutcome {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly code: string;
  readonly activity: SetupActivity;
  readonly agents?: readonly { agentId: string; state: "ready" }[];
  readonly exitCode?: number;
  readonly timedOut?: boolean;
  readonly cleanupCode?: string;
  readonly advice?: string;
}
export interface SetupDeadline {
  remainingMs(): number;
  callMs(capMs?: number): number;
}
export function setupDeadline(milliseconds = 240000): SetupDeadline {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 240000) throw new MemoryError("DEADLINE", "Require a bounded setup deadline.");
  const end = Date.now() + milliseconds;
  const remainingMs = () => {
    const left = end - Date.now();
    if (left <= 0) throw new MemoryError("DEADLINE", "Setup budget exhausted; inspect partial state before retrying.");
    return left;
  };
  return { remainingMs, callMs: (capMs = 60000) => Math.min(capMs, remainingMs()) };
}
function json(result: ExecResult): unknown {
  if (result.timedOut || result.code !== 0) throw new MemoryError(result.timedOut ? "DEADLINE" : "UNSUPPORTED", "Setup read failed; inspect native capability and persistent state.", { exitCode: result.code, timedOut: result.timedOut === true });
  if (result.stdout.length > 4 * 1024 * 1024) throw new MemoryError("UNSUPPORTED", "Setup output exceeds supported bounds.");
  try { return JSON.parse(result.stdout); } catch { throw new MemoryError("UNSUPPORTED", "Setup JSON contract unsupported."); }
}
function identity(value: unknown): FileIdentity {
  const v = object(value);
  if (typeof v.dev !== "string" || typeof v.ino !== "string" || !/^[0-9]{1,32}$/.test(v.dev) || !/^[0-9]{1,32}$/.test(v.ino)) throw new MemoryError("MODEL", "Owned file identity unavailable; cleanup refused.");
  return { dev: v.dev, ino: v.ino };
}
function modelRows(result: ExecResult): { code?: string; ok: boolean; changed: boolean; retained: boolean; receipt?: ModelReceipt } {
  if (result.stdout.length > 16384) throw new MemoryError("MODEL", "Model helper receipt exceeds supported bounds.");
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (lines.length > 2) throw new MemoryError("MODEL", "Ambiguous model helper receipts.");
  let receipt: ModelReceipt | undefined, row: Record<string, unknown> = {};
  for (const line of lines) {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { throw new MemoryError("MODEL", "Model helper receipt unsupported."); }
    const value = object(raw);
    if (value.kind === "model-staging" && !receipt) {
      const r = object(value.receipt);
      receipt = { stage: identity(r.stage), receipt: identity(r.receipt), root: identity(r.root) };
    } else if (value.kind === "model-result" && !row.kind) row = value;
    else throw new MemoryError("MODEL", "Ambiguous model helper receipt.");
  }
  const codes = ["MODEL_PRESENT", "MODEL_MISSING", "MODEL_DOWNLOADED", "MODEL_CLEANED", "MODEL_APPROVAL", "MODEL_INPUT", "MODEL_BOUNDARY", "MODEL_CLEANUP_IDENTITY", "MODEL_QUIESCENCE", "MODEL_DNS", "MODEL_REDIRECT", "MODEL_HTTP", "MODEL_FILE", "MODEL_SIZE", "MODEL_CONTENT", "MODEL_WRITE", "MODEL_PUBLISH", "MODEL_EXISTS", "MODEL_IO", "MODEL_DEADLINE"];
  const code = typeof row.code === "string" && codes.includes(row.code) ? row.code : undefined;
  return { code, ok: row.ok === true && result.code === 0 && !result.timedOut, changed: row.changed === true, retained: row.retainedStage === true, ...(receipt ? { receipt } : {}) };
}
export async function setupLocalMemory(ctx: Context, request: SetupRequest, ports: SetupPorts): Promise<SetupOutcome> {
  const activity: SetupActivity = { nativeRecordReadAttempted: false, rootCreationAttempted: false, pluginInstallAttempted: false, modelDownloadAttempted: false, deepProbeAttempted: false, retainedMaterial: "none", staging: "none" };
  let cleanupCode: string | undefined;
  const changed = () => activity.nativeRecordReadAttempted || activity.rootCreationAttempted || activity.pluginInstallAttempted || activity.modelDownloadAttempted || activity.deepProbeAttempted;
  try {
    const approval = approveModel(request.approval);
    if (request.allowInstall !== true || request.allowDownload !== true) throw new MemoryError("CONSENT", "Both allow-install and allow-download are required before setup, including cached native initialization.");
    if ((typeof request.agent === "string") === (request.allAgents === true)) throw new MemoryError("AGENT", "Select one existing agent or all agents.");
    const deadline = setupDeadline();
    async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
      let timer: NodeJS.Timeout | undefined;
      try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new MemoryError("DEADLINE", "Setup read exceeded its budget.")), milliseconds); })]); }
      finally { if (timer) clearTimeout(timer); }
    }
    async function invokeNode(script: string, args: string[], timeoutMs: number): Promise<ExecResult> {
      if (!ctx.runtime.execCommand) throw new MemoryError("UNSUPPORTED", "Bounded helper execution is required.");
      try { return await ctx.runtime.execCommand(CLI_HELPER_SERVICE, "node", ["-e", script, ...args], { input: "", allowFailure: true, timeoutMs }); }
      catch (error) { if (object(error).code === "HELPER_QUIESCENCE") throw new MemoryError("QUIESCENCE", "Owned helper quiescence unconfirmed; no cleanup or further mutation."); throw error; }
    }
    let selectedIds: readonly string[] | undefined;
    let authoritativeInventory: ResourceInventory | undefined;
    const bareIO: NativeIO = {
      cli: async (args, _intent) => {
        try { return await ctx.runtime.execInHelper(CLI_HELPER_SERVICE, args, { input: "", allowFailure: true, timeoutMs: deadline.callMs() }); }
        catch (error) { if (object(error).code === "HELPER_QUIESCENCE") throw new MemoryError("QUIESCENCE", "Owned helper quiescence unconfirmed; stop setup."); throw error; }
      },
      node: async (script, args, _intent) => {
        const milliseconds = deadline.callMs();
        return invokeNode(script, args, Math.min(milliseconds, deadline.remainingMs()));
      },
    };
    async function dispatchIntent(intent: NativeIntent): Promise<void> {
      if (intent.role === "read") return;
      await match(true);
      if (intent.role === "record-inspect" || intent.role === "install") {
        await mounts();
        if (intent.role === "record-inspect") activity.nativeRecordReadAttempted = true;
        else activity.pluginInstallAttempted = true;
        if (intent.role === "install" || activity.retainedMaterial === "none") activity.retainedMaterial = "unknown";
      } else if (intent.role === "deep-probe") {
        activity.deepProbeAttempted = true;
        if (activity.retainedMaterial === "none") activity.retainedMaterial = "unknown";
      }
    }
    const io: NativeIO = {
      cli: async (args, intent) => { await dispatchIntent(intent); return bareIO.cli(args, intent); },
      node: async (script, args, intent) => { await dispatchIntent(intent); return bareIO.node(script, args, intent); },
    };
    const targetConfig = posix.join(ctx.settings.dataDir, "config");
    const configRoot = ctx.paths.toContainer(targetConfig), modelsRoot = posix.join(configRoot, "models");
    const declared = [...await bounded(ports.readDeclaration(), deadline.callMs())];
    const config = declaredMemory(declared);
    if (!declared.some((op) => op.path === "memory.backend" && op.value === "builtin") || modeOf(config) !== "embeddings" || config.provider !== "local") throw new MemoryError("UNDECLARED", "Setup requires explicit builtin local embedding declarations.");
    const modelPath = config.local?.modelPath;
    if (typeof modelPath !== "string" || posix.normalize(modelPath) !== modelPath || posix.dirname(modelPath) !== modelsRoot || config.model !== modelPath || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/.test(posix.basename(modelPath)) || modelPath.includes("..")) throw new MemoryError("MODEL", "Local model and modelPath must equal a canonical direct-child managed GGUF path.");
    const validatedModelPath: string = modelPath;
    if (object(config.local).modelCacheDir !== undefined || object(config.local).nodeLlamaCppImportUrl !== undefined) throw new MemoryError("UNSUPPORTED", "Unreviewed local cache/import overrides refuse setup.");
    async function match(requireSelection = false): Promise<void> {
      const now = [...await bounded(ports.readDeclaration(), deadline.callMs())];
      if (!now.some((op) => op.path === "memory.backend" && op.value === "builtin")) throw new MemoryError("STALE", "Declared backend changed; no further resources authorized.");
      const backend = json(await bareIO.cli(["config", "get", "memory.backend", "--json"], { role: "read" }));
      if (backend !== "builtin") throw new MemoryError("STALE", "Live backend differs from approval.");
      if (!selectedIds) {
        if (requireSelection) throw new MemoryError("AGENT", "Selected resource inventory must be established before resource access.");
        return;
      }
      if (!authoritativeInventory) throw new MemoryError("AGENT", "Authoritative native inventory is required before resource validation.");
      assertResourceBindings({ defaults: { memorySearch: declaredMemory(now) } }, config, selectedIds, authoritativeInventory);
      await readResourceBindings({ snapshot: () => bareIO.node(RESOURCE_SNAPSHOT_SCRIPT, [], { role: "read" }) }, config, selectedIds);
    }
    async function mounts(): Promise<void> {
      const inventory = await bounded(ports.readMounts(deadline.callMs()), deadline.callMs());
      for (const list of [inventory.gateway, inventory.helper]) {
        if (!Array.isArray(list) || list.length > 128) throw new MemoryError("MOUNT", "Runtime mount inventory unsupported.");
        const selected = list.filter((m) => m.destination === configRoot);
        if (selected.length !== 1 || selected[0].type !== "bind" || selected[0].source !== targetConfig || selected[0].writable !== true || list.some((m) => m.destination !== configRoot && (validatedModelPath === m.destination || validatedModelPath.startsWith(m.destination + "/") || modelsRoot === m.destination))) throw new MemoryError("MOUNT", "Gateway/helper must share the expected writable persistent config bind without model shadow mounts.");
      }
    }
    async function rootProbe(operation: "inspect" | "create", expectedRoot?: FileIdentity, expectedModels?: FileIdentity): Promise<RootFacts> {
      const result = await io.node(MODEL_ROOT_SCRIPT, [JSON.stringify({ operation, configRoot, ...(expectedRoot ? { expected: expectedRoot } : {}), ...(expectedModels ? { expectedModels } : {}) })], { role: "resource-read" });
      const row = object(result.stdout.length <= 4096 ? (() => { try { return JSON.parse(result.stdout); } catch { return {}; } })() : {});
      if (row.created === true) activity.retainedMaterial = "confirmed";
      if (result.timedOut || result.code !== 0 || row.ok !== true || typeof row.exists !== "boolean" || !["ROOT_MISSING", "ROOT_PRESENT", "ROOT_CREATED"].includes(String(row.code))) throw new MemoryError("ROOT", "Owned persistent model-root preflight failed.");
      return { ok: true, code: String(row.code), changed: row.changed === true, created: row.created === true, exists: row.exists, config: identity(row.config), ...(row.models ? { models: identity(row.models) } : {}) };
    }
    await match(); await mounts();
    const inventory = json(await io.cli(["agents", "list", "--json"], { role: "read" }));
    authoritativeInventory = parseAgentInventory(inventory);
    const selected = selectResourceAgents(inventory, request.agent, request.allAgents === true);
    selectedIds = selected;
    await match(true);
    const statusHelp = await io.cli(["memory", "status", "--help"], { role: "read" });
    if (statusHelp.code !== 0 || statusHelp.timedOut || !/--agent(?:\s|=)/.test(statusHelp.stdout) || !/--deep\b/.test(statusHelp.stdout) || !/--json\b/.test(statusHelp.stdout)) throw new MemoryError("UNSUPPORTED", "Selected-agent deep status capability must be established before setup; unrestricted inventory probes are refused.");
    const snapshot = await readNativeSnapshot(io, configRoot, approval.pluginVersion);
    if (snapshot.scope.denied || snapshot.scope.globallyDisabled || snapshot.scope.selectedDisabled) throw new MemoryError("PLUGIN", "Explicit disabled/denied plugin policy refuses setup.");
    if (snapshot.plugin) requireNativeLoaded(snapshot);
    else {
      const help = await io.cli(["plugins", "install", "--help"], { role: "read" });
      if (help.code !== 0 || help.timedOut || !/--pin\b/.test(help.stdout)) throw new MemoryError("UNSUPPORTED", "Exact pinned native install capability is required before delivery.");
    }
    let root = await rootProbe("inspect");
    const token = randomUUID();
    const modelInput = { approval, root: modelsRoot, filename: posix.basename(validatedModelPath), token };
    async function inspectModel(): Promise<boolean> {
      const result = await io.node(MODEL_SETUP_SCRIPT, [JSON.stringify({ ...modelInput, expectedRoot: root.models, operation: "inspect", timeoutMs: deadline.callMs() })], { role: "resource-read" });
      const facts = modelRows(result);
      if (facts.ok && facts.code === "MODEL_PRESENT") return true;
      if (facts.code === "MODEL_MISSING" && !result.timedOut) return false;
      throw new MemoryError("MODEL", "Existing model failed bounded GGUF/checksum verification; never overwrite.");
    }
    let present = root.exists ? await inspectModel() : false;
    if (!snapshot.plugin) {
      await match(); await mounts();
      const installed = await installNativePlugin(io, configRoot, approval.pluginVersion, true);
      requireNativeLoaded(installed.snapshot);
      if (activity.pluginInstallAttempted) activity.retainedMaterial = "confirmed";
    }
    if (!root.exists) {
      await match(); await mounts();
      activity.rootCreationAttempted = true;
      activity.retainedMaterial = activity.retainedMaterial === "none" ? "unknown" : activity.retainedMaterial;
      root = await rootProbe("create", root.config);
      if (root.created) activity.retainedMaterial = "confirmed";
    }
    present = await inspectModel();
    if (!present) {
      await match(); await mounts(); await rootProbe("inspect", root.config, root.models);
      await match(true);
      const milliseconds = deadline.remainingMs();
      activity.modelDownloadAttempted = true; activity.staging = "unknown";
      let result: ExecResult;
      try { result = await invokeNode(MODEL_SETUP_SCRIPT, [JSON.stringify({ ...modelInput, expectedRoot: root.models, operation: "download", timeoutMs: milliseconds })], milliseconds); }
      catch (error) { activity.retainedMaterial = "unknown"; throw error; }
      const facts = modelRows(result);
      activity.staging = facts.retained ? "confirmed" : facts.code ? "none" : "unknown";
      if (facts.ok && facts.code === "MODEL_DOWNLOADED") activity.retainedMaterial = "confirmed";
      else {
        if (facts.receipt && (result.timedOut || facts.retained) && facts.code !== "MODEL_QUIESCENCE") {
          const cleanupBudget = setupDeadline(60000);
          const clean = await invokeNode(MODEL_SETUP_SCRIPT, [JSON.stringify({ ...modelInput, expectedRoot: root.models, operation: "cleanup", timeoutMs: cleanupBudget.remainingMs(), quiescent: true, receipt: facts.receipt })], cleanupBudget.remainingMs());
          const cleanup = modelRows(clean);
          cleanupCode = cleanup.code ?? "MODEL_IO";
          activity.staging = cleanup.ok ? "none" : "confirmed";
        } else if (result.timedOut && !facts.receipt) activity.staging = "unknown";
        throw new MemoryError(facts.code === "MODEL_QUIESCENCE" ? "QUIESCENCE" : result.timedOut ? "DEADLINE" : "MODEL", "Model delivery failed; inspect retained partial material before retrying.", { exitCode: result.code, timedOut: result.timedOut === true });
      }
    }
    await match(); await mounts(); await rootProbe("inspect", root.config, root.models);
    if (!await inspectModel()) throw new MemoryError("MODEL", "Verified model disappeared before native initialization.");
    requireNativeLoaded(await readNativeSnapshot(io, configRoot, approval.pluginVersion));
    await match();
    for (const agent of selected) {
      await match(); await mounts(); await rootProbe("inspect", root.config, root.models);
      const deep = json(await io.cli(["memory", "status", "--agent", agent, "--json", "--deep"], { role: "deep-probe" }));
      ready(deep, agent, config);
    }
    return { ok: true, changed: changed(), code: "READY", activity, agents: selected.map((agentId) => ({ agentId, state: "ready" })) };
  } catch (error) {
    const e = error instanceof MemoryError ? error : undefined, cause = object(e?.cause);
    const allowed = ["CONSENT", "AGENT", "DEADLINE", "UNSUPPORTED", "UNDECLARED", "DECLARATION", "STALE", "MODEL", "ROOT", "MOUNT", "PLUGIN", "QUIESCENCE", "FTS", "VECTOR", "AUTH", "DISABLED"];
    const code = e && allowed.includes(e.code) ? e.code : "UNSUPPORTED";
    return { ok: false, changed: changed(), code, activity, ...(cleanupCode ? { cleanupCode } : {}),
      ...(typeof cause.exitCode === "number" && Number.isInteger(cause.exitCode) ? { exitCode: cause.exitCode } : {}),
      ...(cause.timedOut === true ? { timedOut: true } : {}),
      advice: "Inspect configuration, explicit approvals, native policy and retained persistent material. No automatic retry, restart, overwrite or rollback." };
  }
}
