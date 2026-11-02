// Reconciliation for `clawwright provision-agent`: mirroring a recipe's files onto the
// target, and creating/replacing/removing the agent, MCP server and cron job it declares.
// declaration.ts has the argv/comparison functions these call; index.ts is the top-level
// command and its barrel re-export.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { log } from "#src/core/io/log.ts";
import type { Context } from "#src/core/context.ts";
import { openclawCli, openclawCliJson } from "#src/service/openclaw-cli.ts";
import { readLedger, forgetOwned, ownerOf } from "#src/set/ownership/ledger.ts";
import type { Ledger, OwnedKind } from "#src/set/ownership/ledger.ts";
import { readInstalledSet } from "#src/set/artifacts/install.ts";
import { setSourceDir } from "#src/set/artifacts/source.ts";
import { setManifestId } from "#src/set/artifacts/model.ts";
import {
  collectRecipeFiles,
  recipeMirrorTargetDir,
  agentWorkspaceTargetDir,
  mcpServerMatches,
  mcpAddArgv,
  mcpUnsetArgv,
  cronJobMatches,
  cronAddArgv,
  cronRmArgv,
  agentsAddArgv,
  agentsDeleteArgv,
} from "./declaration.ts";
import type { AgentConfig, RecipeAgentBundle, CronJob } from "./declaration.ts";
import { assertTargetContained } from "./target-boundary.ts";
import { syncFileTree } from "#src/runtime/files/files.ts";

/** Mirrors the recipe's runtime files onto the target, deletions included.
 *
 *  Copying without deleting would not be a mirror: a page removed from the recipe stays on
 *  the target forever, and the agent keeps answering from withdrawn instructions.
 *
 *  Only this directory is mirrored. The agent's workspace is not: its own memory/ sits
 *  beside prompt files, and "delete what the recipe doesn't declare" there would erase
 *  what the agent is meant to accumulate. Emptied subdirectories are left in place.
 *
 *  Returns what changed so the command can report it. */
export async function syncRecipeFiles(
  ctx: Context,
  recipeName: string,
  recipeDir: string,
): Promise<{ written: number; removed: string[] }> {
  const relPaths = await collectRecipeFiles(recipeDir, "agent");
  const targetDir = recipeMirrorTargetDir(ctx.settings.dataDir, recipeName);
  return syncFileTree(ctx.transport, ctx.settings.dataDir, recipeDir, targetDir, relPaths);
}

export async function writeWorkspacePromptFiles(
  ctx: Context,
  config: AgentConfig,
  promptFiles: Record<string, string>,
  managedPromptFiles: readonly string[] = [],
): Promise<void> {
  const targetDir = agentWorkspaceTargetDir(ctx.settings.dataDir, config.agentId);
  const existing = await ctx.transport.listFiles(targetDir);
  const declared = new Set(Object.keys(promptFiles));
  const managed = new Set(managedPromptFiles);
  const stale = existing.filter((rel) => !rel.includes("/") && rel.endsWith(".md") && !declared.has(rel) && managed.has(rel));
  // Same target boundary as the recipe mirror: a prompt name comes from the recipe, and the
  // workspace is reachable by the instance, so the same planted-link threat applies.
  await assertTargetContained(ctx.transport, ctx.settings.dataDir, [
    targetDir,
    ...Object.keys(promptFiles).map((name) => `${targetDir}/${name}`),
    ...stale.map((rel) => `${targetDir}/${rel}`),
  ]);
  // Keep nested state (especially memory/) and all files with no ownership proof untouched.
  // Only a top-level markdown file this agent creation recorded can be withdrawn safely.
  for (const rel of stale) {
    await ctx.transport.remove(`${targetDir}/${rel}`);
  }
  await ctx.transport.mkdirp(targetDir);
  for (const [name, content] of Object.entries(promptFiles)) {
    await ctx.transport.writeFile(`${targetDir}/${name}`, content);
  }
}

