import { resolve } from "node:path";
import type { Context } from "#src/core/context.ts";
import type { Recipe } from "#src/service/recipe.ts";
import type { MigrationBackupEvidence, MigrationBackupVerification, StackMigrateOptions } from "#src/runtime/runtime.ts";
import { importHookModule } from "#src/commands/management/recipe/hook-runtime.ts";

/** Construction is inert: even module evaluation waits until the executor has stopped source.
 * Module top-level code and verifier MUST be read-only. Import/call deadlines do not cancel
 * arbitrary app code; this is a trusted observer contract, not a sandbox. */
export function migrationVerifier(ctx: Context, recipe: Recipe): StackMigrateOptions["verifyMigrationBackup"] {
  if (recipe.migrationBackup?.consistency !== "application-verified-cold") return undefined;
  const path = resolve(recipe.directory, recipe.migrationBackup.verification);
  return async (evidence: MigrationBackupEvidence): Promise<MigrationBackupVerification> => {
    const loaded = await importHookModule(path);
    if (typeof loaded.verifyMigrationBackup !== "function")
      throw new Error(`recipe "${recipe.name}" migration-verify.ts must export verifyMigrationBackup(ctx, recipe, evidence)`);
    return loaded.verifyMigrationBackup(ctx, recipe, evidence) as Promise<MigrationBackupVerification>;
  };
}
