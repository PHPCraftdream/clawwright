// `recipe run`'s run phase: loads the declared action's module through the same
// checksum-versioned loader every other hook uses, calls it, and prints the result in
// runRecipeHook's style. A change/destroy action runs ENTIRELY inside the instance lock —
// the module import happens under the lock, so a hung or hostile top-level import cannot
// slip past a lock another operation holds.

import type { Context } from "#src/core/context.ts";
import { die, log, maskSecrets } from "#src/core/io/log.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { guardedWith } from "#src/runtime/lock/instance-lock.ts";
import { loadRecipe } from "#src/service/recipe.ts";
import { resolveRecipeActionFile } from "#src/set/ownership/recipe-actions.ts";
import { importHookModule } from "#src/commands/management/recipe/hook-runtime.ts";
import type { RecipeRunPlan } from "./arguments.ts";

/** The largest action result this command will print, in UTF-8 bytes: a hook returning a
 *  dump of its whole state is a mistake, not a document. */
const RECIPE_ACTION_RESULT_BYTES = 64 * 1024;

/** Deep-masks a JSON-ready value — strings and keys — with the shared maskSecrets, so a
 *  registered secret cannot ride an action result out. Local walk, same shape as
 *  execute.ts's maskedJson; nothing new is exported from core. */
function masked(value: unknown): unknown {
  if (typeof value === "string") return maskSecrets(value);
  if (Array.isArray(value)) return value.map(masked);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[maskSecrets(key)] = masked(entry);
    return out;
  }
  return value;
}

export async function runRecipeActionCommand(ctx: Context, plan: RecipeRunPlan): Promise<void> {
  const invoke = async (): Promise<void> => {
    const recipe = await loadRecipe(plan.name);
    const file = resolveRecipeActionFile(recipe.directory, plan.declaration.file);
    const loaded = await importHookModule(file);
    const hook = loaded.run ?? loaded.default;
    if (typeof hook !== "function") {
      throw new Error(`recipe "${recipe.name}" action "${plan.action}" (run/${plan.declaration.file}) must export run(ctx, recipe, input)`);
    }
    // Trust boundary: --dry-run is passed to the hook as input.dryRun; the hook must return
    // its plan without writes — the framework cannot enforce it.
    let result: unknown;
    try {
      // Recipe-kit helpers (appConfigPatch, reconcileApply) read ctx.dryRun: a dry-run action
      // must hand them a context that says so, not only the input flag.
      const hookCtx = plan.dryRun ? Object.create(ctx, { dryRun: { value: true, enumerable: true } }) : ctx;
      result = await hook(hookCtx, recipe, { action: plan.action, args: plan.args, dryRun: plan.dryRun });
    } catch (error) {
      die(maskSecrets(error instanceof Error ? error.message : String(error)));
    }
    // Serialize the RAW result first: a throwing toJSON or a cyclic structure becomes a
    // sanitized refusal, and a secret returned through toJSON is a plain string in the
    // parsed text — the masked() walk below then catches it.
    const unserializable = (): never =>
      die(maskSecrets(`recipe "${recipe.name}" action "${plan.action}" returned a result that cannot be serialized`));
    const serialized = (() => {
      try {
        return JSON.stringify(result === undefined ? { ok: true } : result);
      } catch {
        return unserializable();
      }
    })();
    // JSON.stringify answers undefined for a function, a symbol or a toJSON that returns undefined.
    if (serialized === undefined) unserializable();
    const payload = masked(JSON.parse(serialized));
    const json = JSON.stringify(payload);
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > RECIPE_ACTION_RESULT_BYTES) {
      throw new Error(`recipe "${recipe.name}" action "${plan.action}" returned ${bytes} bytes — over the ${RECIPE_ACTION_RESULT_BYTES}-byte result bound`);
    }
    if (plan.json || isCaptured()) emit(`${json}\n`);
    else log(`${plan.name} run ${plan.action}: ${json}`);
  };
  if (plan.effect === "read") return invoke();
  await guardedWith(ctx, `recipe run ${plan.name} ${plan.action}`, plan.takeover, invoke);
}
