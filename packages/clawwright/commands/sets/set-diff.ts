// Semantic comparison of two verified set artifacts.
//
// The archive verifier is deliberately kept at the command boundary: a checksum map is a
// claim until withUnpackedArtifact has checked every byte. The diff engine below then deals
// only in declarations and checksums, so it can be used by the terminal and by MCP with the
// same answer.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { die, info, log } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { withArtifactInspected } from "#src/set/artifacts/install.ts";
import { canonicalJson } from "#src/set/artifacts/model.ts";
import type { SetManifest, SetRecipe } from "#src/set/artifacts/model.ts";
import type { Context } from "#src/core/context.ts";
import type { PrepareCall, ArgumentSpec, Values } from "#src/core/command/index.ts";
import * as kinds from "#src/core/values/kinds.ts";
import type { LocalArtifact } from "#src/core/values/plan.ts";

export type SetDiffAction = "added" | "removed" | "changed";
export type SetDiffKind =
  | "requirement"
  | "secret"
  | "config"
  | "recipe"
  | "agent"
  | "mcp-server"
  | "cron"
  | "content"
  | "prompt"
  | "acceptance";

export interface SetDiffChange {
  readonly kind: SetDiffKind;
  readonly action: SetDiffAction;
  /** Stable scope for a caller that wants to group changes without parsing detail. */
  readonly scope: string;
  /** Field or relative file path within the scope. */
  readonly field?: string;
  readonly from?: unknown;
  readonly to?: unknown;
  /** Present for changes where an operator must make a separate decision. */
  readonly advisory?: string;
}

export interface SetDiffResult {
  readonly from: { readonly id: string; readonly name: string };
  readonly to: { readonly id: string; readonly name: string };
  readonly changed: boolean;
  readonly noChanges: boolean;
  readonly changes: readonly SetDiffChange[];
}

export interface DiffSnapshot {
  readonly manifest: SetManifest;
  readonly id: string;
  readonly staging?: string;
}

interface ConfigValue {
  readonly value: unknown;
  readonly duplicate: boolean;
}

function mapConfig(value: unknown): Map<string, ConfigValue> {
  const result = new Map<string, ConfigValue>();
  if (!Array.isArray(value)) {
    result.set("<declaration>", { value, duplicate: false });
    return result;
  }
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || typeof (entry as { path?: unknown }).path !== "string") {
      const key = `<entry-${result.size}>`;
      result.set(key, { value: entry, duplicate: false });
      continue;
    }
    const item = entry as { path: string; value?: unknown };
    const previous = result.get(item.path);
    // apply-config processes declarations in order, so the last declaration is the effective
    // one. Keeping that rule here makes a duplicate path compare by behavior, not by spelling.
    result.set(item.path, { value: item.value, duplicate: previous !== undefined || false });
  }
  return result;
}

function sortedUnion(a: Iterable<string>, b: Iterable<string>): string[] {
  return [...new Set([...a, ...b])].sort();
}

function addValueChange(
  changes: SetDiffChange[],
  kind: SetDiffKind,
  scope: string,
  field: string,
  from: unknown,
  to: unknown,
  action: SetDiffAction = "changed",
  advisory?: string,
): void {
  const change: SetDiffChange = { kind, action, scope, field, from, to, ...(advisory === undefined ? {} : { advisory }) };
  changes.push(change);
}

function compareMaps(
  changes: SetDiffChange[],
  kind: SetDiffKind,
  scope: string,
  from: Record<string, string>,
  to: Record<string, string>,
  fieldPrefix = "",
): void {
  for (const key of sortedUnion(Object.keys(from), Object.keys(to))) {
    const left = from[key];
    const right = to[key];
    if (left === right) continue;
    const field = `${fieldPrefix}${key}`;
    if (left === undefined) addValueChange(changes, kind, scope, field, undefined, right, "added");
    else if (right === undefined) addValueChange(changes, kind, scope, field, left, undefined, "removed");
    else addValueChange(changes, kind, scope, field, left, right);
  }
}

