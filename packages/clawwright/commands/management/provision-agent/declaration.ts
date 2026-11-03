// Pure declaration pieces for `clawwright provision-agent`: the agent/config.json shape,
// path builders, and the argv/comparison functions used both to REGISTER an agent/MCP
// server/cron job and to check whether one already matches. index.ts's barrel re-export
// keeps every import site unchanged.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { die } from "#src/core/io/log.ts";
import { recipesDir } from "#src/runtime/deployment.ts";
import { containerPaths } from "#src/runtime/mounts.ts";
import { createName, newName, readName, safeName } from "#src/core/values/names.ts";
import { collectPortableAgentBundleFiles, collectPortableRecipeFiles } from "#src/security/privacy/recipe-portable-content.ts";

const DEFAULT_CRON_SCHEDULE = "17 3 * * *"; // daily, off-peak, off the :00/:30 pileup minutes
const DEFAULT_CRON_TIMEOUT_SECONDS = 900;

export interface AgentConfig {
  // raw string: branding agentId as AgentName breaks set/ownership/validate.ts's declaredAgents set, outside this stage's editable files (S3.1 lists it for S1.3)
  readonly agentId: string;
  readonly mcpServerName: string;
  readonly cronJobName?: string;
  readonly cronSchedule: string;
  readonly cronTimezone?: string;
  readonly cronTimeoutSeconds: number;
}

export interface RecipeAgentBundle {
  readonly recipeDir: string;
  readonly config: AgentConfig;
  readonly promptFiles: Record<string, string>;
  readonly cronMessage?: string;
}

/** `minting` is the creator side (provision-agent writes these names into an instance): the
 *  Windows device names are refused there; a reader of an existing record or recipe keeps the
 *  pre-device-rule grammar, so an `aux` agent already on disk still reads. */
export function parseAgentConfig(raw: unknown, minting = false): AgentConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) die("agent/config.json must be an object");
  const obj = raw as Partial<Record<keyof AgentConfig, unknown>>;
  if (typeof obj.agentId !== "string" || obj.agentId === "") die("agent/config.json: \"agentId\" must be a non-empty string");
  if (typeof obj.mcpServerName !== "string" || obj.mcpServerName === "") die("agent/config.json: \"mcpServerName\" must be a non-empty string");
  if (obj.cronJobName !== undefined && (typeof obj.cronJobName !== "string" || obj.cronJobName === "")) {
    die("agent/config.json: \"cronJobName\" must be a non-empty string when present");
  }
  // These values become path segments, OpenClaw identifiers and plan arguments — same
  // portable name contract as recipes/deployments. The agent id is a branded Name (kinds.ts's
  // "agent" kind); the MCP server and cron job names have no brand kind and keep the untyped
  // wrappers.
  const checkWrapper = minting ? newName : safeName;
  const agentId = minting ? createName("agent", obj.agentId) : readName("agent", obj.agentId);
  checkWrapper("MCP server", obj.mcpServerName);
  if (obj.cronJobName !== undefined) checkWrapper("cron job", obj.cronJobName);
  if (obj.cronTimezone !== undefined) {
    if (typeof obj.cronTimezone !== "string" || obj.cronTimezone === "") die("cronTimezone must be an IANA timezone");
    try { new Intl.DateTimeFormat("en", { timeZone: obj.cronTimezone }); } catch { die("cronTimezone must be an IANA timezone"); }
  }
  return {
    agentId,
    mcpServerName: obj.mcpServerName as string,
    cronJobName: obj.cronJobName as string | undefined,
    cronSchedule: typeof obj.cronSchedule === "string" && obj.cronSchedule !== "" ? obj.cronSchedule : DEFAULT_CRON_SCHEDULE,
    ...(obj.cronTimezone === undefined ? {} : { cronTimezone: obj.cronTimezone as string }),
    cronTimeoutSeconds: typeof obj.cronTimeoutSeconds === "number" && obj.cronTimeoutSeconds > 0
      ? obj.cronTimeoutSeconds
      : DEFAULT_CRON_TIMEOUT_SECONDS,
  };
}

/** Every regular file under `dir`, recursively, as POSIX-style relative paths — except
 *  anything under a top-level directory named `excludeDir`. A thin delegate to the shared
 *  portable-content policy (security/recipe-portable-content.ts): declared privateFiles
 *  and sensitive-name matches are held back (with a warning, never silently), and a
 *  symlink resolving outside the recipe directory stops the walk instead of being read
 *  through. Pure and local-filesystem-only. */
