import type { Context } from "#src/core/context.ts";
import type { RecipeRef } from "#src/core/values/plan.ts";
import { info } from "#src/core/io/log.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { loadRecipe, recipeProjectName, recipeStack } from "#src/service/recipe.ts";
import type { RecipeActionDeclaration } from "#src/set/ownership/recipe-actions.ts";
import type { StackInspection } from "#src/runtime/runtime.ts";

/** JSON projection of one action declaration; list order is sorted by name. */
function actionJson(name: string, action: RecipeActionDeclaration): unknown {
  return {
    name,
    effect: action.effect,
    description: action.description ?? null,
    arguments: action.arguments.map((argument) => ({
      name: argument.name,
      kind: argument.kind,
      optional: argument.optional === true,
      choices: argument.choices ?? null,
      description: argument.description ?? null,
    })),
  };
}

/** Runtime evidence only: never loads app hooks, takes a lock, or reads recipe env files. */
export async function runInspectAction(
  ctx: Context,
  name: RecipeRef,
  requestedTail: number | undefined,
  jsonOnly: boolean,
): Promise<void> {
  const recipe = await loadRecipe(name);
  const stack = recipeStack(ctx, recipe.name, recipe.definitionPath);
  const tail = Math.max(1, Math.min(200, Math.floor(requestedTail ?? 100)));
  // An older runtime cannot prove absence. Do not fall back to isRunning/status/logs.
  const inspection: StackInspection = stack.inspect === undefined
    ? {
      containers: [],
      namespaces: [{ project: recipeProjectName(recipe.name), status: "unknown" }],
      unknown: [{ project: recipeProjectName(recipe.name), cause: "transport", detail: "runtime does not support stack inspection" }],
    }
    : await stack.inspect({ logs: true, tail });
  if (jsonOnly || isCaptured()) {
    // Additive `owns`: this recipe's own manifest only — the joined catalog is inspect's job.
    emit(`${JSON.stringify({ recipe: recipe.name, tail, ...(recipe.owns === undefined ? {} : { owns: recipe.owns }), ...(recipe.actions === undefined ? {} : { actions: [...recipe.actions].sort(([a], [b]) => a.localeCompare(b)).map(([name, action]) => actionJson(name, action)) }), ...inspection }, null, 2)}\n`);
    return;
  }
  // Human output intentionally excludes raw logs, start errors, mounts and unknown detail.
  // Those diagnostics belong to the runtime's sanitized structured evidence, not a dump.
  const safe = (value: string): string => JSON.stringify(value);
  info(`recipe ${safe(recipe.name)}`);
  for (const namespace of inspection.namespaces) {
    info(`project ${safe(namespace.project)}: ${safe(namespace.status)}`);
  }
  for (const container of inspection.containers) {
    info(`${safe(container.id)} service=${safe(container.service ?? "unknown")} project=${safe(container.project)} provenance=${safe(container.provenance)} state=${safe(container.state ?? "unknown")} health=${safe(container.health ?? "unknown")} exit=${container.exitCode ?? "unknown"}`);
  }
  for (const observation of inspection.unknown) {
    info(`unknown observation: project=${safe(observation.project)} cause=${safe(observation.cause)}`);
  }
  if (recipe.actions !== undefined) {
    for (const [name, action] of [...recipe.actions].sort(([a], [b]) => a.localeCompare(b))) {
      info(`action ${safe(name)} (${action.effect})${action.description === undefined ? "" : `: ${action.description}`}`);
    }
  }
}