function recipeCron(recipe: SetRecipe, message: string | undefined): Record<string, unknown> | undefined {
  const agent = recipe.agent;
  if (agent?.cronJobName === undefined || recipe.agentFiles?.["cron-message.txt"] === undefined) return undefined;
  return {
    jobName: agent.cronJobName,
    schedule: agent.cronSchedule,
    timezone: agent.cronTimezone,
    timeoutSeconds: agent.cronTimeoutSeconds,
    message,
  };
}

function compareConfig(changes: SetDiffChange[], from: unknown, to: unknown): void {
  const left = mapConfig(from);
  const right = mapConfig(to);
  for (const path of sortedUnion(left.keys(), right.keys())) {
    const a = left.get(path);
    const b = right.get(path);
    const av = a?.value;
    const bv = b?.value;
    if (canonicalJson(av) === canonicalJson(bv)) continue;
    const action: SetDiffAction = a === undefined ? "added" : b === undefined ? "removed" : "changed";
    addValueChange(changes, "config", "desired-state", path, av, bv, action);
  }
}

function compareAcceptance(changes: SetDiffChange[], recipe: string, from: readonly unknown[] | undefined, to: readonly unknown[] | undefined): void {
  const left = from ?? [];
  const right = to ?? [];
  if (canonicalJson(left) === canonicalJson(right)) return;
  const action: SetDiffAction = from === undefined ? "added" : to === undefined ? "removed" : "changed";
  addValueChange(changes, "acceptance", recipe, "checks", left, right, action);
}

function compareRecipe(changes: SetDiffChange[], name: string, from: SetRecipe, to: SetRecipe, fromMessage?: string, toMessage?: string): void {
  // acceptance.json is compared as parsed checks below, so content changes describe the
  // recipe's runtime files rather than repeating a specification change as a checksum.
  const contentFiles = (files: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(files).filter(([path]) => path !== "acceptance.json"));
  compareMaps(changes, "content", name, contentFiles(from.files), contentFiles(to.files));
  // config.json is represented as the parsed agent declaration below, and cron-message.txt
  // is represented as a cron field below. Keeping those files out of the prompt list avoids
  // reporting one edit twice under two unrelated meanings.
  const promptFiles = (files: Record<string, string> | undefined): Record<string, string> =>
    Object.fromEntries(Object.entries(files ?? {}).filter(([path]) => path !== "config.json" && path !== "cron-message.txt"));
  compareMaps(changes, "prompt", name, promptFiles(from.agentFiles), promptFiles(to.agentFiles), "agent/");

  const oldAgent = from.agent;
  const newAgent = to.agent;
  if (oldAgent === undefined && newAgent !== undefined) {
    addValueChange(changes, "agent", name, "declaration", undefined, newAgent, "added");
  } else if (oldAgent !== undefined && newAgent === undefined) {
    addValueChange(
      changes,
      "agent",
      name,
      "declaration",
      oldAgent,
      undefined,
      "removed",
      `The agent workspace and memory are left untouched; use ${commandLine(["set", "forget", "--kind", "agent", "--name", "<id>"])} for an explicit separate deletion.`,
    );
  } else if (oldAgent !== undefined && newAgent !== undefined) {
    if (oldAgent.agentId !== newAgent.agentId) {
      addValueChange(
        changes,
        "agent",
        name,
        "agentId",
        oldAgent.agentId,
        newAgent.agentId,
        "changed",
        `The old agent workspace and memory are left untouched; use ${commandLine(["set", "forget", "--kind", "agent", "--name", oldAgent.agentId])} only if that separate deletion is intended.`,
      );
    }
    if (oldAgent.mcpServerName !== newAgent.mcpServerName) {
      addValueChange(changes, "mcp-server", name, "name", oldAgent.mcpServerName, newAgent.mcpServerName);
    }
  }

  const oldCron = oldAgent === undefined ? undefined : recipeCron(from, fromMessage);
  const newCron = newAgent === undefined ? undefined : recipeCron(to, toMessage);
  const oldFields = oldCron ?? {};
  const newFields = newCron ?? {};
  for (const field of ["jobName", "schedule", "timezone", "timeoutSeconds", "message"]) {
    const left = oldFields[field];
    const right = newFields[field];
    if (canonicalJson(left) === canonicalJson(right)) continue;
    const action: SetDiffAction = left === undefined ? "added" : right === undefined ? "removed" : "changed";
    addValueChange(changes, "cron", name, field, left, right, action);
  }
  if (fromMessage === undefined && toMessage === undefined
    && from.agentFiles?.["cron-message.txt"] !== to.agentFiles?.["cron-message.txt"]) {
    addValueChange(changes, "cron", name, "messageChecksum", from.agentFiles?.["cron-message.txt"], to.agentFiles?.["cron-message.txt"]);
  }
}

