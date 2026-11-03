// `clawwright accept [<recipe>]` — does this deployment's own work actually work.
//
// `clawwright smoke` proves the instance is healthy, but not whether a recipe's wiki is
// reachable, its agent has the tools it was given, or its cron job matches the recipe —
// properties of this deployment, not the framework's business to know.
//
// So the recipe declares them, in acceptance.json using check kinds the framework
// implements — no code travels from a deployment into the framework, same boundary as
// provision-agent draws.
//
// Checks that call the model are declared separately and never run unless asked (cost,
// agent-turn side effects). What was skipped is always reported, or coverage disappears.

import { resolve } from "node:path";
import { log, info, warn, die } from "#src/core/io/log.ts";
import * as kinds from "#src/core/values/kinds.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { recipesDir, deploymentName } from "#src/runtime/deployment.ts";
import { listRecipeDirectories } from "#src/service/recipe.ts";
import { openclawCliJson, withModelApproval } from "#src/service/openclaw-cli.ts";
import { recipeServerContainerPath, mcpServerMatches } from "#src/commands/management/provision-agent/index.ts";
import type { CheckOutcome } from "#src/commands/check-outcome.ts";
import type { Context } from "#src/core/context.ts";
import { withUnpackedArtifact } from "#src/set/artifacts/install.ts";
import type { VerifiedArtifact } from "#src/set/artifacts/install.ts";
import { readAcceptanceFile } from "#src/set/recipe-files.ts";
import { withSetSource } from "#src/set/artifacts/source.ts";
import { observeRuntime, runtimeMatches, saveEvidence } from "#src/set/artifacts/evidence.ts";
import type { ObservedRuntime } from "#src/set/artifacts/evidence.ts";
import { gatherInspection } from "./inspect/gather.ts";
import { isHealthy, blockingProblems } from "#src/service/inspection.ts";
import { runSecurityAudit, type SecurityFinding, type SecurityAuditReport } from "#src/security/audit.ts";
import type { ArgumentSpec } from "#src/core/command/spec.ts";
import type { LocalArtifact, RecipeRef } from "#src/core/values/plan.ts";
import { commandBody, runOnContext } from "#src/core/command/index.ts";

export const DID_NOT_PASS = "acceptance check(s) did not pass";

