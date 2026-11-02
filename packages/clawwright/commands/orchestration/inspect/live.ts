// What the target itself reports, with no declared counterpart to compare against: gateway
// HTTP probes and runtime health, outbound egress, and everything OpenClaw's own CLI says
// it has registered (agents/MCP servers/cron jobs/plugins/skills/channels), reconciled
// against the recipe set's declared ownership and the mirrored recipe/agent checksums.

import { resolve } from "node:path";
import { recipesDir } from "#src/runtime/deployment.ts";
import { openclawCliBatch } from "#src/service/openclaw-cli.ts";
import type { BatchedCliResult } from "#src/service/openclaw-cli.ts";
import { recipeFileChecksums, agentBundleChecksums } from "#src/service/checksums.ts";
import { loadRecipe, recipeEndpointOwners, recipeStack } from "#src/service/recipe.ts";
import type { RecipeEndpointOwner } from "#src/service/recipe.ts";
import { command as nextCommand } from "#src/core/io/invocation/advice.ts";
import { readLedger, orphanedBy, foreign } from "#src/set/ownership/ledger.ts";
import type { DeclaredOwnership, Ledger } from "#src/set/ownership/ledger.ts";
import { forgetRemedy, provisionRemedy } from "#src/set/advice.ts";
import {
  recipeMirrorTargetDir,
  agentWorkspaceTargetDir,
  cronJobMatches,
  mcpServerMatches,
} from "#src/commands/management/provision-agent/index.ts";
import type { CronJob } from "#src/commands/management/provision-agent/index.ts";
import { problem, normalizeChannels, channelProblems, channelIdentities } from "#src/service/inspection.ts";
import type { ChannelAccountStatus } from "#src/service/inspection.ts";
import { readName } from "#src/core/values/names.ts";
import type { Problem, DeclaredState, ObservedState, EgressObservation, ChannelsStatusResponse } from "#src/service/inspection.ts";
import type { StackServiceState } from "#src/runtime/runtime.ts";
import {
  PLUGINS_LIST_ARGS,
  SKILLS_LIST_ARGS,
  parsePluginsList,
  parseSkillsList,
} from "#src/commands/management/extensions.ts";
import type { PluginListEntry, SkillListEntry } from "#src/commands/management/extensions.ts";
import type { ExecResult } from "#src/runtime/transport/transport.ts";
import { parseMemoryStatus } from "./helpers.ts";
import { EGRESS_EXEC_TIMEOUT_MS, EGRESS_PROBE_SCRIPT } from "./egress-probe.ts";
import { cronDifferences, egressEndpoints, redactEndpoint, redactEndpointText } from "./helpers.ts";
import { recipeExpectations } from "./declared.ts";
import type { RecipeExpectation } from "./declared.ts";
import type { Context } from "#src/core/context.ts";

const PROBE_ENDPOINTS = ["healthz", "startupz", "readyz"];

// The compose service inspect observes.
const GATEWAY_SERVICE = "gateway";

// The target directory travels as a positional parameter, never pasted into this script
// text — a POSIX shell still runs $(…)/backticks/$VAR inside double quotes, so a hostile
// directory name could execute as the transport user. Without its argument the script
// fails rather than checksumming a guessed directory. Git for Windows needs drive paths
// converted; cygpath -w receives only the positional value.
const CHECKSUM_SCRIPT =
  'if [ "${1+set}" != set ] || [ -z "$1" ]; then echo NOCHECKSUMDIR >&2; exit 64; fi; ' +
  'dir=$1; case "$dir" in [A-Za-z]:*) if command -v cygpath >/dev/null 2>&1; then dir=$(cygpath -w -- "$dir") || { echo CHECKSUMPATHFAILED >&2; exit 69; }; fi ;; esac; ' +
  'cd -- "$dir" || { echo CHECKSUMCDFAILED >&2; exit 65; }; ' +
  'command -v find >/dev/null || { echo CHECKSUMFINDFAILED >&2; exit 66; }; ' +
  'command -v sha256sum >/dev/null || { echo CHECKSUMSHA256SUMFAILED >&2; exit 67; }; ' +
  'find . -type f -exec sha256sum {} + || { echo CHECKSUMSCANFAILED >&2; exit 68; }';

