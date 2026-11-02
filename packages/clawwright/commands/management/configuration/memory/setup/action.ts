import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { defineAction, type ArgumentSpec } from "#src/core/command/index.ts";
import * as kinds from "#src/core/values/kinds.ts";
import { emit } from "#src/core/io/output.ts";
import { guardedWith } from "#src/runtime/lock/instance-lock.ts";
import { deploymentDir } from "#src/runtime/deployment.ts";
import { declaration, declaredMemory, modeOf, MemoryError } from "#src/commands/management/configuration/memory/declaration.ts";
import { approveModel } from "./approval.ts";
import { setupLocalMemory, type SetupRequest, type SetupPorts } from "./operation.ts";
import { readSetupMounts } from "./mounts.ts";
import { sha256, modelSource, modelRevision, pluginVersion } from "#src/commands/management/configuration/memory/values.ts";

const ARGUMENTS = [
  { name: "model-source", summary: "GGUF source", description: "Approved immutable HTTPS GGUF source", kind: "option", valueName: "url", required: true, value: modelSource() },
  { name: "model-version", summary: "GGUF revision", description: "Approved immutable model revision", kind: "option", valueName: "revision", required: true, value: modelRevision() },
  { name: "model-checksum", description: "Approved GGUF SHA256", kind: "option", valueName: "sha256", required: true, value: sha256() },
  { name: "plugin-version", summary: "Plugin version", description: "Approved exact native plugin version", kind: "option", valueName: "version", required: true, value: pluginVersion() },
  { name: "model-max-bytes", summary: "Max GGUF bytes", description: "Approved maximum GGUF download bytes", kind: "option", valueName: "bytes", required: true, value: kinds.positive("a positive byte limit") },
  { name: "agent", description: "Existing agent id", kind: "option", valueName: "id", value: kinds.providerId() },
  { name: "all-agents", summary: "Every agent", description: "Select every existing agent", kind: "flag" },
  { name: "allow-install", summary: "Plugin install consent", description: "Consent to approved native plugin installation", kind: "flag" },
  { name: "allow-download", summary: "GGUF download", description: "Consent to approved GGUF download", kind: "flag" },
  { name: "json", description: "Structured outcome", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

export const SETUP = defineAction({
  summary: "Install the approved local embedding plugin and model",
  effect: "destroy",
  needs: "target",
  arguments: ARGUMENTS,
  rules: [{ rule: "oneOf", groups: [["agent"], ["all-agents"]], required: true }],
  async prepare(call, local) {
    const v = call.values;
    if (!v["allow-install"]) return call.refuse("allow-install", "setup requires explicit installation consent before target contact");
    if (!v["allow-download"]) return call.refuse("allow-download", "setup requires explicit download consent before target contact");
    const path = resolve(local.deployment().dir, "config", "desired-state.json");
    const text = await local.readText(path);
    if (text === undefined) throw new MemoryError("DECLARATION", "Canonical desired-state file must already exist before setup.");
    const ops = declaration(text), config = declaredMemory(ops);
    if (!ops.some((op) => op.path === "memory.backend" && op.value === "builtin")) return call.refuse("agent", "setup requires an explicit builtin memory declaration");
    if (modeOf(config) !== "embeddings" || config.provider !== "local") return call.refuse("agent", "setup applies only to explicitly declared local embeddings");
    const modelPath = config.local?.modelPath;
    if (typeof modelPath !== "string" || !posix.isAbsolute(modelPath) || posix.normalize(modelPath) !== modelPath || modelPath.includes("\\") || !modelPath.endsWith(".gguf") || config.model !== modelPath) {
      return call.refuse("agent", "local model identity must equal its canonical absolute native GGUF path");
    }
    let approval;
    try {
      approval = approveModel({ source: v["model-source"], modelVersion: v["model-version"], checksum: v["model-checksum"], pluginVersion: v["plugin-version"], maxBytes: v["model-max-bytes"] });
    } catch {
      return call.refuse("model-source", "requires immutable approved source/revision, SHA256, exact plugin version and bounded byte limit");
    }
    return { config, approval, agent: v.agent, allAgents: v["all-agents"], allowInstall: v["allow-install"], allowDownload: v["allow-download"] };
  },
  async run(ctx, plan) {
    const declarationPath = resolve(deploymentDir(), "config", "desired-state.json");
    const request: SetupRequest = { approval: plan.approval, agent: plan.agent, allAgents: plan.allAgents, allowInstall: plan.allowInstall, allowDownload: plan.allowDownload };
    const ports: SetupPorts = {
      async readDeclaration() {
        try { return declaration(await readFile(declarationPath, "utf8")); }
        catch { throw new MemoryError("DECLARATION", "Canonical deployment declaration is unreadable or invalid; review before setup."); }
      },
      readMounts: (timeoutMs) => readSetupMounts(ctx, timeoutMs),
    };
    const result = await guardedWith(ctx, "memory setup", { breakLock: false }, () => setupLocalMemory(ctx, request, ports));
    emit(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  },
});
