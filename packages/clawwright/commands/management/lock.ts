// `clawwright lock` — pin what this instance is made of, so the same composition can be
// brought up again and the difference noticed when it is not.
//
// config/desired-state.json reproduces the *settings*, not which framework wrote them,
// which image ran (a tag moves, a digest doesn't), or which recipe content version the
// agent answered from. Two instances can satisfy the same declaration and not be the same
// instance.
//
// Meant to be committed, so it holds no secret values — only variable names.
//
// Boundary: this pins the composition, not the behaviour. The same lock brought up twice
// is the same code/image/wiki, and the model can still answer differently.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { log, info, dieWithExitCode } from "#src/core/io/log.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { frameworkPackage } from "#src/core/env.ts";
import { deploymentDir, deploymentName, desiredStateFile, recipesDir } from "#src/runtime/deployment.ts";
import { requirements } from "#src/service/secrets.ts";
import { recipeNames } from "#src/service/recipe.ts";
import { checksumOf, checksumOfFileMap, recipeFileChecksums, agentBundleChecksums } from "#src/service/checksums.ts";
import { openclawCliBatch } from "#src/service/openclaw-cli.ts";
import { nextActions, nextAdvice, problem } from "#src/service/inspection.ts";
import type { Problem } from "#src/service/inspection.ts";
import type { Context } from "#src/core/context.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import { sameContent } from "#src/runtime/docker/image-ref.ts";
import {
  PLUGINS_LIST_ARGS,
  SKILLS_LIST_ARGS,
  parsePluginsList,
  parseSkillsList,
  pluginsForLock,
  skillsForLock,
  compareExtensions,
} from "./extensions.ts";
import type { LockPlugin, LockSkill } from "./extensions.ts";
import { commandBody, runOnContext } from "#src/core/command/index.ts";
import type { ArgumentSpec } from "#src/core/command/index.ts";

export const LOCK_VERSION = 1;

/** Fixed phrases of the report, exported so the checks assert the same text the product
 *  prints instead of restating it. */
export const AGENT_BUNDLE_DRIFT = "the agent bundle differs from the lock";
export const PREDATES_AGENT_BUNDLE = "the lock predates agent-bundle pinning";
export const PREDATES_PLUGIN_PINNING = "the lock predates plugin pinning";
export const PREDATES_SKILL_PINNING = "the lock predates skill pinning";
export const LOCK_NOT_WRITTEN = "lock not written";
export const COULD_NOT_COMPARE = "could not compare";
export const REASON_NOT_RUNNING = "instance is not running";
export const REASON_NEVER_BOOTSTRAPPED = "instance never bootstrapped";
export const DIFFERENCES_PHRASE = "difference(s) from the lock";
export const UNREAD_PHRASE = "inventory read(s) could not be compared";
function versionMismatchDetail(lockVersion: number): string {
  return `the lock file is version ${lockVersion}, this framework writes version ${LOCK_VERSION}`;
}