/** The same checksums for what is actually on the target, computed there — one command for
 *  the whole tree rather than reading every file back over the transport.
 *
 *  An empty listing needs no command; a failed or malformed checksum result is an error. */
async function targetFileChecksums(ctx: Context, dir: string): Promise<Record<string, string>> {
  const listed = await ctx.transport.listFiles(dir);
  if (listed.length === 0) return {};

  const result = await ctx.transport.exec("sh", ["-c", CHECKSUM_SCRIPT, "sh", dir], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim();
    throw new Error(`could not checksum target files (exit ${result.code})${detail === "" ? "" : `: ${detail}`}`);
  }

  return parseChecksumOutput(result.stdout);
}

/** Parses GNU sha256sum's text and Windows binary-mode filename markers. */
export function parseChecksumOutput(stdout: string): Record<string, string> {
  const checksums: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64}) [ *]\.\/(.+)$/.exec(line);
    if (match === null) throw new Error("target returned malformed checksum output");
    checksums[match[2]] = match[1];
  }
  return checksums;
}

/** Probes the outbound endpoints the live configuration names, from inside the gateway
 *  container. Returns the observations, or undefined when there is nothing to probe or the
 *  probe itself could not run — an absent answer is a gap, never a quiet "all reachable". */
async function observeEgress(
  ctx: Context,
  liveConfig: unknown,
  problems: Problem[],
): Promise<EgressObservation[] | undefined> {
  const endpoints = egressEndpoints(liveConfig);
  // execCommand is optional on the runtime contract: a runtime that can't exec into the
  // container skips this rather than being asked.
  if (endpoints.length === 0 || ctx.runtime.execCommand === undefined) return undefined;

  let result: ExecResult;
  try {
    result = await ctx.runtime.execCommand(
      GATEWAY_SERVICE,
      "node",
      ["-e", EGRESS_PROBE_SCRIPT],
      {
        input: JSON.stringify(endpoints.map((endpoint) => endpoint.url)),
        allowFailure: true,
        // Bounds the whole exec (killed by the transport), not just each endpoint — a hung
        // resolver or wedged docker/WSL client before node even starts needs this too.
        timeoutMs: EGRESS_EXEC_TIMEOUT_MS,
      },
    );
  } catch {
    // Container state is health/probes' business; this must not take inspect down.
    return undefined;
  }
  if (result.code !== 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  // One answer per endpoint, in order, or the probe is broken and must not be read as a verdict.
  if (!Array.isArray(parsed) || parsed.length !== endpoints.length) return undefined;
  let owners: readonly RecipeEndpointOwner[] = [];
  if (parsed.some((answer) => answer?.state !== "ok")) {
    try {
      owners = await recipeEndpointOwners();
    } catch {
      problems.push(problem("SET_RECIPE_INVALID", "Recipe endpoint ownership is invalid or ambiguous; no owner is inferred.",
        nextCommand(["recipe", "list", "--json"], { note: "repair consumerEndpoints declarations before recipe recovery" })));
    }
  }

  const observations: EgressObservation[] = [];
  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index];
    const answer = parsed[index] as { url?: unknown; state?: unknown; detail?: unknown };
    const state = answer?.state;
    if (answer?.url !== endpoint.url || (state !== "ok" && state !== "dns" && state !== "unreachable" && state !== "invalid" && state !== "timeout")) {
      return undefined;
    }
    const display = redactEndpoint(endpoint.url);
    const detail = typeof answer.detail === "string" ? redactEndpointText(answer.detail, endpoint.url) : undefined;
    const unreachable = state === "dns"
      ? `${display} (${endpoint.path}) does not resolve from inside the "${GATEWAY_SERVICE}" container`
      : state === "invalid"
        ? `${display} (${endpoint.path}) is not a usable URL`
        : state === "timeout"
          ? `${display} (${endpoint.path}) gave no answer within the egress probe's whole deadline`
          : `${display} (${endpoint.path}) resolves from inside the "${GATEWAY_SERVICE}" container but does not answer`;
    if (state !== "ok") {
      const owner = owners.find((entry) => entry.configPath === endpoint.path);
      const ownership = owner ? `; declared recipe "${owner.recipe}", service "${owner.service}"` : "";
      problems.push(problem("EGRESS_UNREACHABLE", `${detail === undefined ? unreachable : `${unreachable} (${detail})`}${ownership}`,
        owner ? nextCommand(["recipe", "inspect", owner.recipe, "--json"], {
          note: `inspect declared service ${owner.service}; preview selective recovery with recipe recover ${owner.recipe} --service ${owner.service} --dry-run`,
        }) : undefined));
    }
    const observation: EgressObservation = { path: endpoint.path, endpoint: display, state, ...(detail === undefined ? {} : { detail }) };
    observations.push(observation);
  }
  return observations;
}