function advisoryForRecipeRemoval(recipe: SetRecipe, _name: string): string | undefined {
  const id = recipe.agent?.agentId;
  if (id === undefined) return undefined;
  return `The agent workspace and memory for ${id} are left untouched; use ${commandLine(["set", "forget", "--kind", "agent", "--name", id])} for an explicit separate deletion.`;
}

/** Pure semantic diff. `desiredState` and `cronMessages` are loaded from verified staging by
 * the command; leaving them optional keeps this useful for callers that only have manifests.
 */
export function diffManifests(
  from: DiffSnapshot,
  to: DiffSnapshot,
  options: { readonly fromDesiredState?: unknown; readonly toDesiredState?: unknown; readonly fromCronMessages?: Record<string, string | undefined>; readonly toCronMessages?: Record<string, string | undefined> } = {},
): SetDiffResult {
  const changes: SetDiffChange[] = [];
  const oldManifest = from.manifest;
  const newManifest = to.manifest;

  for (const field of ["framework", "image"] as const) {
    if (oldManifest.requires[field] !== newManifest.requires[field]) {
      addValueChange(changes, "requirement", "requires", field, oldManifest.requires[field], newManifest.requires[field]);
    }
  }

  const oldSecrets = new Set(oldManifest.secrets);
  const newSecrets = new Set(newManifest.secrets);
  for (const secret of sortedUnion(oldSecrets, newSecrets)) {
    if (oldSecrets.has(secret) === newSecrets.has(secret)) continue;
    addValueChange(changes, "secret", "secrets", secret, oldSecrets.has(secret) ? secret : undefined, newSecrets.has(secret) ? secret : undefined, oldSecrets.has(secret) ? "removed" : "added");
  }

  if (options.fromDesiredState !== undefined && options.toDesiredState !== undefined) {
    compareConfig(changes, options.fromDesiredState, options.toDesiredState);
  } else if (oldManifest.files["config/desired-state.json"] !== newManifest.files["config/desired-state.json"]) {
    addValueChange(changes, "config", "desired-state", "checksum", oldManifest.files["config/desired-state.json"], newManifest.files["config/desired-state.json"]);
  }

  for (const recipe of sortedUnion(Object.keys(oldManifest.recipes), Object.keys(newManifest.recipes))) {
    const left = oldManifest.recipes[recipe];
    const right = newManifest.recipes[recipe];
    if (left === undefined) {
      addValueChange(changes, "recipe", recipe, "name", undefined, recipe, "added");
      continue;
    }
    if (right === undefined) {
      addValueChange(changes, "recipe", recipe, "name", recipe, undefined, "removed", advisoryForRecipeRemoval(left, recipe));
      continue;
    }
    compareRecipe(changes, recipe, left, right, options.fromCronMessages?.[recipe], options.toCronMessages?.[recipe]);
    compareAcceptance(changes, recipe, oldManifest.acceptance[recipe], newManifest.acceptance[recipe]);
  }

  changes.sort((a, b) => {
    const left = `${a.kind}\u0000${a.scope}\u0000${a.field ?? ""}\u0000${a.action}`;
    const right = `${b.kind}\u0000${b.scope}\u0000${b.field ?? ""}\u0000${b.action}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return {
    from: { id: from.id, name: oldManifest.name },
    to: { id: to.id, name: newManifest.name },
    // The ids are deliberately reported even when only the set name or an otherwise
    // non-behavioral representation changed. `changed` answers the semantic question a
    // caller has before applying; it is therefore exactly the inverse of noChanges.
    changed: changes.length > 0,
    noChanges: changes.length === 0,
    changes,
  };
}

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { die(`artifact declaration ${path} is not valid JSON: ${(error as Error).message}`); }
}

async function cronMessages(staging: string, manifest: SetManifest): Promise<Record<string, string | undefined>> {
  const messages: Record<string, string | undefined> = {};
  for (const [recipe, entry] of Object.entries(manifest.recipes)) {
    if (entry.agent?.cronJobName === undefined) continue;
    try { messages[recipe] = (await readFile(resolve(staging, "recipes", recipe, "agent", "cron-message.txt"), "utf8")).trim(); }
    catch { messages[recipe] = undefined; }
  }
  return messages;
}

async function desiredState(staging: string): Promise<unknown> {
  return readJson(resolve(staging, "config", "desired-state.json"));
}

// The artifacts: the same kind object prepare derives through, so the plan carries the
// resolve's LocalArtifact for both spellings (--from/--to and the two positionals).
const ARTIFACT = kinds.localFile("a set artifact path");

export const SET_DIFF_ARGUMENTS = [
  {
    name: "from",
    kind: "option",
    summary: "original artifact",
    description: "With diff: original artifact",
    valueName: "artifact",
    value: ARTIFACT,
  },
  {
    name: "to",
    kind: "option",
    summary: "replacement artifact",
    description: "With diff: replacement artifact",
    valueName: "artifact",
    value: ARTIFACT,
  },
  { name: "json", summary: "Emit JSON", kind: "flag", description: "Emit JSON" },
  { name: "artifacts", kind: "variadic", count: 2, description: "Two positional artifacts", value: ARTIFACT },
] as const satisfies readonly ArgumentSpec[];

export interface SetDiffPlan { readonly from: LocalArtifact; readonly to: LocalArtifact; readonly json: boolean }

/** The oneOf rule guarantees one whole spelling; the pipeline resolved BOTH spellings' bound
 *  arguments through the kind (S2.5), so prepare only picks the resolved pair — a missing
 *  artifact is refused by the kind's resolve, before any target contact (design §5.2). */
export async function diffPrepare(call: PrepareCall<Values<typeof SET_DIFF_ARGUMENTS>>): Promise<SetDiffPlan> {
  const { values: v } = call;
  const from = v.from ?? v.artifacts[0];
  const to = v.to ?? v.artifacts[1];
  if (from === undefined || to === undefined) call.refuse("from", "needs a value");
  return { from, to, json: v.json };
}

function humanChange(change: SetDiffChange): string {
  const target = `${change.scope}${change.field === undefined ? "" : `.${change.field}`}`;
  const symbol = change.action === "added" ? "+" : change.action === "removed" ? "-" : "~";
  const compact = (value: unknown): string => {
    if (value === undefined) return "(absent)";
    if (Array.isArray(value)) return `${value.length} item(s)`;
    if (value !== null && typeof value === "object") return "(object; see --json)";
    const text = JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  };
  const values = change.kind === "prompt" || change.kind === "content" || change.kind === "recipe"
    ? "" : `: ${compact(change.from)} -> ${compact(change.to)}`;
  return `${symbol} ${change.kind} ${target}${values}`;
}

/** `clawwright set diff A.tar.gz B.tar.gz`; both artifacts are fully verified before comparison.
 *  Read-only, so the verification gate's semantic findings are ignored here — a diff between a
 *  broken and a good build is exactly what a reader may want to ask (R32-05); the integrity
 *  checks still refuse a corrupt archive. */
export async function runSetDiff(_ctx: Context, parsed: SetDiffPlan): Promise<void> {
  await withArtifactInspected(parsed.from, async (fromStaging, fromVerified) => {
    await withArtifactInspected(parsed.to, async (toStaging, toVerified) => {
      const result = diffManifests(
        { ...fromVerified, staging: fromStaging },
        { ...toVerified, staging: toStaging },
        {
          fromDesiredState: await desiredState(fromStaging),
          toDesiredState: await desiredState(toStaging),
          fromCronMessages: await cronMessages(fromStaging, fromVerified.manifest),
          toCronMessages: await cronMessages(toStaging, toVerified.manifest),
        },
      );
      if (parsed.json || isCaptured()) {
        emit(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      log(`set diff ${result.from.name} (${result.from.id}) -> ${result.to.name} (${result.to.id})`);
      if (result.noChanges) { info("no semantic changes"); return; }
      info(`${result.changes.length} change(s)`);
      for (const change of result.changes) {
        info(humanChange(change));
        if (change.advisory !== undefined) info(`  ${change.advisory}`);
      }
    });
  });
}
