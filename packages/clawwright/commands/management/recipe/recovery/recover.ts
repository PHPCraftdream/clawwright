import { access } from "node:fs/promises";
import type { Context } from "#src/core/context.ts";
import type { RecipeRef } from "#src/core/values/plan.ts";
import { emit } from "#src/core/io/output.ts";
import { loadRecipe, recipeStack } from "#src/service/recipe.ts";
import type { Stack, StackRecoverOptions } from "#src/runtime/runtime.ts";
import { guardedWith, type LockTakeover } from "#src/runtime/lock/instance-lock.ts";
import { importHookModule } from "#src/commands/management/recipe/hook-runtime.ts";

export interface RecoverCommandOptions extends StackRecoverOptions {
  readonly dryRun: boolean;
  readonly reconcileConsumer: boolean;
}

/** A single bounded observation, not a start/poll loop. Dependencies must already be ready. */
async function requireConsumerReady(stack: Stack, services: readonly string[], timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const states = await Promise.race([
      stack.serviceStates(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("consumer readiness probe timed out; afterStart skipped")), timeoutMs);
      }),
    ]);
    if (services.some((service) => !Object.hasOwn(states, service) || !states[service]!.running
      || (states[service]!.health !== undefined && states[service]!.health !== "healthy"))) {
      throw new Error("selected service or declared dependencies are not ready; afterStart skipped");
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function runRecoverAction(
  ctx: Context,
  name: RecipeRef,
  options: RecoverCommandOptions,
  takeover: LockTakeover,
): Promise<void> {
  const recipe = await loadRecipe(name);
  const stack = recipeStack(ctx, recipe.name, recipe.definitionPath);
  if (stack.planRecover === undefined || stack.recover === undefined) {
    throw new Error("runtime does not support selective recipe recovery");
  }
  // No import during preflight: even module evaluation can mutate the consumer.
  if (options.reconcileConsumer) {
    if (recipe.preparePath === undefined) {
      throw new Error("consumer reconciliation requires prepare.ts with a named afterStart export");
    }
    await access(recipe.preparePath);
  }
  const required = [...new Set([options.service, ...(recipe.readiness?.services ?? [])])];
  const plan = await stack.planRecover({ service: options.service, build: options.build, pull: options.pull });
  if (options.dryRun) {
    // Deliberately not the opaque token or container diagnostics (logs/mounts/errors).
    emit(`${JSON.stringify({
      recipe: recipe.name, service: plan.service, dryRun: true,
      build: plan.build, pull: plan.pull, imageIds: plan.imageIds,
      operation: "recreate-selected-service", startsDependencies: false,
      reconcileConsumer: options.reconcileConsumer,
      consumer: options.reconcileConsumer ? {
        hook: "prepare.ts:afterStart", requiredServices: required,
        mayMutateConsumerConfiguration: true, mayMutateGateway: true,
      } : null,
    }, null, 2)}\n`);
    return;
  }
  // The executor decides when to enter this scope. Hook evaluation and invocation are
  // appended INSIDE that same scope, not after recover returns and releases its lock.
  await stack.recover(plan, (action) => guardedWith(ctx, `recipe recover ${name}`, takeover, async () => {
    const result = await action();
    if (options.reconcileConsumer) {
      const budget = Math.max(1, Math.min(120_000, recipe.readiness?.timeoutMs ?? 30_000));
      await requireConsumerReady(stack, required, budget);
      const loaded = await importHookModule(recipe.preparePath!);
      if (typeof loaded.afterStart !== "function") {
        throw new Error("prepare.ts must export named afterStart(ctx, recipe); recovery completed but consumer reconciliation refused");
      }
      await loaded.afterStart(ctx, recipe);
    }
    return result;
  }));
}