/** One proxy service's verdict from the SAME per-service state install's readiness waits
 *  on. Undefined means healthy enough (running with a settled or undeclared healthcheck) —
 *  a green proxy never proves the egress behind it works, so it produces no finding. */
export const PROXY_NOT_RUNNING = "not running";

export function proxyServiceVerdict(state: StackServiceState | undefined): string | undefined {
  if (state === undefined || state.running !== true) return PROXY_NOT_RUNNING;
  if (state.health === "unhealthy" || state.health === "starting") return state.health;
  return undefined;
}

/** The note beside the diagnose step: why it asks for confirmation, and the logs command to read first. */
export function proxyDownNote(recipe: string): string {
  return `gated like every mutation: asks for confirmation and holds the instance lock; recipe logs ${recipe} reads the container output without either`;
}

/** The one new finding per recipe when an unhealthy/unknown channel ACCOUNT routes through
 *  a proxy: pure over the live configuration, the normalized channel telemetry (with its
 *  PRIVATE identity table — real channel keys/account ids, never serialized), the strict
 *  endpoint-owner catalog and a per-recipe serviceStates lookup, so the whole correlation is
 *  testable without a target. The proxy URL itself (credentials included) never reaches the
 *  finding text — channel names are the same opaque labels the channel findings use. */