export async function collectRecipeFiles(dir: string, excludeDir: string): Promise<string[]> {
  return (await collectPortableRecipeFiles(dir, { excludeTop: excludeDir === "" ? undefined : excludeDir })).files;
}

/** Exported so `inspect` compares the SAME declaration provisioning acts on: two readers of
 *  one config.json, each with its own defaults, is how an inspection disagrees with the
 *  command it's supposed to check.
 *
 *  Reads through the SAME canonical walker as the set manifest and agentBundleChecksums —
 *  a raw readdir+readFile here would bypass the portable-content policy, letting a declared
 *  `privateFiles` entry stay out of the manifest while provisioning copies it anyway. The
 *  walk root is vetted the same way: an `agent/` that's itself an escaping link refuses
 *  provisioning; a plainly absent agent/ stays the honest "no bundle" case. config.json and
 *  (when cron is declared) cron-message.txt are mandatory — the policy holding either back
 *  refuses rather than silently reading or dropping it. */
export async function loadRecipeAgentBundle(recipeName: string, minting = false): Promise<RecipeAgentBundle> {
  // raw string: commands/orchestration/inspect/declared.ts passes an unbranded recipe name, outside this stage's editable files (S3.1 lists it for S1.3)
  const recipeDir = resolve(recipesDir(), recipeName);
  const agentDir = resolve(recipeDir, "agent");

  const walked = await collectPortableAgentBundleFiles(recipeDir);
  if (walked === undefined) {
    die(`recipe "${recipeName}" has no agent bundle — expected recipes/${recipeName}/agent/config.json`);
  }
  const { files, excluded } = walked;
  // `files` is walk-root-relative ("config.json"); `excluded` is recipe-relative
  // ("agent/config.json") — look up with the same prefix or the refusal below never fires.
  const reasonFor = (name: string): string | undefined => excluded.find((entry) => entry.path === `agent/${name}`)?.reason;

  const configExcluded = reasonFor("config.json");
  if (configExcluded !== undefined) {
    die(`recipe "${recipeName}": agent/config.json is excluded by the portable-content policy (${configExcluded}) — the agent bundle cannot be provisioned`);
  }
  if (!files.includes("config.json")) {
    die(`recipe "${recipeName}" has no agent bundle — expected recipes/${recipeName}/agent/config.json`);
  }
  let configRaw: string;
  try {
    configRaw = await readFile(resolve(agentDir, "config.json"), "utf8");
  } catch (error) {
    throw new Error(`recipe "${recipeName}" agent/config.json could not be read: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(configRaw!);
  } catch (error) {
    throw new Error(`recipe "${recipeName}" agent/config.json is not valid JSON: ${(error as Error).message}`);
  }
  const config = parseAgentConfig(parsed, minting);

  // Top-level *.md only — a file the walker already excluded never reaches `files`, so it
  // never reaches promptFiles or the workspace it gets written to.
  const promptFiles: Record<string, string> = {};
  for (const rel of files) {
    if (rel.includes("/") || !rel.endsWith(".md")) continue;
    promptFiles[rel] = await readFile(resolve(agentDir, rel), "utf8");
  }

  const cronExcluded = reasonFor("cron-message.txt");
  let cronMessage: string | undefined;
  if (files.includes("cron-message.txt")) {
    cronMessage = (await readFile(resolve(agentDir, "cron-message.txt"), "utf8")).trim();
  } else if (cronExcluded !== undefined) {
    die(`recipe "${recipeName}": agent/cron-message.txt is excluded by the portable-content policy (${cronExcluded}) — a declared-private or sensitive-named cron message cannot be provisioned`);
  }
  if (cronMessage !== undefined && config.cronJobName === undefined) {
    die(`recipe "${recipeName}": agent/cron-message.txt exists but config.json has no "cronJobName"`);
  }

  return { recipeDir, config, promptFiles, cronMessage };
}

export function agentWorkspaceTargetDir(dataDir: string, agentId: string): string {
  return `${dataDir}/workspace/${agentId}`;
}

function agentWorkspaceContainerDir(agentId: string): string {
  return `${containerPaths.workspace}/${agentId}`;
}

export function recipeMirrorTargetDir(dataDir: string, recipeName: string): string {
  return `${dataDir}/workspace/mcp-${recipeName}`;
}

/** Where the recipe's own MCP server lives from inside the container — the path the gateway
 *  spawns. Exported so acceptance checks start the same file the instance would, rather than
 *  a second guess at where it ended up. */
export function recipeServerContainerPath(recipeName: string): string {
  return `${containerPaths.workspace}/mcp-${recipeName}/server.ts`;
}

export function agentsAddArgv(config: AgentConfig): string[] {
  return ["agents", "add", config.agentId, "--workspace", agentWorkspaceContainerDir(config.agentId), "--non-interactive", "--json"];
}

/** The command and args a recipe's MCP server registration should run — the one place both
 *  mcpAddArgv() (what registers it) and mcpServerMatches() (what checks it is still that)
 *  read from, so they cannot drift apart from each other. */
export function mcpServerSpec(recipeName: string): { command: string; args: string[] } {
  return { command: "node", args: ["--experimental-strip-types", recipeServerContainerPath(recipeName)] };
}

export function mcpAddArgv(config: AgentConfig, recipeName: string): string[] {
  const spec = mcpServerSpec(recipeName);
  return [
    "mcp", "add", config.mcpServerName,
    "--command", spec.command,
    ...spec.args.flatMap((arg) => ["--arg", arg]),
    "--parallel",
    "--no-probe",
  ];
}

/** Whether a live "mcp list --json" entry still launches the recipe's own server, against
 *  the exact command/args mcpAddArgv() sends — a name being registered says nothing about
 *  whether it points at a working command, and this is what lets ensureMcpServer() tell
 *  "present and correct" apart from "present and broken". */
export function mcpServerMatches(entry: { command?: unknown; args?: unknown; enabled?: unknown } | undefined, recipeName: string): boolean {
  if (entry === undefined) return false;
  // A disabled entry is excluded from tool discovery entirely, as broken as unregistered.
  // Only an explicit false counts as disabled; absent or true stays enabled.
  if (entry.enabled === false) return false;
  const spec = mcpServerSpec(recipeName);
  if (entry.command !== spec.command) return false;
  if (!Array.isArray(entry.args) || entry.args.length !== spec.args.length) return false;
  return entry.args.every((value, index) => value === spec.args[index]);
}

export function cronAddArgv(config: AgentConfig, cronMessage: string): string[] {
  return [
    "cron", "add",
    "--name", config.cronJobName!,
    "--agent", config.agentId,
    "--cron", config.cronSchedule,
    ...(config.cronTimezone === undefined ? [] : ["--tz", config.cronTimezone]),
    "--session", "isolated",
    "--expect-final",
    // The job's product is whatever it writes in its own workspace, not a chat reply — the
    // default (announce to "last" channel) fail-closes with no messaging channel configured.
    "--no-deliver",
    "--timeout-seconds", String(config.cronTimeoutSeconds),
    "--message", cronMessage,
    "--json",
  ];
}

export function cronRmArgv(jobId: string): string[] {
  return ["cron", "rm", jobId, "--json"];
}

export function agentsDeleteArgv(agentId: string): string[] {
  return ["agents", "delete", agentId, "--force", "--json"];
}

export function mcpUnsetArgv(name: string): string[] {
  return ["mcp", "unset", name];
}

/** A cron job as `cron list --json` reports it, in the fields this command declares. */
export interface CronJob {
  id: string;
  name?: string;
  agentId?: string;
  enabled?: boolean;
  schedule?: { expr?: string; tz?: string };
  sessionTarget?: string;
  payload?: { message?: string; timeoutSeconds?: number };
  delivery?: { mode?: string };
}

/** Whether a live job still matches what the recipe declares. Only declared fields are
 *  compared: id, run history, next run time are gateway-owned state, not drift.
 *
 *  A disabled job is not a match even when every other field agrees — only an explicit
 *  false counts as disabled, same conservative default as mcpServerMatches. */
export function cronJobMatches(job: CronJob, config: AgentConfig, cronMessage: string): boolean {
  return job.enabled !== false
    && job.agentId === config.agentId
    && job.schedule?.expr === config.cronSchedule
    && (config.cronTimezone === undefined || job.schedule?.tz === config.cronTimezone)
    && job.sessionTarget === "isolated"
    && job.payload?.message === cronMessage
    && job.payload?.timeoutSeconds === config.cronTimeoutSeconds
    && job.delivery?.mode === "none";
}
