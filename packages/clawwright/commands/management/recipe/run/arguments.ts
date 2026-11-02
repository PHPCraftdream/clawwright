// `recipe run`'s prepare stage: turns the parsed call into a typed plan. All argument
// refusals go through call.refuse, so they are proper ArgumentErrors naming the argument;
// the hook module is never imported here.

import { resolve } from "node:path";
import * as kinds from "#src/core/values/kinds.ts";
import { ValueError } from "#src/core/values/value.ts";
import type { LocalScope, PrepareCall } from "#src/core/command/spec.ts";
import type { RecipeRef } from "#src/core/values/plan.ts";
import { takeoverOf } from "#src/commands/interface/groups/shared-arguments.ts";
import type { LockTakeover } from "#src/runtime/lock/instance-lock.ts";
import { recipesDirectory } from "#src/service/recipe.ts";
import { parseRecipeActions, type RecipeActionDeclaration } from "#src/set/ownership/recipe-actions.ts";

/** What `recipe run` executes: the manifest declaration, the parsed arguments and the
 *  effect the invocation will honor (read under --dry-run, the declared effect otherwise). */
export interface RecipeRunPlan {
  readonly name: RecipeRef;
  readonly action: string;
  readonly declaration: RecipeActionDeclaration;
  readonly args: Record<string, string | number | boolean>;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly effect: "read" | "change" | "destroy";
  readonly takeover: LockTakeover;
}

/** A declared argument's value grammar, reused from kinds.ts so the refusal clause stays
 *  the parser's own (a ValueError is mapped to call.refuse below, naming "arg"). The return
 *  type is the union of the value kinds; each branch below inspects the declared kind it
 *  passed in. */
function grammarOf(declaration: RecipeActionDeclaration["arguments"][number]) {
  switch (declaration.kind) {
    case "text": return kinds.text(`a value for ${declaration.name}`, { leadingDash: "allow" });
    case "integer": return kinds.grammar({
      expected: `an integer for ${declaration.name}`,
      example: "1",
      invalid: ["abc", "1.5"],
      // Strict base-10 integer: no decimals, no exponent, no empty string, and the
      // parsed value must be a safe integer (1e20's digits are a valid integer literal).
      matches: (raw) => /^[+-]?\d+$/.test(raw) && Number.isSafeInteger(Number(raw)),
    });
    case "choice": return kinds.choice(declaration.choices ?? []);
    case "flag": return kinds.choice(["true", "false"]);
  }
}

/** The values the declaration gives this action's prepare; the binder has already resolved
 *  <name> through the recipeRef kind, so no cast is needed here. */
type RunValues = {
  readonly name: RecipeRef;
  readonly "recipe-action": string;
  readonly "dry-run"?: boolean;
  readonly arg?: readonly string[];
  readonly [key: string]: unknown;
};

export async function prepareRecipeRun(call: PrepareCall<RunValues>, local: LocalScope): Promise<RecipeRunPlan> {
  const name = call.values.name;
  const action = call.values["recipe-action"];
  const dryRun = call.values["dry-run"] === true;
  const json = call.values.json === true;
  // The recipe's existence is the recipeRef kind's own resolve (S2.5); a manifest that
  // cannot be read now is broken, and its actions list is what this stage judges.
  const raw = await local.readText(resolve(recipesDirectory(), name, "recipe.json"));
  const manifest = raw === undefined ? undefined : JSON.parse(raw) as { actions?: unknown };
  const actions = manifest === undefined ? undefined : parseRecipeActions(name, manifest.actions);
  if (actions === undefined) call.refuse("recipe-action", `recipe "${name}" declares no actions`);
  const declaration = actions!.get(action);
  if (declaration === undefined) {
    const declared = [...actions!.keys()];
    call.refuse("recipe-action", `recipe "${name}" declares no action "${action}"${declared.length === 0 ? "" : ` — declared: ${declared.join(", ")}`}`);
  }

  const args: Record<string, string | number | boolean> = {};
  const seen = new Set<string>();
  for (const token of call.values.arg ?? []) {
    const separator = token.indexOf("=");
    if (separator <= 0) call.refuse("arg", `argument "${token}" must be key=value`);
    const key = token.slice(0, separator);
    const rawValue = token.slice(separator + 1);
    const declared = declaration!.arguments.find((entry) => entry.name === key);
    if (declared === undefined) {
      const names = declaration!.arguments.map((entry) => entry.name);
      call.refuse("arg", `unknown argument "${key}" — declared: ${names.length === 0 ? "none" : names.join(", ")}`);
    }
    if (seen.has(key)) call.refuse("arg", `duplicate argument "${key}"`);
    seen.add(key);
    const kind = grammarOf(declared!);
    let value: string;
    try {
      value = kind.parse(rawValue);
    } catch (error) {
      if (!(error instanceof ValueError)) throw error;
      call.refuse("arg", `${key} ${error.clause}`);
    }
    args[key] = declared!.kind === "flag" ? value === "true" : declared!.kind === "integer" ? Number(value) : value;
  }
  for (const declared of declaration!.arguments) {
    if (!declared.optional && !seen.has(declared.name)) {
      call.refuse("arg", `missing required argument "${declared.name}"`);
    }
  }

  return {
    name,
    action,
    declaration: declaration!,
    args,
    dryRun,
    json,
    effect: dryRun ? "read" : declaration!.effect,
    takeover: takeoverOf(call.values as Parameters<typeof takeoverOf>[0]),
  };
}