export function channelProxyFindings(
  liveConfig: unknown,
  channels: ChannelsStatusResponse | undefined,
  owners: readonly RecipeEndpointOwner[],
  serviceStates: (recipe: string) => Record<string, StackServiceState> | undefined,
): Problem[] {
  if (channels === undefined || liveConfig === null || typeof liveConfig !== "object") return [];
  const sections = (liveConfig as { channels?: unknown }).channels;
  if (sections === null || typeof sections !== "object" || Array.isArray(sections)) return [];
  const idents = channelIdentities(channels);
  const findings = new Map<string, { service: string; state: string; channels: string[] }>();
  for (const [channelLabel, entries] of Object.entries(channels.channelAccounts ?? {})) {
    // Correlation runs under the REAL key (`channels.<key>` in the live configuration);
    // the display label is opaque and never a config key.
    const channelKey = idents?.get(channelLabel)?.channelKey ?? channelLabel;
    const section = (sections as Record<string, unknown>)[channelKey];
    if (section === null || typeof section !== "object" || Array.isArray(section)) continue;
    const { proxy, accounts } = section as { proxy?: unknown; accounts?: unknown };
    const accountsRecord = accounts !== null && typeof accounts === "object" && !Array.isArray(accounts)
      ? accounts as Record<string, unknown> : undefined;
    const configured = (value: unknown): boolean => typeof value === "string" && value !== "";
    for (const raw of entries as ChannelAccountStatus[]) {
      // The production predicate scoped to THIS account: the proxy correlation fires
      // exactly for accounts that carry a finding of their own, never for the channel.
      if (channelProblems({ channelAccounts: { [channelLabel]: [raw] } }).length === 0) continue;
      // Effective proxy for this account: its OWN key under `accounts` wins when present —
      // an empty string there OVERRIDES the channel-level proxy to "no proxy" — otherwise
      // the channel-level value. Without a real account id the account key cannot be
      // named, so the channel-level value decides.
      const accountId = idents?.get(channelLabel)?.accountIds.get(String(raw.accountId ?? ""));
      const accountConfig = accountId !== undefined && accountsRecord !== undefined ? accountsRecord[accountId] : undefined;
      // The override is the PROXY KEY being present on the account, not the account existing:
      // an account with only `enabled` set inherits the channel-level proxy.
      const ownsProxyKey = accountConfig !== null && typeof accountConfig === "object" && Object.hasOwn(accountConfig, "proxy");
      const proxied = ownsProxyKey ? configured((accountConfig as { proxy?: unknown }).proxy) : configured(proxy);
      if (!proxied) continue;
      // The path a recipe must have declared is the one the effective proxy actually lives at.
      const path = ownsProxyKey ? `channels.${channelKey}.accounts.${accountId}.proxy` : `channels.${channelKey}.proxy`;
      const owner = owners.find((candidate) => candidate.configPath === path);
      if (owner === undefined) continue; // somebody else's proxy: report nothing about it
      // `serviceStates()` answers a COMPLETE map when the compose read succeeds — a stopped
      // stack still lists its services (state "exited"/running:false) — so a service absent
      // from a successful answer is genuinely not running. An undefined answer means the
      // recipe or stack read FAILED: that is unknown, never down, so nothing is emitted.
      const stack = serviceStates(owner.recipe);
      if (stack === undefined) continue;
      const state = proxyServiceVerdict(stack[owner.service]);
      if (state === undefined) continue;
      const known = findings.get(owner.recipe);
      if (known === undefined) findings.set(owner.recipe, { service: owner.service, state, channels: [channelLabel] });
      else if (!known.channels.includes(channelLabel)) known.channels.push(channelLabel);
    }
  }
  return [...findings].map(([recipe, observed]) =>
    problem(
      "CHANNEL_PROXY_DOWN",
      `recipe "${recipe}": its proxy service "${observed.service}" reports "${observed.state}", and channel(s) ${observed.channels.map((name) => `"${name}"`).join(", ")} route through it`,
      // Two steps, spelled like EGRESS_UNREACHABLE's: the gated diagnose as the remedy, the
      // log read beside it with the recipe name filled in.
      nextCommand(["recipe", "diagnose", recipe], { note: proxyDownNote(recipe) }),
    ));
}

/** Asks every recipe that could own a proxied channel for the same per-service state
 *  install's readiness reads. Only a SUCCESSFUL read is recorded: a recipe or stack read
 *  that fails stays absent from the map, which `channelProxyFindings` treats as unknown —
 *  a broken manifest or transport failure must not read the service as down. */
async function observeChannelProxies(ctx: Context, liveConfig: unknown, channels: ChannelsStatusResponse, problems: Problem[]): Promise<void> {
  if (channelProblems(channels).length === 0) return;
  let owners: readonly RecipeEndpointOwner[];
  try {
    owners = await recipeEndpointOwners();
  } catch {
    // Broken endpoint ownership is its own finding (observeEgress reports it too); no
    // owner can be inferred, so nothing is blamed for the channel here either.
    return;
  }
  const states = new Map<string, Record<string, StackServiceState>>();
  for (const recipe of new Set(owners.map((entry) => entry.recipe))) {
    try {
      const loaded = await loadRecipe(readName("recipe", recipe));
      states.set(recipe, await recipeStack(ctx, loaded.name, loaded.definitionPath).serviceStates());
    } catch {
      // Leave the recipe out: unknown, not down.
    }
  }
  problems.push(...channelProxyFindings(liveConfig, channels, owners, (recipe) => states.get(recipe)));
}

/** Probes, the runtime's health verdict, and RESTART_REQUIRED (from the same startedAt()
 *  read) — the three facts observeLive needs before touching what OpenClaw has registered. */
