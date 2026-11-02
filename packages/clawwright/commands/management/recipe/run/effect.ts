// The `recipe run` per-call effect resolver: reads the recipe manifest directly (plain
// readFile + parseRecipeActions — no hook code is imported or executed here) and answers
// the declared action's effect. Bounded and target-free, so the confirm stage can consult
// it without contacting anything.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EffectOf } from "#src/core/command/effect.ts";
import { recipesDirectory } from "#src/service/recipe.ts";
import { parseRecipeActions } from "#src/set/ownership/recipe-actions.ts";

/** `--dry-run` reads; a declared action resolves to its manifest effect (change and destroy
 *  both owe an MCP confirmation); ANY failure — unreadable manifest, no actions, unknown
 *  action — returns undefined and keeps the static destroy (fail closed). */
export const resolveRecipeActionEffectOf: EffectOf = async (values) => {
  if (values["dry-run"] === true) return { effect: "read" };
  const name = values.name;
  const action = values["recipe-action"];
  if (typeof name !== "string" || typeof action !== "string") return undefined;
  try {
    const manifest = JSON.parse(await readFile(resolve(recipesDirectory(), name, "recipe.json"), "utf8")) as { actions?: unknown };
    const declaration = parseRecipeActions(name, manifest.actions)?.get(action);
    if (declaration === undefined) return undefined;
    return declaration.effect === "read" ? { effect: "read" } : { effect: declaration.effect, confirm: true };
  } catch {
    return undefined;
  }
};