export const LOCK_ARGUMENTS = [
  { name: "check", description: "Compare instead of writing", kind: "flag", effect: "read" },
  { name: "json", description: "Lock or differences as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

/** Printed once the lock is written. Its own constant so it stays consistent with
 *  scaffold.ts's git-init note: the deployment directory is meant to become its own git
 *  repository (distinct from the framework's, since `apps/` is gitignored at monorepo root). */
export const COMMIT_ADVICE =
  "commit it in this deployment's own git repository (not the framework's, if the two differ) " +
  "— that is what makes the deployment reproducible rather than merely configured";

export interface DeploymentLock {
  readonly version: number;
  readonly deployment: string;
  readonly generatedAt: string;
  readonly framework?: string;
  readonly image: { readonly reference: string; readonly digest?: string };
  /** Checksum of config/desired-state.json as a whole: the settings are compared path by
   *  path elsewhere, so what the lock adds is "was this the same declaration at all". */
  readonly desiredState?: string;
  /** Per recipe: one checksum for its whole served content, plus individual files so a
   *  difference can be pointed at; separately the agent bundle, since a prompt edit changes
   *  behavior without touching served content. */
  readonly recipes: Record<
    string,
    {
      readonly checksum: string;
      readonly files: Record<string, string>;
      readonly agentChecksum?: string;
      readonly agentFiles?: Record<string, string>;
    }
  >;
  /** Names only. A lock file that carried values would be a credential store that looks
   *  like a manifest, and it is meant to be committed. */
  readonly secrets: readonly string[];
  /** OpenClaw plugins, from `plugins list --json`; bundled ones excluded (image digest
   *  already covers them). Optional so a pre-pinning lock reads as "not yet covered". */
  readonly plugins?: readonly LockPlugin[];
  /** OpenClaw skills, same bundled exclusion and optionality; no version (CLI doesn't report one). */
  readonly skills?: readonly LockSkill[];
}

export function lockFile(): string {
  return resolve(deploymentDir(), "config", "deployment.lock.json");
}

export async function frameworkVersion(): Promise<string | undefined> {
  return (await frameworkPackage())?.version;
}

/** What the lock would say if written now. Exported so `plan` and the checks can ask for it
 *  without writing anything.
 *
 *  `includeExtensions` defaults to false: `plan`/`apply` only need declarationChecksum(),
 *  which never reads plugins/skills (observed instance facts, not part of the declaration),
 *  so asking for that inventory would spend a container nobody looks at. `lock` always
 *  asks for it; `inspect`/`doctor` reuse observeLive's own batched read instead. */
export async function currentComposition(
  ctx: Context,
  options?: { readonly includeExtensions?: boolean; readonly problems?: Problem[] },
): Promise<DeploymentLock> {
  const recipes: DeploymentLock["recipes"] = {};
  for (const name of await recipeNames()) {
    const dir = resolve(recipesDir(), name);
    const files = await recipeFileChecksums(dir);
    const agentFiles = await agentBundleChecksums(dir);
    recipes[name] = {
      checksum: checksumOfFileMap(files),
      files,
      ...(Object.keys(agentFiles).length === 0 ? {} : { agentChecksum: checksumOfFileMap(agentFiles), agentFiles }),
    };
  }

  let desiredState: string | undefined;
  try {
    desiredState = checksumOf(await readFile(desiredStateFile(), "utf8"));
  } catch {
    desiredState = undefined;
  }

  let plugins: LockPlugin[] | undefined;
  let skills: LockSkill[] | undefined;
  if (options?.includeExtensions === true) {
    // Failed reads stay absent, never a confirmed empty inventory.
    const problems = options.problems ?? [];
    const [pluginsResult, skillsResult] = await openclawCliBatch(ctx, [[...PLUGINS_LIST_ARGS], [...SKILLS_LIST_ARGS]]);
    const pluginEntries = parsePluginsList(pluginsResult, problems);
    const skillEntries = parseSkillsList(skillsResult, problems);
    plugins = pluginEntries === undefined ? undefined : pluginsForLock(pluginEntries);
    skills = skillEntries === undefined ? undefined : skillsForLock(skillEntries);
    if (options.problems === undefined && (plugins === undefined || skills === undefined)) {
      throw new Error(problems.map((entry) => entry.detail).join("; "));
    }
  }

  return {
    version: LOCK_VERSION,
    deployment: deploymentName(),
    generatedAt: new Date().toISOString(),
    framework: await frameworkVersion(),
    image: { reference: ctx.settings.image, digest: await ctx.runtime.imageReference() },
    desiredState,
    recipes,
    secrets: (await requirements(ctx)).map((entry) => entry.name).sort(),
    ...(plugins === undefined ? {} : { plugins }),
    ...(skills === undefined ? {} : { skills }),
  };
}

/** One checksum for everything a plan is computed from — declaration and recipe content
 *  only. Not the whole lock: `generatedAt` and the image digest change without invalidating
 *  a plan; only an edited declaration does. */
export function declarationChecksum(composition: DeploymentLock): string {
  return checksumOf(
    JSON.stringify({
      desiredState: composition.desiredState ?? null,
      recipes: Object.fromEntries(
        Object.keys(composition.recipes)
          .sort()
          // Both halves: an edited agent prompt is as stale as an edited wiki page.
          .map((name) => [name, `${composition.recipes[name].checksum}:${composition.recipes[name].agentChecksum ?? ""}`]),
      ),
    }),
  );
}

export async function readLock(): Promise<DeploymentLock | undefined> {
  try {
    return JSON.parse(await readFile(lockFile(), "utf8")) as DeploymentLock;
  } catch {
    return undefined;
  }
}

/** Everything the lock pins that no longer holds.
 *
 *  Warnings, not blocking problems: an instance that drifted from its lock is still
 *  working, and the reader decides whether the difference was intended.
 *
 *  `generatedAt` is not compared: it says when the lock was taken, not what it pins. */
export function compareLock(lock: DeploymentLock | undefined, current: DeploymentLock): Problem[] {
  if (lock === undefined) {
    return [problem("LOCK_MISSING", `no ${"config/deployment.lock.json"} — this instance's composition is not pinned`)];
  }
  if (lock.version !== LOCK_VERSION) {
    return [problem("LOCK_DRIFT", versionMismatchDetail(lock.version))];
  }

  const problems: Problem[] = [];

  if (lock.framework !== undefined && current.framework !== undefined && lock.framework !== current.framework) {
    problems.push(problem("LOCK_DRIFT", `framework is ${current.framework}, locked at ${lock.framework}`));
  }
  // The digest, not the tag: a tag stays the same string even after it moves to a different image.
  // Compared as content (image-ref.ts), like set requirement matching: the same digest under a
  // mirror registry's spelling is the same image, not drift.
  if (lock.image.digest !== undefined && current.image.digest !== undefined && !sameContent(lock.image.digest, current.image.digest)) {
    problems.push(problem("LOCK_DRIFT", `image digest is ${current.image.digest}, locked at ${lock.image.digest}`));
  }
  if (lock.desiredState !== undefined && current.desiredState !== undefined && lock.desiredState !== current.desiredState) {
    problems.push(problem("LOCK_DRIFT", "config/desired-state.json has changed since the lock was written"));
  }

  for (const [name, locked] of Object.entries(lock.recipes)) {
    const now = current.recipes[name];
    if (now === undefined) {
      problems.push(problem("LOCK_DRIFT", `recipe "${name}" is locked but no longer present`));
      continue;
    }
    // Named rather than counted: "the recipe changed" leaves the reader to find it themselves.
    if (now.checksum !== locked.checksum) {
      const changed = Object.keys({ ...locked.files, ...now.files })
        .filter((rel) => locked.files[rel] !== now.files[rel])
        .sort();
      problems.push(
        problem(
          "LOCK_DRIFT",
          `recipe "${name}" differs from the lock in ${changed.length} file(s): ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ", …" : ""}`,
        ),
      );
    }

    // A lock written before the bundle was recorded pins less than this framework can, and
    // an absent value would otherwise silently read as agreement — named as its own finding.
    if (locked.agentChecksum === undefined && now.agentChecksum !== undefined) {
      problems.push(
        problem(
          "LOCK_DRIFT",
          `recipe "${name}": ${PREDATES_AGENT_BUNDLE} and does not record it — re-pin to cover the agent's prompts`,
        ),
      );
    }

    // Separately: a prompt edit changes agent behavior without touching served content.
    if (locked.agentChecksum !== undefined && now.agentChecksum !== locked.agentChecksum) {
      const changed = Object.keys({ ...locked.agentFiles, ...now.agentFiles })
        .filter((rel) => (locked.agentFiles ?? {})[rel] !== (now.agentFiles ?? {})[rel])
        .sort();
      problems.push(
        problem(
          "LOCK_DRIFT",
          `recipe "${name}": ${AGENT_BUNDLE_DRIFT} in ${changed.length} file(s): ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ", …" : ""}`,
        ),
      );
    }
  }

  for (const name of Object.keys(current.recipes)) {
    if (lock.recipes[name] === undefined) {
      problems.push(problem("LOCK_DRIFT", `recipe "${name}" is present but not in the lock`));
    }
  }

  const newSecrets = current.secrets.filter((name) => !lock.secrets.includes(name));
  if (newSecrets.length > 0) {
    problems.push(problem("LOCK_DRIFT", `the instance now requires ${newSecrets.join(", ")}, which the lock does not list`));
  }

  // Plugins/skills, only when the caller actually fetched them: a bare currentComposition
  // (what plan/apply ask for) leaves these undefined, and absent must not read as "none".
  if (current.plugins !== undefined && lock.plugins === undefined && current.plugins.length > 0) {
    problems.push(problem("LOCK_DRIFT", `${PREDATES_PLUGIN_PINNING} and does not record it — re-pin to cover installed plugins`));
  }
  if (current.skills !== undefined && lock.skills === undefined && current.skills.length > 0) {
    problems.push(problem("LOCK_DRIFT", `${PREDATES_SKILL_PINNING} and does not record it — re-pin to cover installed skills`));
  }
  if (current.plugins !== undefined) {
    problems.push(...compareExtensions(lock.plugins, current.plugins, undefined, []));
  }
  if (current.skills !== undefined) {
    problems.push(...compareExtensions(undefined, [], lock.skills, current.skills));
  }

  return problems;
}

/** One summary for text, --json and MCP: an unread inventory is not a difference — nothing
 *  could be compared — so the two are counted apart; a missing lock is neither. */
function summarizeCheck(problems: readonly Problem[], inventoryProblems: readonly Problem[]) {
  const unread = problems.filter((entry) => inventoryProblems.includes(entry));
  const others = problems.filter((entry) => !inventoryProblems.includes(entry));
  const missing = others.some((entry) => entry.code === "LOCK_MISSING");
  const differences = others.filter((entry) => entry.code !== "LOCK_MISSING");
  const reason = unread.length > 0 && unread.every((entry) => entry.code === "GATEWAY_DOWN")
    ? REASON_NOT_RUNNING
    : unread.length > 0 && unread.every((entry) => entry.code === "NOT_BOOTSTRAPPED")
      ? REASON_NEVER_BOOTSTRAPPED
      : "inventory not read";
  const parts = [
    ...(missing ? ["no lock file to compare against"] : []),
    ...(differences.length > 0 ? [`${differences.length} ${DIFFERENCES_PHRASE}`] : []),
    ...(unread.length > 0 ? [`${unread.length} ${UNREAD_PHRASE} (${reason})`] : []),
  ];
  return { unread, differences, reason, summary: parts.length > 0 ? parts.join("; ") : undefined };
}

/** The command body; lock(ctx, args) stays for callers that already hold a Context. */
export const LOCK = commandBody({
  effect: "change",
  arguments: LOCK_ARGUMENTS,
  async run(ctx, values) {
    await runLock(ctx, values.check === true, values.json === true);
  },
});

export async function lock(ctx: Context, args: string[]): Promise<void> {
  await runOnContext(LOCK, ctx, args);
}

async function runLock(ctx: Context, checkOnly: boolean, jsonOnly: boolean): Promise<void> {
  // The write path claims the lock's home and reads live inventory — both only exist after
  // bootstrap; --check reports the same fact as an unread inventory instead (summarizeCheck).
  if (!checkOnly) await requireBootstrapped(ctx);
  const inventoryProblems: Problem[] = [];
  const current = await currentComposition(ctx, { includeExtensions: true, problems: inventoryProblems });

  if (checkOnly) {
    const problems = [...inventoryProblems, ...compareLock(await readLock(), current)];
    const report = summarizeCheck(problems, inventoryProblems);
    if (jsonOnly || isCaptured()) {
      emit(`${JSON.stringify({ deployment: current.deployment, problems, nextActions: nextActions(problems), next: nextAdvice(problems) }, null, 2)}\n`);
      if (report.summary !== undefined) dieWithExitCode(report.summary, 1);
      return;
    }
    if (report.summary === undefined) {
      log("the instance matches config/deployment.lock.json");
      return;
    }
    log("checking the instance against config/deployment.lock.json");
    if (report.unread.length > 0) {
      info(`${COULD_NOT_COMPARE} — ${report.reason}:`);
      for (const entry of report.unread) info(`  ${entry.code}  ${entry.detail}`);
    }
    if (report.differences.length > 0) {
      if (report.unread.length > 0) info("differences:");
      for (const entry of report.differences) info(`  ${entry.code}  ${entry.detail}`);
    }
    dieWithExitCode(report.summary, 1);
  }
  if (inventoryProblems.length > 0) {
    throw new Error(`${LOCK_NOT_WRITTEN}: ${inventoryProblems.map((entry) => entry.detail).join("; ")}`);
  }


  await writeFile(lockFile(), `${JSON.stringify(current, null, 2)}\n`, "utf8");

  if (jsonOnly || isCaptured()) {
    emit(`${JSON.stringify({ deployment: current.deployment, changed: true, lock: current }, null, 2)}\n`);
    return;
  }

  log(`wrote ${lockFile()}`);
  info(`framework  ${current.framework ?? "(unknown)"}`);
  info(`image      ${current.image.digest ?? current.image.reference}`);
  info(`recipes    ${Object.keys(current.recipes).length === 0 ? "(none)" : Object.keys(current.recipes).join(", ")}`);
  info(`secrets    ${current.secrets.length} name(s), no values`);
  info(`plugins    ${(current.plugins ?? []).length} third-party (bundled ones are covered by the image digest)`);
  info(`skills     ${(current.skills ?? []).length} third-party (bundled ones are covered by the image digest)`);
  info(COMMIT_ADVICE);
}