async function observeHealth(
  ctx: Context,
  problems: Problem[],
  configMtimeMs: number | undefined,
): Promise<{ probes: Record<string, number>; health: string }> {
  const probes: Record<string, number> = {};
  for (const endpoint of PROBE_ENDPOINTS) {
    try {
      probes[endpoint] = await ctx.runtime.probe(endpoint);
    } catch {
      probes[endpoint] = 0;
    }
  }
  const failedProbes = Object.entries(probes).filter(([, code]) => code !== 200);

  // Both criteria are read; disagreement can itself reveal a broken healthcheck.
  //   "unhealthy"/"missing"  runtime has decided — a finding whatever the probes say.
  //   "starting"             grace period, genuinely unknown yet; probes decide instead so
  //                          a restart doesn't read as a false alarm.
  //   "healthy"/"none"       trusted, but only as far as the probes agree.
  const health = await ctx.runtime.health();
  const probeDetail = failedProbes.map(([name, code]) => `${name} answered ${code}`).join(", ");

  if (health === "unhealthy" || health === "missing") {
    problems.push(
      problem(
        "GATEWAY_UNHEALTHY",
        `the runtime reports the container "${health}"${failedProbes.length === 0 ? ", though the HTTP probes answer" : `, and ${probeDetail}`}`,
      ),
    );
  } else if (failedProbes.length > 0) {
    problems.push(
      problem(
        "GATEWAY_UNHEALTHY",
        `the runtime reports the container "${health}" but ${probeDetail}`,
      ),
    );
  }

  // Correct on disk is not the same as in force: this instance reads its configuration at
  // startup only.
  const startedAt = await ctx.runtime.startedAt();
  if (startedAt !== undefined && configMtimeMs !== undefined && configMtimeMs > startedAt) {
    problems.push(
      problem(
        "RESTART_REQUIRED",
        `${ctx.settings.dataDir}/config/openclaw.json was written ${new Date(configMtimeMs).toISOString()}, after the instance started ${new Date(startedAt).toISOString()}`,
      ),
    );
  }

  return { probes, health };
}

/** What OpenClaw itself has registered: one batched container for all six reads instead of
 *  one each — each `docker compose run --rm` pays Compose's create/destroy cost again
 *  (~5-7s), which was the dominant cost doctor/plan measured before batching. */
async function observeRegistrations(ctx: Context, includeChannels: boolean, problems: Problem[]) {
  const batchCommands: string[][] = [
    ["agents", "list", "--json"],
    ["mcp", "list", "--json"],
    ["cron", "list", "--json"],
    ["--version"],
    [...PLUGINS_LIST_ARGS],
    [...SKILLS_LIST_ARGS],
  ];
  // Appended, never inserted: indices above are read positionally below.
  const channelsIndex = includeChannels ? batchCommands.push(["channels", "status", "--json"]) - 1 : undefined;
  const memoryIndex = batchCommands.push(["memory", "status", "--json"]) - 1;
  const batchResults = await openclawCliBatch(ctx, batchCommands);
  const [agentsResult, mcpResult, cronResult, versionResult, pluginsResult, skillsResult] = batchResults;
  const channels = channelsIndex === undefined ? undefined : parseChannelsStatus(batchResults[channelsIndex], problems);
  const memory = parseMemoryStatus(batchResults[memoryIndex], problems);
  const agents = parseJsonOrUnknown(agentsResult, "agents list", problems, (parsed) =>
    (parsed as Array<{ id?: string }>).map((entry) => entry.id ?? "").filter((id) => id !== ""));
  // Full entries, not just names: a server registered under the wrong command (or disabled)
  // is broken, not missing — mcpServerMatches() is provision-agent's own comparison.
  const mcpServerEntries = parseJsonOrUnknown(mcpResult, "mcp list", problems, (parsed) => {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid registrations");
    return Object.entries(parsed as Record<string, { command?: unknown; args?: unknown; enabled?: unknown }>);
  });
  const mcpServers = mcpServerEntries?.map(([name]) => name);
  // Whole jobs, not flattened names: message/timeout/target/delivery-mode drift can differ
  // while the schedule alone matches.
  const liveJobs = parseJsonOrUnknown(cronResult, "cron list", problems, (parsed) =>
    (parsed as { jobs?: CronJob[] }).jobs as CronJob[]);
  const cronJobs = liveJobs?.map((job) => (job.schedule?.expr === undefined ? (job.name ?? "") : `${job.name ?? ""}@${job.schedule.expr}`))
    .filter((name) => name !== "");

  if (versionResult.code !== 0 || versionResult.stdout.trim() === "") {
    reportCliReadFailure(problems, "version", versionResult.failure ?? (versionResult.code === 0 ? "empty response" : `exit ${versionResult.code}`));
  }

  const openclawVersionLine = versionResult.code === 0 ? versionResult.stdout.trim().split("\n")[0] : "";
  const openclawVersion = openclawVersionLine === "" ? undefined : openclawVersionLine;

  // Raw here; gather.ts normalises via pluginsForLock/skillsForLock before comparing.
  const plugins = parsePluginsList(pluginsResult, problems);
  const skills = parseSkillsList(skillsResult, problems);

  return { agents, mcpServerEntries, mcpServers, liveJobs, cronJobs, channels, memory, openclawVersion, plugins, skills };
}