export const ACCEPT_ARGUMENTS = [
  {
    name: "recipe",
    summary: "Recipe to check",
    description: "Recipe to check (default: every recipe that declares checks)",
    kind: "positional",
    value: kinds.recipeRef(),
  },
  { name: "set", description: "Check the verified artifact and save an acceptance receipt", kind: "option", valueName: "artifact", value: kinds.localFile("a set artifact path") },
  { name: "with-model", description: "Include model checks", kind: "flag" },
  { name: "json", description: "Report as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

/** One declared check. `kind` selects what the framework does; everything else is that
 *  kind's own arguments, kept loose because each kind reads different ones. */
export interface AcceptanceCheck {
  readonly kind: string;
  readonly name?: string;
  /** True when running this check calls the model: costs tokens, takes an agent turn, and
   *  the turn has side effects of its own. Never run unless explicitly asked for. */
  readonly usesModel?: boolean;
  readonly [argument: string]: unknown;
}

/** The acceptance readings of the shared check outcomes. The four values and the reasoning
 *  behind them live in commands/check-outcome.ts, beside the error classes a throw-style
 *  check suite uses to land on them. */
export type AcceptanceStatus = CheckOutcome;

/** Model use is a property of the operation, not a claim made by deployment metadata.
 * `usesModel: false` on `agent_answers` must not make a paid check run accidentally. */
export function requiresModel(kind: unknown): boolean {
  return kind === "agent_answers";
}

export interface AcceptanceResult {
  readonly name: string;
  readonly kind: string;
  readonly status: AcceptanceStatus;
  readonly detail?: string;
}

export interface AcceptanceReport {
  readonly deployment: string;
  readonly recipes: Record<string, AcceptanceResult[]>;
  readonly passed: number;
  readonly failed: number;
  readonly notChecked: number;
  readonly couldNotCheck: number;
  /** One sentence, the same facts the counts already carry — so a coder and an agent read
   *  one answer rather than reconstructing it themselves from the counts. */
  readonly summary: string;
  /** Not merely failed === 0: a suite that could not obtain a verdict for something has not
   *  earned the right to call itself passing either — that is a different, quieter way for
   *  a broken deployment to report success. */
  readonly healthy: boolean;
  readonly receipt?: { id: string; setId: string; verdict: string };
  /** The security gate (security/audit.ts): OpenClaw's own audits plus what only
   *  the host side can see. Present whenever the gate ran, even with zero findings — a
   *  reader must be able to tell "ran clean" from "field not implemented yet". */
  readonly security: { findings: readonly SecurityFinding[]; blocking: number; warnings: number };
}

/** The one sentence both the prose and the JSON output carry. Exported so `set try`'s own
 *  report can say the same thing about acceptance in the same words. */
export function summarize(passed: number, failed: number, notChecked: number, couldNotCheck: number): string {
  const parts = [`${passed} passed`, `${failed} failed`];
  if (couldNotCheck > 0) parts.push(`${couldNotCheck} could not be checked`);
  if (notChecked > 0) parts.push(`${notChecked} not checked`);
  return parts.join(", ");
}

/** Validates the small part of a check declaration the dispatcher relies on. Arguments that
 * belong to a particular kind are validated by that kind at execution time, where a missing
 * target can be reported as `could-not-check` instead of taking down the rest of a suite. */
export function acceptanceSpecError(value: unknown, index?: number): string | undefined {
  const where = index === undefined ? "acceptance check" : `acceptance check ${index + 1}`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return `${where} must be an object`;
  const check = value as Record<string, unknown>;
  if (typeof check.kind !== "string" || check.kind.trim() === "") return `${where} needs a non-empty string "kind"`;
  if (check.name !== undefined && (typeof check.name !== "string" || check.name.trim() === "")) {
    return `${where} "${check.kind}" has an invalid "name"`;
  }
  if (check.usesModel !== undefined && typeof check.usesModel !== "boolean") {
    return `${where} "${check.kind}" has a non-boolean "usesModel"`;
  }
  const stringField = (field: string): boolean => check[field] === undefined || (typeof check[field] === "string" && (check[field] as string).trim() !== "");
  const requiredString = (field: string): boolean => typeof check[field] === "string" && (check[field] as string).trim() !== "";
  if (check.kind === "mcp_responds" && check.tools !== undefined && (!Array.isArray(check.tools) || check.tools.some((tool) => typeof tool !== "string" || tool.trim() === ""))) {
    return `${where} "mcp_responds" has an invalid "tools" array`;
  }
  if (check.kind === "mcp_tool" && (!requiredString("tool") || !stringField("expect") || (check.arguments !== undefined && (check.arguments === null || typeof check.arguments !== "object" || Array.isArray(check.arguments))))) {
    return `${where} "mcp_tool" has invalid tool, expect or arguments fields`;
  }
  if (check.kind === "agent_has_tools" && (!requiredString("agent") || !requiredString("server"))) {
    return `${where} "agent_has_tools" needs non-empty "agent" and "server" strings`;
  }
  if (check.kind === "cron_matches" && (!requiredString("job") || !stringField("schedule") || !stringField("timezone"))) {
    return `${where} "cron_matches" has an invalid job or schedule`;
  }
  if (check.kind === "agent_answers" && (!requiredString("agent") || !requiredString("message") || !stringField("expect"))) {
    return `${where} "agent_answers" has invalid agent, message or expect fields`;
  }
  return undefined;
}

async function loadChecks(recipe: string): Promise<AcceptanceCheck[] | undefined> {
  const file = await readAcceptanceFile(resolve(recipesDir(), recipe, "acceptance.json"), recipe);
  if (file === undefined) return undefined;
  if (!file.ok) throw new Error(file.reason);
  return file.value;
}

async function recipesWithAcceptance(): Promise<string[]> {
  const entries = (await listRecipeDirectories(recipesDir())).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const found: string[] = [];
  for (const name of entries.sort()) {
    if ((await loadChecks(name)) !== undefined) found.push(name);
  }
  return found;
}

/** Speaks JSON-RPC to a recipe's MCP server the way a client would: inside the container,
 *  same process the gateway would spawn, same mirrored files.
 *
 *  One exchange per call, not a kept-open session: a short-lived process also proves the
 *  server can be started at all, half of what "the MCP server answers" means. */
async function askRecipeServer(
  ctx: Context,
  recipe: string,
  requests: unknown[],
): Promise<{ responses: Record<string, unknown>[]; exitCode: number; stderr: string }> {
  const input = `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`;

  const result = await ctx.runtime.runOneOff(
    "gateway",
    ["--experimental-strip-types", recipeServerContainerPath(recipe)],
    { noDeps: true, entrypoint: "node", input, allowFailure: true },
  );

  const responses = result.stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    });

  // The exit code travels with the answers on purpose: a server that printed something and
  // then died has not answered, and a check reading only the text would call that a pass.
  return { responses, exitCode: result.code, stderr: result.stderr };
}