export async function ensureAgent(ctx: Context, config: AgentConfig): Promise<boolean> {
  const agents = await openclawCliJson<Array<{ id: string }>>(ctx, ["agents", "list", "--json"]);
  if (agents.some((agent) => agent.id === config.agentId)) return false;
  await openclawCli(ctx, agentsAddArgv(config));
  return true;
}

/** Reconciled the same way ensureCronJob() is: a registration under a command that no
 *  longer matches the recipe is replaced rather than left broken and reported as fine. */
export async function ensureMcpServer(ctx: Context, config: AgentConfig, recipeName: string): Promise<"created" | "replaced" | "unchanged"> {
  const servers = await openclawCliJson<Record<string, { command?: unknown; args?: unknown }>>(ctx, ["mcp", "list", "--json"]);
  const existing = servers[config.mcpServerName];
  if (existing !== undefined) {
    if (mcpServerMatches(existing, recipeName)) return "unchanged";
    log(`MCP server "${config.mcpServerName}" is registered with a different command than the recipe declares — replacing it`);
    await openclawCli(ctx, mcpUnsetArgv(config.mcpServerName));
    await openclawCli(ctx, mcpAddArgv(config, recipeName));
    return "replaced";
  }
  await openclawCli(ctx, mcpAddArgv(config, recipeName));
  return "created";
}

/** Reconciled rather than merely created: a job whose schedule, message, timeout or
 *  delivery no longer matches the recipe is removed and added again. Replacement is opt-in
 *  since a job with no ledger entry is foreign; the top-level provision path passes
 *  ownership explicitly. */
export async function ensureCronJob(
  ctx: Context,
  config: AgentConfig,
  cronMessage: string,
  options: { readonly allowUpdate?: boolean } = {},
): Promise<"created" | "updated" | "unchanged"> {
  // --all: OpenClaw's own cron list only shows ENABLED jobs by default (docs.openclaw.ai/
  // cli/cron) — without it, a disabled job with this name is invisible here, and this would
  // "create" a second job under the same name instead of finding and reconciling the first.
  const listed = await openclawCliJson<{ jobs: CronJob[] }>(ctx, ["cron", "list", "--json", "--all"]);
  const existing = listed.jobs.find((job) => job.name === config.cronJobName);

  if (existing !== undefined) {
    if (cronJobMatches(existing, config, cronMessage)) return "unchanged";
    if (options.allowUpdate !== true) {
      throw new Error(
        `cron job "${config.cronJobName}" already exists but is not owned by this framework; ` +
          "refusing to replace a foreign job",
      );
    }
    log(`cron job "${config.cronJobName}" no longer matches the recipe — replacing it`);
    await openclawCli(ctx, cronRmArgv(existing.id));
    await openclawCli(ctx, cronAddArgv(config, cronMessage));
    return "updated";
  }

  await openclawCli(ctx, cronAddArgv(config, cronMessage));
  return "created";
}

/** Refuse a name collision before mirroring files or writing prompts. An OpenClaw object
 * without a ledger entry is foreign, even with the same shape as this recipe: silently
 * adopting it would make a later rename/delete destructive. The lock makes this check and
 * the following writes one operation. */