/** What this framework can show it created, against what every recipe in the set currently
 *  declares. An object recorded for a recipe that no longer exists, or that now names a
 *  different agent/server/job (a rename), is orphaned; anything present that the ledger
 *  never recorded is somebody else's and only ever reported, never proposed for removal. */
async function observeOwnership(
  ctx: Context,
  problems: Problem[],
  expectations: RecipeExpectation[],
  agents: string[] | undefined,
  mcpServers: string[] | undefined,
  liveJobs: CronJob[] | undefined,
) {
  const declaredOwnership: DeclaredOwnership[] = expectations.flatMap(({ recipe, bundle }) => {
    const entries: DeclaredOwnership[] = [
      { kind: "agent", name: bundle.config.agentId, recipe },
      { kind: "mcp-server", name: bundle.config.mcpServerName, recipe },
    ];
    if (bundle.config.cronJobName !== undefined && bundle.cronMessage !== undefined) entries.push({ kind: "cron-job", name: bundle.config.cronJobName, recipe });
    return entries;
  });
  const ledger = await readLedger(ctx);
  for (const owned of orphanedBy(ledger, declaredOwnership)) {
    const memoryNote = owned.kind === "agent" ? " — removing it would also prune its workspace and memory" : "";
    problems.push(
      problem(
        "SET_OBJECT_ORPHANED",
        `${owned.kind} "${owned.name}" was created for recipe "${owned.recipe}", which the set no longer declares this way${memoryNote}`,
        forgetRemedy(owned.kind, owned.name),
      ),
    );
  }
  const foreignObjects = [
    ...foreign(ledger, "agent", agents ?? []).map((name) => ({ kind: "agent" as const, name })),
    ...foreign(ledger, "mcp-server", mcpServers ?? []).map((name) => ({ kind: "mcp-server" as const, name })),
    ...foreign(ledger, "cron-job", (liveJobs ?? []).map((job) => job.name ?? "").filter((name) => name !== "")).map((name) => ({ kind: "cron-job" as const, name })),
  ];
  return { ledger, foreignObjects };
}

/** One recipe's expectations against the instance: agent/MCP-server/cron-job registration,
 *  mirrored recipe files by content, and agent prompt files (which the mirror doesn't
 *  carry — provision-agent writes those straight into the agent's workspace). */