function textOf(response: Record<string, unknown> | undefined): string {
  const content = (response?.result as { content?: { text?: string }[] } | undefined)?.content;
  return content?.map((entry) => entry.text ?? "").join("\n") ?? "";
}

/** Whether the call itself worked, before anything is asked about what it said. Checks all
 *  three failure paths: JSON-RPC `error`, `result.isError` (a tool reporting its own
 *  failure, e.g. "no such page"), and the process exit code — a check missing any of these
 *  can pass on a broken deployment whenever expected text appears in the failure message. */
function callFailure(
  answer: Record<string, unknown> | undefined,
  exitCode: number,
  stderr: string,
): string | undefined {
  if (exitCode !== 0) {
    return `the server exited ${exitCode}${stderr.trim() === "" ? "" : `: ${stderr.trim().split("\n").slice(-2).join(" ")}`}`;
  }
  if (answer === undefined) return "the server sent no answer to the call";
  if (answer.error !== undefined) return `the server refused the call: ${JSON.stringify(answer.error)}`;
  if ((answer.result as { isError?: unknown } | undefined)?.isError === true) {
    return `the tool reported failure: ${JSON.stringify(textOf(answer).slice(0, 160))}`;
  }
  return undefined;
}

/** The three verdicts every check kind reports through — built once per runCheck call so
 *  each branch stays a plain function of (ctx, recipe, check, verdicts). */
interface CheckVerdicts {
  readonly fail: (detail: string) => AcceptanceResult;
  readonly pass: (detail?: string) => AcceptanceResult;
  readonly unclear: (detail: string) => AcceptanceResult;
}

