// `recipe retire-legacy`: preview by default (read effect); `--apply` is a destroy-class
// effect confirmed through the MCP pipeline, running stop -> verify -> writer isolation ->
// cold backup -> record rollback inputs -> container-only removal under the caller's
// instance lock, with a journal and recorded rollback steps. The legacy stack's data is
// disposable by definition; migrate remains the path that transfers a still-matching
// service set.

import type { Context } from "#src/core/context.ts";
import type { EffectOf } from "#src/core/command/effect.ts";
import type { RecipeRef } from "#src/core/values/plan.ts";
import { maskSecrets } from "#src/core/io/log.ts";
import { emit } from "#src/core/io/output.ts";
import { loadRecipe, recipeStack } from "#src/service/recipe.ts";
import { guardedWith, type LockTakeover } from "#src/runtime/lock/instance-lock.ts";
import { backupRoot } from "./migrate/index.ts";

export interface RetireLegacyCommandOptions {
  helperImage?: string;
  shutdownTimeoutSeconds?: number;
}

/** Preview (no --apply) is a read effect; --apply is the destroy effect owing confirmation. */
export const resolveRetireLegacyEffectOf: EffectOf = async (values) =>
  values.apply === true ? { effect: "destroy", confirm: true } : { effect: "read" };

export async function runRetireLegacyAction(
  ctx: Context,
  name: RecipeRef,
  apply: boolean,
  takeover: LockTakeover,
  options: RetireLegacyCommandOptions = {},
): Promise<void> {
  const recipe = await loadRecipe(name);
  const stack = recipeStack(ctx, recipe.name, recipe.definitionPath);
  if (stack.planRetireLegacy === undefined || stack.retireLegacy === undefined) {
    throw new Error("runtime does not support recipe retire-legacy");
  }
  // Read-only planning precedes the executor's caller-supplied lock scope.
  const plan = await stack.planRetireLegacy({ backupRoot: backupRoot(ctx.settings.dataDir), ...options });
  emit(`${maskSecrets(JSON.stringify({
    recipe: recipe.name, dryRun: !apply, operation: "retire-owned-legacy-stack",
    project: plan.project, legacyProject: plan.legacyProject,
    helperImage: plan.helperImage,
    containers: plan.containers.map((container) => ({
      id: container.id, project: container.project, provenance: container.provenance,
      service: container.service, state: container.state, imageId: container.imageId,
      mounts: container.mounts?.map((mount) => ({
        type: mount.type, source: mount.source, destination: mount.destination,
        writable: mount.writable, name: mount.name ?? null,
      })),
    })),
    storage: plan.storage, retainedImages: plan.retainedImages,
    shutdownTimeoutSeconds: plan.shutdownTimeoutSeconds, operations: plan.operations,
    backupRoot: plan.backupRoot,
    removesContainersOnly: true, removesVolumes: false, removesImages: false,
    touchesRecipeDataDirectory: false, build: false, pull: false, runsHooks: false,
    impacts: plan.impacts,
  }, null, 2))}\n`);
  if (!apply) return;
  let result;
  try { result = await stack.retireLegacy(plan, (action) => guardedWith(ctx, `recipe retire-legacy ${name}`, takeover, action)); }
  catch (error) {
    if (error !== null && typeof error === "object" && "stoppedContainers" in error) {
      const failure = error as { code?: unknown; stoppedContainers?: unknown; restartArgv?: unknown; restartCommand?: unknown };
      emit(`${maskSecrets(JSON.stringify({
        operation: "retire-owned-legacy-stack-failed", backupRoot: plan.backupRoot,
        code: failure.code, stoppedContainers: failure.stoppedContainers, restartArgv: failure.restartArgv,
        restartCommand: failure.restartCommand,
        recoveryNote: "If restore paths are redacted, use the exact command in the private recovery manifest.",
      }, null, 2))}\n`);
    }
    throw error;
  }
  emit(`${maskSecrets(JSON.stringify({
    recipe: recipe.name, operation: "retire-owned-legacy-stack",
    legacyProject: result.legacyProject, backupRoot: result.backupRoot,
    journalPath: result.journalPath, removedContainers: result.removedContainers,
    retainedImages: result.retainedImages,
    rollback: {
      images: `retained locally by exact ID; recreate from the recorded inspect JSON files, not from a registry tag`,
      backup: `cold storage archives and the retire journal are retained at ${result.backupRoot}`,
      archives: result.rollback.archives.map((archive) => ({
        archive: archive.archive, type: archive.type, source: archive.source, storage: `${archive.type}:${maskSecrets(archive.source)}`,
        restoreArgv: archive.restoreArgv.map((argument) => maskSecrets(argument)),
        restore: maskSecrets(archive.restore),
        stopAllConsumersFirst: true,
        restoreOnlyIfStorageChanged: true,
        exactCommandsInPrivateManifest: true,
      })),
      containers: result.rollback.containers.map((container) => ({
        id: container.id, service: container.service ?? null, imageId: container.imageId,
        ports: container.ports, mounts: container.mounts, envNames: container.envNames,
      })),
      reconstruction: `the recorded docker inspect JSON files (inspect-<id>.json) at ${result.backupRoot} are the authoritative source for reconstructing the removed containers`,
    },
    nextStep: `recipe install ${recipe.name}`,
  }, null, 2))}\n`);
}