async function checkRecipeExpectation(
  ctx: Context,
  problems: Problem[],
  expectation: RecipeExpectation,
  registrations: { agents?: string[]; mcpServerEntries?: [string, { command?: unknown; args?: unknown; enabled?: unknown }][]; liveJobs?: CronJob[] },
  ledger: Ledger,
): Promise<void> {
  const { agents, mcpServerEntries, liveJobs } = registrations;
  const { config, cronMessage } = expectation.bundle;
  const agentId = config.agentId;

  if (agents !== undefined && !agents.includes(agentId)) {
    problems.push(
      problem("AGENT_MISSING", `recipe "${expectation.recipe}" declares agent "${agentId}", which the instance does not have`, provisionRemedy(expectation.recipe)),
    );
  }
  const registeredServer = mcpServerEntries?.find(([name]) => name === config.mcpServerName)?.[1];
  if (mcpServerEntries !== undefined && registeredServer === undefined) {
    problems.push(
      problem("MCP_SERVER_MISSING", `recipe "${expectation.recipe}" declares MCP server "${config.mcpServerName}", which is not registered`, provisionRemedy(expectation.recipe)),
    );
  } else if (registeredServer !== undefined && !mcpServerMatches(registeredServer, expectation.recipe)) {
    problems.push(
      problem(
        "MCP_SERVER_MISSING",
        `recipe "${expectation.recipe}" declares MCP server "${config.mcpServerName}", which is registered but does not launch the recipe's server.ts (wrong command, or disabled)`,
        provisionRemedy(expectation.recipe),
      ),
    );
  }
  if (liveJobs !== undefined && config.cronJobName !== undefined && cronMessage !== undefined) {
    const live = liveJobs.find((job) => job.name === config.cronJobName);
    if (live === undefined) {
      problems.push(
        problem("CRON_DRIFT", `recipe "${expectation.recipe}" declares cron job "${config.cronJobName}", which does not exist`, provisionRemedy(expectation.recipe)),
      );
    } else if (!cronJobMatches(live, config, cronMessage)) {
      // Named field by field: "the job differs" leaves the reader to diff it themselves.
      problems.push(
        problem("CRON_DRIFT", `cron job "${config.cronJobName}" differs from the recipe: ${cronDifferences(live, config, cronMessage).join("; ")}`, provisionRemedy(expectation.recipe)),
      );
    }
  }

  // By content, not filename: an edited-but-not-mirrored page is the most ordinary drift.
  const recipeDir = resolve(recipesDir(), expectation.recipe);
  const localSums = await recipeFileChecksums(recipeDir);
  const targetSums = await targetFileChecksums(ctx, recipeMirrorTargetDir(ctx.settings.dataDir, expectation.recipe));
  const differing = Object.keys(localSums).filter((rel) => localSums[rel] !== targetSums[rel]);
  const extra = Object.keys(targetSums).filter((rel) => localSums[rel] === undefined);

  // Prompt files aren't in the mirror (provision-agent writes them into the workspace
  // directly), so an edited AGENTS.md needs its own check here.
  {
    const bundle = await agentBundleChecksums(recipeDir);
    const workspace = await targetFileChecksums(ctx, agentWorkspaceTargetDir(ctx.settings.dataDir, agentId));
    const ownedPromptFiles = new Set(
      ledger.objects.find((owned) => owned.kind === "agent" && owned.name === agentId && owned.recipe === expectation.recipe)?.promptFiles ?? [],
    );
    const stalePrompts = Object.keys(bundle)
      .filter((rel) => rel.endsWith(".md"))
      .filter((rel) => bundle[rel] !== workspace[rel]);
    const extraPrompts = Object.keys(workspace)
      .filter((rel) => !rel.includes("/") && rel.endsWith(".md"))
      .filter((rel) => bundle[rel] === undefined && ownedPromptFiles.has(rel));
    if (stalePrompts.length > 0 || extraPrompts.length > 0) {
      const details: string[] = [];
      if (stalePrompts.length > 0) details.push(`older or missing (${stalePrompts.join(", ")})`);
      if (extraPrompts.length > 0) details.push(`withdrawn prompt file(s) still present (${extraPrompts.join(", ")})`);
      problems.push(
        problem(
          "RECIPE_MIRROR_DRIFT",
          `recipe "${expectation.recipe}": agent "${agentId}" has prompt drift: ${details.join("; ")}`,
          provisionRemedy(expectation.recipe),
        ),
      );
    }
  }

  if (differing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (differing.length > 0) parts.push(`${differing.length} file(s) differ or are missing (${differing.slice(0, 3).join(", ")}${differing.length > 3 ? ", …" : ""})`);
    if (extra.length > 0) parts.push(`${extra.length} file(s) on the target the recipe no longer declares (${extra.slice(0, 3).join(", ")}${extra.length > 3 ? ", …" : ""})`);
    problems.push(
      problem("RECIPE_MIRROR_DRIFT", `recipe "${expectation.recipe}": ${parts.join("; ")}`, provisionRemedy(expectation.recipe)),
    );
  }
}