async function runMcpRespondsCheck(ctx: Context, recipe: string, check: AcceptanceCheck, verdicts: CheckVerdicts): Promise<AcceptanceResult> {
  const expected = Array.isArray(check.tools) ? (check.tools as string[]) : [];
  const { responses, exitCode, stderr } = await askRecipeServer(ctx, recipe, [
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  const initialized = responses.find((response) => response.id === 1);
  const listed = responses.find((response) => response.id === 2);
  const broken = callFailure(initialized, exitCode, stderr) ?? callFailure(listed, exitCode, stderr);
  if (broken !== undefined) return verdicts.unclear(broken);

  const tools = ((listed?.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map((tool) => tool.name);
  const absent = expected.filter((tool) => !tools.includes(tool));
  return absent.length === 0
    ? verdicts.pass(`${tools.length} tool(s): ${tools.join(", ")}`)
    : verdicts.fail(`missing tool(s): ${absent.join(", ")} — offered ${tools.join(", ")}`);
}

async function runMcpToolCheck(ctx: Context, recipe: string, check: AcceptanceCheck, verdicts: CheckVerdicts): Promise<AcceptanceResult> {
  const tool = typeof check.tool === "string" ? check.tool : undefined;
  if (tool === undefined) return verdicts.unclear('the check declares no "tool"');
  const args = (check.arguments ?? {}) as Record<string, unknown>;
  const { responses, exitCode, stderr } = await askRecipeServer(ctx, recipe, [
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } },
  ]);
  const initialized = responses.find((response) => response.id === 1);
  const answer = responses.find((response) => response.id === 2);

  // Call success checked before the answer's content, or isError "no such page" passes
  // whenever the expected text happens to appear in that message.
  const broken = callFailure(initialized, exitCode, stderr) ?? callFailure(answer, exitCode, stderr);
  if (broken !== undefined) return verdicts.unclear(broken);

  const text = textOf(answer);
  if (text === "") return verdicts.unclear("the tool answered with nothing");
  if (typeof check.expect === "string" && !text.includes(check.expect)) {
    return verdicts.fail(`the answer does not contain ${JSON.stringify(check.expect)} — got ${JSON.stringify(text.slice(0, 120))}`);
  }
  return verdicts.pass(typeof check.expect === "string" ? `contains ${JSON.stringify(check.expect)}` : `${text.length} character(s)`);
}

async function runAgentHasToolsCheck(ctx: Context, recipe: string, check: AcceptanceCheck, verdicts: CheckVerdicts): Promise<AcceptanceResult> {
  const agentId = typeof check.agent === "string" ? check.agent : undefined;
  const server = typeof check.server === "string" ? check.server : undefined;
  if (agentId === undefined || server === undefined) return verdicts.unclear('the check needs both "agent" and "server"');

  // Reaching openclawCliJson at all is an obtained verdict from here on: the instance
  // answered, and either it has the agent/server declared or it does not.
  const agents = await openclawCliJson<Array<{ id: string }>>(ctx, ["agents", "list", "--json"]);
  if (!agents.some((entry) => entry.id === agentId)) return verdicts.fail(`the instance has no agent "${agentId}"`);

  const servers = await openclawCliJson<Record<string, { command?: unknown; args?: unknown }>>(ctx, ["mcp", "list", "--json"]);
  const entry = servers[server];
  if (entry === undefined) return verdicts.fail(`MCP server "${server}" is not registered, so agent "${agentId}" cannot call it`);
  // A name present says nothing about whether it still launches the recipe's own
  // server.ts — a hand-edited or stale command registers cleanly and answers nothing.
  if (!mcpServerMatches(entry, recipe)) {
    return verdicts.fail(`MCP server "${server}" is registered but its command does not match recipe "${recipe}" — it will not serve the recipe's tools`);
  }
  return verdicts.pass(`agent "${agentId}" and MCP server "${server}" are both registered`);
}

async function runCronMatchesCheck(ctx: Context, check: AcceptanceCheck, verdicts: CheckVerdicts): Promise<AcceptanceResult> {
  const jobName = typeof check.job === "string" ? check.job : undefined;
  const schedule = typeof check.schedule === "string" ? check.schedule : undefined;
  if (jobName === undefined) return verdicts.unclear('the check declares no "job"');

  const listed = await openclawCliJson<{ jobs: { name?: string; schedule?: { expr?: string; tz?: string } }[] }>(ctx, ["cron", "list", "--json"]);
  const job = listed.jobs.find((entry) => entry.name === jobName);
  if (job === undefined) return verdicts.fail(`no cron job named "${jobName}"`);
  if (schedule !== undefined && job.schedule?.expr !== schedule) {
    return verdicts.fail(`"${jobName}" runs at ${job.schedule?.expr ?? "(none)"}, declared ${schedule}`);
  }
  if (typeof check.timezone === "string" && job.schedule?.tz !== check.timezone) {
    return verdicts.fail(`"${jobName}" timezone is ${job.schedule?.tz ?? "(host default)"}, declared ${check.timezone}`);
  }
  return verdicts.pass(`"${jobName}" at ${job.schedule?.expr ?? "(none)"}`);
}

async function runAgentAnswersCheck(ctx: Context, check: AcceptanceCheck, verdicts: CheckVerdicts): Promise<AcceptanceResult> {
  // The one kind that costs money. Reaching here means it was explicitly asked for.
  const agentId = typeof check.agent === "string" ? check.agent : undefined;
  const message = typeof check.message === "string" ? check.message : undefined;
  if (agentId === undefined || message === undefined) return verdicts.unclear('the check needs both "agent" and "message"');

  const result = await ctx.runtime.runOneOff(
    "cli",
    ["agent", "--agent", agentId, "-m", message],
    { profile: "cli", input: "", allowFailure: true },
  );
  if (result.code !== 0) return verdicts.unclear(`the agent call exited ${result.code}: ${result.stderr.trim().split("\n").slice(-2).join(" ")}`);
  const answer = result.stdout.trim();
  if (answer === "") return verdicts.unclear("the agent answered with nothing");
  if (typeof check.expect === "string" && !answer.toLowerCase().includes(check.expect.toLowerCase())) {
    return verdicts.fail(`the answer does not mention ${JSON.stringify(check.expect)} — got ${JSON.stringify(answer.slice(0, 160))}`);
  }
  return verdicts.pass(`answered ${answer.length} character(s)`);
}

/** Runs one declared check. Exported so each kind can be exercised on its own.
 *
 *  Never throws: a call that can't even reach the instance is exactly what "could not
 *  check" means, not a reason to stop the whole suite. Every branch makes the same
 *  distinction — did this obtain an actual answer, or not — only the former is a verdict. */
export async function runCheck(ctx: Context, recipe: string, check: AcceptanceCheck): Promise<AcceptanceResult> {
  const name = check.name ?? check.kind;
  const verdicts: CheckVerdicts = {
    fail: (detail) => ({ name, kind: check.kind, status: "failed", detail }),
    pass: (detail) => ({ name, kind: check.kind, status: "passed", detail }),
    unclear: (detail) => ({ name, kind: check.kind, status: "could-not-check", detail }),
  };

  try {
    switch (check.kind) {
      case "mcp_responds": return await runMcpRespondsCheck(ctx, recipe, check, verdicts);
      case "mcp_tool": return await runMcpToolCheck(ctx, recipe, check, verdicts);
      case "agent_has_tools": return await runAgentHasToolsCheck(ctx, recipe, check, verdicts);
      case "cron_matches": return await runCronMatchesCheck(ctx, check, verdicts);
      case "agent_answers": return await runAgentAnswersCheck(ctx, check, verdicts);
      default:
        return verdicts.unclear(`unknown check kind "${check.kind}" — this framework does not implement it`);
    }
  } catch (error) {
    // openclawCliJson throws on a call the instance itself refused (a scope upgrade that
    // never landed, a connection the gateway closed) — reaching the instance failed, which
    // is this check's job to report, not a reason to take the rest of the suite down with it.
    return verdicts.unclear(error instanceof Error ? error.message : String(error));
  }
}

//** Everything the run needs, decided from the arguments alone in the prepare stage. The
// recipe and the --set artifact arrive resolved (the kinds' own existence proofs, S2.5). */
interface AcceptPlan {
  readonly recipe?: RecipeRef;
  readonly set?: LocalArtifact;
  readonly withModel: boolean;
  readonly json: boolean;
}

export const ACCEPT = commandBody({
  effect: "change",
  arguments: ACCEPT_ARGUMENTS,
  localFacts: [
    // With --set, the recipe names one inside the artifact, not one on this machine. The
    // artifact/recipe existence facts themselves live on the value kinds' resolve (S2.5).
    { argument: "recipe", fact: "acceptance", unless: "set" },
  ],
  prepare: async ({ values }) => {
    return {
      recipe: values.recipe,
      set: values.set,
      withModel: values["with-model"],
      json: values.json,
    } satisfies AcceptPlan;
  },
  run: (ctx, plan) => acceptPlan(ctx, plan),
});

/** The full-context entry for callers outside this group (the set evidence and MCP CLI
 *  checks): the same declaration, parsed and run on a context they already hold. */
export const accept = (ctx: Context, args: string[]): Promise<void> => runOnContext(ACCEPT, ctx, args);

/** With --set, the checks run against the verified artifact and its recipe files for the
 *  whole run — so a receipt never describes the working tree while naming the set's id. */
async function acceptPlan(ctx: Context, plan: AcceptPlan): Promise<void> {
  const { set: artifact } = plan;
  if (artifact === undefined) return withModelApproval(plan.withModel, () => acceptFromSource(ctx, plan));
  return withModelApproval(plan.withModel, () =>
    withUnpackedArtifact(artifact, (staging, verified) => withSetSource(staging, () => acceptFromSource(ctx, plan, verified))));
}

/** Tallies one accept run across every selected recipe's declared checks. */
interface AcceptanceRunTotals {
  readonly report: Record<string, AcceptanceResult[]>;
  readonly passed: number;
  readonly failed: number;
  readonly notChecked: number;
  readonly couldNotCheck: number;
}

async function runAcceptanceChecks(ctx: Context, recipes: string[], withModel: boolean, checksByRecipe: ReadonlyMap<string, AcceptanceCheck[]>): Promise<AcceptanceRunTotals> {
  const report: Record<string, AcceptanceResult[]> = {};
  let passed = 0;
  let failed = 0;
  let notChecked = 0;
  let couldNotCheck = 0;

  for (const recipe of recipes) {
    const checks = checksByRecipe.get(recipe);
    if (checks === undefined) die(`recipe "${recipe}" declares no acceptance checks (recipes/${recipe}/acceptance.json)`);

    const results: AcceptanceResult[] = [];
    for (const check of checks) {
      if ((requiresModel(check.kind) || check.usesModel === true) && !withModel) {
        // Named and counted, never omitted: a suite that quietly drops what it did not run
        // reads as coverage it does not have.
        results.push({
          name: check.name ?? check.kind,
          kind: check.kind,
          status: "not-checked",
          detail: "calls the model — run with --with-model to include it",
        });
        notChecked += 1;
        continue;
      }

      try {
        const result = await runCheck(ctx, recipe, check);
        results.push(result);
        if (result.status === "passed") passed += 1;
        else if (result.status === "failed") failed += 1;
        else if (result.status === "could-not-check") couldNotCheck += 1;
        else notChecked += 1;
      } catch (error) {
        results.push({
          name: check.name ?? check.kind,
          kind: check.kind,
          status: "could-not-check",
          detail: error instanceof Error ? error.message : String(error),
        });
        couldNotCheck += 1;
      }
    }
    report[recipe] = results;
  }

  return { report, passed, failed, notChecked, couldNotCheck };
}

/** The security gate: only doctor and accept run it (each audit is a container exec) — see
 *  security/audit.ts. A blocking finding fails acceptance the same way a failed check does;
 *  a warning is reported but does not. */
async function buildAcceptanceReport(
  ctx: Context,
  totals: AcceptanceRunTotals,
): Promise<{ answer: AcceptanceReport; security: SecurityAuditReport; securityBlocking: number }> {
  const security = await runSecurityAudit(ctx);
  const securityBlocking = blockingProblems(security.problems).length;
  const securityWarnings = security.problems.length - securityBlocking;

  const answer: AcceptanceReport = {
    deployment: deploymentName(),
    recipes: totals.report,
    passed: totals.passed,
    failed: totals.failed,
    notChecked: totals.notChecked,
    couldNotCheck: totals.couldNotCheck,
    summary: summarize(totals.passed, totals.failed, totals.notChecked, totals.couldNotCheck),
    healthy: totals.passed > 0 && totals.failed === 0 && totals.notChecked === 0 && totals.couldNotCheck === 0 && securityBlocking === 0,
    security: { findings: security.findings, blocking: securityBlocking, warnings: securityWarnings },
  };
  return { answer, security, securityBlocking };
}

/** Observes the runtime again after the checks ran, saves the evidence receipt, and folds
 *  it into the answer — only when this run started from a verified --set artifact. */
async function attachAcceptanceReceipt(
  ctx: Context,
  verified: VerifiedArtifact,
  before: ObservedRuntime,
  matchedBefore: boolean,
  startedAt: string,
  withModel: boolean,
  recipes: string[],
  report: Record<string, AcceptanceResult[]>,
  answer: AcceptanceReport,
  security: SecurityAuditReport,
  jsonOnly: boolean,
): Promise<AcceptanceReport> {
  const after = await observeRuntime(ctx, verified.manifest);
  let matchedAfter = false;
  try { matchedAfter = isHealthy(await gatherInspection(ctx)); } catch { /* Unverified binding. */ }
  const receipt = await saveEvidence({
    verified, source: "accept", startedAt, withModel, selected: recipes, results: report,
    observed: after, subjectVerified: matchedBefore && matchedAfter && runtimeMatches(verified.manifest, before, after),
    security,
  });
  if (!jsonOnly && !isCaptured()) info(`receipt: ${receipt.receiptId} (${receipt.verdict})`);
  return { ...answer, receipt: { id: receipt.receiptId, setId: receipt.setId, verdict: receipt.verdict } };
}

function printAcceptanceReport(
  answer: AcceptanceReport,
  report: Record<string, AcceptanceResult[]>,
  security: SecurityAuditReport,
  notChecked: number,
  withModel: boolean,
): void {
  for (const [recipe, results] of Object.entries(report)) {
    log(`recipe ${recipe}`);
    for (const result of results) {
      const line = `${result.status.toUpperCase().padEnd(7)} ${result.name}${result.detail === undefined ? "" : `  ${result.detail}`}`;
      if (result.status === "failed") warn(line);
      else info(line);
    }
  }
  if (security.findings.length > 0) {
    log("security");
    for (const finding of security.findings) {
      const label = finding.suppressed ? "SUPPRESSED" : finding.severity === "blocking" ? "BLOCKING" : "WARN";
      const line = `${label.padEnd(10)} ${finding.source} ${finding.checkId}${finding.title === undefined ? "" : ` ${finding.title}`}  ${finding.message}` +
        (finding.remediation === undefined ? "" : `; remediation: ${finding.remediation}`) +
        (finding.suppressed ? ` (suppressed: ${finding.suppressedReason})` : "");
      if (finding.severity === "blocking" && !finding.suppressed) warn(line);
      else info(line);
    }
  }
  log(answer.summary);
  if (notChecked > 0 && !withModel) info(`the not-checked ones call the model: ${commandLine(["accept", "--with-model"])}`);
}

async function acceptFromSource(ctx: Context, plan: AcceptPlan, verified?: VerifiedArtifact): Promise<void> {
  const startedAt = new Date().toISOString();
  const jsonOnly = plan.json;
  const withModel = plan.withModel;
  const wanted = plan.recipe;

  const recipes = wanted === undefined ? await recipesWithAcceptance() : [wanted];
  if (recipes.length === 0) {
    die("no recipe declares acceptance checks — add recipes/<name>/acceptance.json");
  }

  // Q5 pre-pass: every content refusal over the selected recipes (membership in the --set
  // artifact's manifest, the acceptance.json fact) fires HERE, before the first ctx contact —
  // the observeRuntime/gatherInspection block below never runs before a local refusal.
  const checksByRecipe = new Map<string, AcceptanceCheck[]>();
  for (const recipe of recipes) {
    const checks = await loadChecks(recipe);
    if (checks === undefined) die(`recipe "${recipe}" declares no acceptance checks (recipes/${recipe}/acceptance.json)`);
    checksByRecipe.set(recipe, checks);
  }

  const before = verified === undefined ? undefined : await observeRuntime(ctx, verified.manifest);
  let matchedBefore = false;
  if (verified !== undefined) {
    try { matchedBefore = isHealthy(await gatherInspection(ctx)); } catch { /* Unverified binding. */ }
  }

  const totals = await runAcceptanceChecks(ctx, recipes, withModel, checksByRecipe);
  const { answer: baseAnswer, security, securityBlocking } = await buildAcceptanceReport(ctx, totals);
  const answer = verified !== undefined && before !== undefined
    ? await attachAcceptanceReceipt(ctx, verified, before, matchedBefore, startedAt, withModel, recipes, totals.report, baseAnswer, security, jsonOnly)
    : baseAnswer;

  if (jsonOnly || isCaptured()) {
    emit(`${JSON.stringify(answer, null, 2)}\n`);
  } else {
    printAcceptanceReport(answer, totals.report, security, totals.notChecked, withModel);
  }

  if (totals.failed > 0 || totals.couldNotCheck > 0 || securityBlocking > 0) {
    const securityNote = securityBlocking > 0 ? `; ${securityBlocking} blocking security finding(s)` : "";
    throw new Error(`${totals.failed + totals.couldNotCheck} ${DID_NOT_PASS}${securityNote}`);
  }
}
