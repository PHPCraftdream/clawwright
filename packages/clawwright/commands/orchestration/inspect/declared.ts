// The declared state `inspect` reads: desired-state.json and the recipes
// directory, both local to this repository — never the target. Split out of observe.ts;
// see helpers.ts (this same directory) for the pure pieces these use, drift.ts for the
// per-facet declared-vs-target comparisons, and live.ts for what the target itself reports.

import { access, lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deploymentName, desiredStateFile, envFile, recipesDir } from "#src/runtime/deployment.ts";
import { listRecipeDirectories } from "#src/service/recipe.ts";
import { loadRecipeAgentBundle } from "#src/commands/management/provision-agent/index.ts";
import type { RecipeAgentBundle } from "#src/commands/management/provision-agent/index.ts";
import { problem } from "#src/service/inspection.ts";
import type { Problem, DeclaredState } from "#src/service/inspection.ts";
import {
  conflictingDeclaredPath, declaredOwnershipConflictDetail, recipePathOwners,
} from "#src/set/ownership/recipe-paths.ts";
import type { RecipePathOwner } from "#src/set/ownership/recipe-paths.ts";
import { readEnvFileText, suspiciousEnvLines } from "#src/core/env.ts";
import { desiredStateShapeError } from "#src/set/ownership/validate.ts";
import type { Context } from "#src/core/context.ts";

/** A recipe's agent bundle, in the fields inspect compares against the instance. Parsed
 *  loosely on purpose: this is reading someone else's declaration to report on it, not
 *  validating it — provision-agent owns the validation and says so properly. */
export interface RecipeExpectation {
  readonly recipe: string;
  readonly bundle: RecipeAgentBundle;
}

export async function recipeExpectations(): Promise<RecipeExpectation[]> {
  const found: RecipeExpectation[] = [];
  const entries = (await listRecipeDirectories(recipesDir()))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const recipe of entries.sort()) {
    const agentDir = resolve(recipesDir(), recipe, "agent");
    let stat;
    try {
      stat = await lstat(agentDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // No agent directory: a recipe can be a plain service. Not a finding.
        continue;
      }
      throw error;
    }
    if (!stat.isDirectory()) throw new Error(`${agentDir} is not a directory`);
    // Once the bundle exists, every loader failure must block reconciliation.
    found.push({ recipe, bundle: await loadRecipeAgentBundle(recipe) });
  }
  return found;
}

export async function declaredState(ctx: Context, problems: Problem[]): Promise<DeclaredState> {
  let config: { path: string; value: unknown }[] = [];
  // The recipe ownership catalog: built at most once, undefined when the recipes themselves
  // refuse to load (reported as its own problem above).
  let owners: readonly RecipePathOwner[] | undefined;
  let raw: string | undefined;
  try {
    raw = await readFile(desiredStateFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Not "no file at all" (a directory, permissions error, …) must not be silently
      // treated as an empty declaration — that would report healthy: true unread.
      problems.push(problem("CONFIG_DRIFT", `${desiredStateFile()} could not be read: ${(error as Error).message}`));
    }
    // ENOENT: no desired state declares nothing — an empty declaration, not a failure.
  }
  if (raw !== undefined) {
    let parsedOk = false;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const shapeError = desiredStateShapeError(parsed);
      if (shapeError !== undefined) throw new Error(shapeError);
      config = (parsed as { path: string; value: unknown }[]).map((entry) => ({ path: entry.path, value: entry.value }));
      parsedOk = true;
    } catch (error) {
      // Exists but unparseable or structurally invalid must be reported, not treated like "no file". Same code
      // observeConfig() (drift.ts) uses for the equivalent LIVE-config failure.
      problems.push(problem("CONFIG_DRIFT", `${desiredStateFile()} exists but is not a valid desired-state declaration: ${(error as Error).message}`));
    }
    if (parsedOk) {
      // Declared paths a recipe owns are a declaration bug, reported like the other
      // recipe-declaration findings; an unreadable catalog (broken recipe.json) degrades
      // the same way instead of taking the whole inspection down.
      try {
        owners = await recipePathOwners();
        for (const entry of config) {
          const owner = conflictingDeclaredPath(owners, entry.path);
          if (owner !== undefined) {
            problems.push(problem("SET_RECIPE_INVALID", declaredOwnershipConflictDetail(entry.path, owner)));
          }
        }
      } catch (error) {
        owners = undefined;
        problems.push(problem("SET_RECIPE_INVALID", `recipe config ownership could not be read: ${(error as Error).message}`));
      }
    }
  }

  // Re-read: ctx.settings dropped the raw text. ENOENT is a race, not a normal case.
  try {
    for (const finding of suspiciousEnvLines(await readEnvFileText())) {
      problems.push(problem("ENV_LINE_INVALID", `${envFile()}: ${finding}`));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return {
    deployment: deploymentName(),
    config,
    // Structured only: human output stays short and omits the ownership listing.
    ...(owners === undefined ? {} : { ownedConfigPaths: owners }),
    image: ctx.settings.image,
    recipes: (await recipeExpectations()).map((entry) => entry.recipe),
  };
}

/** The declaration's own existence — only a finding while an instance is running to be
 *  re-declared, so the caller gates it below the not-running early return. */
export async function observeDeclarationFile(problems: Problem[]): Promise<void> {
  const absent = await access(desiredStateFile()).then(
    () => false,
    (error: NodeJS.ErrnoException) => {
      // Unreadable otherwise: declaredState()'s own read already reports it.
      if (error.code === "ENOENT") return true;
      return false;
    },
  );
  if (absent) {
    problems.push(
      problem("DECLARATION_MISSING", `${desiredStateFile()} does not exist — a running instance nobody can re-declare from this repository`),
    );
  }
}