export async function observeLive(
  ctx: Context,
  declared: DeclaredState,
  problems: Problem[],
  configMtimeMs: number | undefined,
  liveConfig: unknown,
  // Normal telemetry joins the registration batch; no channel probe is requested.
  includeChannels = true,
): Promise<Partial<ObservedState> & { plugins?: PluginListEntry[]; skills?: SkillListEntry[] }> {
  const { probes, health } = await observeHealth(ctx, problems, configMtimeMs);

  // Outbound counterpart of the probes above, from the one vantage they lack.
  const egress = await observeEgress(ctx, liveConfig, problems);

  // --- what OpenClaw itself has registered ----------------------------------------------
  const registrations = await observeRegistrations(ctx, includeChannels, problems);
  const { agents, mcpServerEntries, mcpServers, liveJobs, cronJobs, channels, memory, openclawVersion, plugins, skills } = registrations;

  // After the channel findings: when one explains itself with a down proxy, name it.
  if (channels !== undefined) await observeChannelProxies(ctx, liveConfig, channels, problems);

  const expectations = await recipeExpectations();
  const { ledger, foreignObjects } = await observeOwnership(ctx, problems, expectations, agents, mcpServers, liveJobs);

  for (const expectation of expectations) {
    await checkRecipeExpectation(ctx, problems, expectation, { agents, mcpServerEntries, liveJobs }, ledger);
  }

  return { probes, health, egress, agents, mcpServers, cronJobs, foreignObjects, openclawVersion, plugins, skills, channels, memory };
}

/** A failed list remains unknown; callers may compare only confirmed values. */
function parseJsonOrUnknown<T>(result: BatchedCliResult, name: string, problems: Problem[], extract: (parsed: unknown) => T[]): T[] | undefined {
  if (result.code !== 0) {
    reportCliReadFailure(problems, name, result.failure ?? `exit ${result.code}`);
    return undefined;
  }
  try {
    const value = extract(JSON.parse(result.stdout));
    if (!Array.isArray(value)) throw new Error("invalid list");
    return value;
  } catch {
    reportCliReadFailure(problems, name, "invalid JSON response");
    return undefined;
  }
}

function reportCliReadFailure(problems: Problem[], name: string, reason: string): void {
  problems.push(problem("CLI_READ_FAILED", `openclaw ${name} could not be read (${reason}); live state is unknown`));
}

/** A requested read's failure stays unknown, with no raw CLI output in its reason. */
export function parseChannelsStatus(result: (BatchedCliResult & { readonly stderr?: string }) | undefined, problems: Problem[]): ChannelsStatusResponse | undefined {
  const unknown = (reason: string): undefined => {
    problems.push(problem("CHANNEL_UNKNOWN", `openclaw channels status could not be confirmed (${reason}); channel state is unknown`));
    return undefined;
  };
  if (result === undefined) return unknown("missing response");
  if (result.code !== 0) unknown(`exit ${result.code}; partial facts retained when valid`);
  if (result.stdout.length > 262144) return unknown("response exceeds observation bound");
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    const safe = normalizeChannels(parsed);
    if (safe === undefined) return unknown("invalid response shape");
    problems.push(...channelProblems(safe));
    return safe;
  } catch {
    return unknown("invalid JSON response");
  }
}