export async function assertObjectNamesAvailable(
  ctx: Context,
  recipeName: string,
  bundle: RecipeAgentBundle,
  ledger: Ledger,
): Promise<void> {
  const declared: { kind: "agent" | "mcp-server" | "cron-job"; name: string }[] = [
    { kind: "agent", name: bundle.config.agentId },
    { kind: "mcp-server", name: bundle.config.mcpServerName },
  ];
  if (bundle.config.cronJobName !== undefined && bundle.cronMessage !== undefined) {
    declared.push({ kind: "cron-job", name: bundle.config.cronJobName });
  }

  for (const entry of declared) {
    const owner = ownerOf(ledger, entry.kind, entry.name);
    if (owner !== undefined && owner.recipe !== recipeName) {
      throw new Error(
        `${entry.kind} "${entry.name}" is owned by recipe "${owner.recipe}"; ` +
          `refusing to use it for another recipe`,
      );
    }
  }

  const agents = await openclawCliJson<Array<{ id?: string }>>(ctx, ["agents", "list", "--json"]);
  if (agents.some((agent) => agent.id === bundle.config.agentId) && ownerOf(ledger, "agent", bundle.config.agentId) === undefined) {
    throw new Error(`agent "${bundle.config.agentId}" already exists but is not owned by this framework; refusing to adopt it`);
  }
  const servers = await openclawCliJson<Record<string, unknown>>(ctx, ["mcp", "list", "--json"]);
  if (Object.prototype.hasOwnProperty.call(servers, bundle.config.mcpServerName) && ownerOf(ledger, "mcp-server", bundle.config.mcpServerName) === undefined) {
    throw new Error(`MCP server "${bundle.config.mcpServerName}" already exists but is not owned by this framework; refusing to adopt it`);
  }
  if (bundle.config.cronJobName !== undefined && bundle.cronMessage !== undefined) {
    // --all: see ensureCronJob's own comment — a name collision with a DISABLED job is a
    // real collision too, and must not go unnoticed just because it is invisible without it.
    const listed = await openclawCliJson<{ jobs?: CronJob[] }>(ctx, ["cron", "list", "--json", "--all"]);
    if ((listed.jobs ?? []).some((job) => job.name === bundle.config.cronJobName) && ownerOf(ledger, "cron-job", bundle.config.cronJobName) === undefined) {
      throw new Error(`cron job "${bundle.config.cronJobName}" already exists but is not owned by this framework; refusing to adopt it`);
    }
  }
}

/** During `apply --set`, the artifact source is active before provisioning runs, but the
 * target's installed-set marker is written only after the whole apply succeeds. Reads the
 * active artifact id so objects created mid-run attribute to the set actually creating
 * them, not the previous set. Working-tree runs keep the installed marker. */
export async function activeSetId(ctx: Context): Promise<string | undefined> {
  const source = setSourceDir();
  if (source !== undefined) {
    try {
      const manifest = JSON.parse(await readFile(resolve(source, "set.json"), "utf8"));
      return setManifestId(manifest);
    } catch {
      // The source wrapper validates set.json before entering an apply. Keep the fallback for
      // direct callers and test contexts that use a source directory without an artifact.
    }
  }
  return (await readInstalledSet(ctx))?.id;
}

/** Removes an object this framework created and stops tracking it — the inverse of
 *  `ensureAgent`/`ensureMcpServer`/`ensureCronJob`. Called for an object the ledger says is
 *  ours but whose recipe no longer declares it; never for one the ledger doesn't know about
 *  (orphanedBy's boundary).
 *
 *  A cron job is looked up by its declared name first, then OpenClaw's `cron rm` takes the
 *  id `cron list` assigns — same indirection `ensureCronJob` goes through. */
export async function removeOwnedObject(ctx: Context, kind: OwnedKind, name: string): Promise<void> {
  const ledger = await readLedger(ctx);
  if (ownerOf(ledger, kind, name) === undefined) {
    throw new Error(`${kind} "${name}" is not recorded as owned by this framework; refusing to remove it`);
  }

  const ignoreAlreadyAbsent = (error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    if (!/not found|does not exist|unknown (?:agent|server|job)/i.test(detail)) throw error;
  };

  if (kind === "agent") {
    try {
      await openclawCli(ctx, agentsDeleteArgv(name));
    } catch (error) {
      ignoreAlreadyAbsent(error);
    }
  } else if (kind === "mcp-server") {
    try {
      await openclawCli(ctx, mcpUnsetArgv(name));
    } catch (error) {
      ignoreAlreadyAbsent(error);
    }
  } else {
    // --all: see ensureCronJob's own comment — a DISABLED job is invisible without it, so
    // this would silently skip calling cron rm on it and still forget the ownership record
    // below, leaving the job itself behind, untracked.
    const listed = await openclawCliJson<{ jobs: CronJob[] }>(ctx, ["cron", "list", "--json", "--all"]);
    const existing = listed.jobs.find((job) => job.name === name);
    if (existing !== undefined) await openclawCli(ctx, cronRmArgv(existing.id));
  }
  await forgetOwned(ctx, kind, name);
}
