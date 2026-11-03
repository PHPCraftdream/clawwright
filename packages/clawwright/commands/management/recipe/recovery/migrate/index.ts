import { ignoredEphemeralPaths, type SideStackMigrateOptions } from "#src/runtime/docker/side-stack/migration-plan.ts";
import { migrationVerifier } from "./migration-verifier.ts";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { Context } from "#src/core/context.ts";
import type { RecipeRef } from "#src/core/values/plan.ts";
import { maskSecrets } from "#src/core/io/log.ts";
import { emit } from "#src/core/io/output.ts";
import { loadRecipe, recipeStack } from "#src/service/recipe.ts";
import { guardedWith, type LockTakeover } from "#src/runtime/lock/instance-lock.ts";

/** Target-side coordinates only; preview never creates the private recovery directory. */
export function backupRoot(dataDir: string): string {
  if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*\/?$/.test(dataDir)
    || dataDir.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("recipe migration requires a safe absolute target data directory");
  }
  return posix.join(posix.dirname(dataDir.replace(/\/$/, "")), ".clawwright-recipe-recovery", randomUUID());
}

export interface MigrationCommandOptions {
  helperImage?: string;
  shutdownTimeoutSeconds?: number;
}

export async function runMigrateAction(
  ctx: Context,
  name: RecipeRef,
  dryRun: boolean,
  takeover: LockTakeover,
  options: MigrationCommandOptions = {},
): Promise<void> {
  const recipe = await loadRecipe(name);
  if (!recipe.migrationBackup) throw new Error("recipe migration requires recipe.json migrationBackup application-cold-safe author contract");
  const stack = recipeStack(ctx, recipe.name, recipe.definitionPath);
  if (stack.planMigrate === undefined || stack.migrate === undefined) {
    throw new Error("runtime does not support recipe migration");
  }
  // Read-only planning precedes the executor's caller-supplied lock scope.
  const migrateOptions: SideStackMigrateOptions = { backupRoot: backupRoot(ctx.settings.dataDir), migrationBackup: recipe.migrationBackup,
    ephemeralPaths: recipe.ephemeralPaths, ...options, verifyMigrationBackup: migrationVerifier(ctx, recipe) };
  const plan = await stack.planMigrate(migrateOptions);
  const ignored = ignoredEphemeralPaths(plan);
  emit(`${maskSecrets(JSON.stringify({
    recipe: recipe.name, dryRun, operation: "migrate-owned-legacy-stack",
    sourceProject: plan.sourceProject, targetProject: plan.targetProject,
    services: plan.services, images: plan.images, volumes: plan.volumes,
    helperImage: plan.helperImage, shutdownTimeoutSeconds: plan.shutdownTimeoutSeconds,
    inventory: plan.inventory.map((container) => ({
      id: container.id, project: container.project, provenance: container.provenance,
      service: container.service, state: container.state, health: container.health,
      exitCode: container.exitCode, imageId: container.imageId,
      mounts: container.mounts?.map((mount) => ({
        type: mount.type, source: mount.source, destination: mount.destination,
        writable: mount.writable, name: mount.name,
      })),
    })),
    ignoredEphemeralPaths: ignored,
    ephemeralSummary: ignored.map(({ path, count }) => `ignored as ephemeral by the recipe: ${path} (${count} entries)`),
    migrationBackup: plan.migrationBackup,
    backupRoot: plan.backupRoot,
    retainedArtifacts: { privateBackups: true, sourceVolumes: plan.volumes.map((volume) => volume.source),
      failedTargetArtifacts: true },
    removesVerifiedSourceContainersOnSuccess: true,
    build: false, pull: false, runsHooks: !dryRun && recipe.migrationBackup.consistency === "application-verified-cold",
    postStopVerification: recipe.migrationBackup.consistency === "application-verified-cold", impacts: plan.impacts,
  }, null, 2))}\n`);
  if (dryRun) return;
  const result = await stack.migrate(plan, (action) =>
    guardedWith(ctx, `recipe migrate ${name}`, takeover, action));
  emit(`${maskSecrets(JSON.stringify({ recipe: recipe.name, backupRoot: result.backupRoot,
    ignoredEphemeralPaths: ignoredEphemeralPaths(result),
    migrationBackup: result.migrationBackup, evidence: result.evidence,
    journalPath: result.journalPath, retainedSourceVolumes: result.retainedSource }, null, 2))}\n`);
}
