// `clawwright backup --dry-run`'s report: the same refusals and archive-name computation
// createBackupLocked runs, reported instead of acted on. Nothing here stops the gateway,
// quiesces a recipe stack, or writes anything — see index.ts's validateBackupTarget/
// createBackupLocked, which this deliberately mirrors rather than re-derives.

import { log, info, warn } from "#src/core/io/log.ts";
import type { Context } from "#src/core/context.ts";
import { backupArchiveName, dataDirName, excludesFor, symlinkedDataRoot, type Profile } from "#src/service/archive/index.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { runningRecipeStacks } from "#src/commands/management/recipe/index.ts";
import type { BackupOptions } from "./index.ts";

export interface BackupPlan {
  archiveName: string;
  archivePath: string;
  profile: Profile;
  dataDir: string;
  wouldStopGateway: boolean;
  excludes: string[];
  recipeStacksToQuiesce: string[];
  refusals: string[];
}

/** Computed the same way createBackupLocked names/validates a real archive, but from a
 *  read-only pass: a symlinked or missing data directory is named, never acted on. */
export async function buildBackupPlan(ctx: Context, options: BackupOptions): Promise<BackupPlan> {
  const profile: Profile = options.profile ?? "full";
  const { dataDir, backupDir } = ctx.settings;
  const refusals: string[] = [];

  if (options.native === true && profile !== "full") {
    refusals.push("--native only supports the full profile — migrate/share stay on the framework's own tar path");
  }
  if (!(await ctx.transport.exists(dataDir))) refusals.push(`data directory ${dataDir} does not exist`);
  const linkTarget = await symlinkedDataRoot(ctx);
  if (linkTarget !== undefined) {
    refusals.push(`data directory ${dataDir} is a symlink to ${linkTarget} — a backup would archive the link itself, not the data behind it`);
  }

  const name = dataDirName(dataDir);
  // A placeholder stamp: the real one is time-of-run, decided inside createBackupLocked.
  const archiveName = backupArchiveName(deploymentName(), "<timestamp>", profile);
  const wouldStopGateway = options.native !== true && options.hot !== true && await ctx.runtime.isRunning();
  const sidecars = options.native !== true && options.hot !== true ? await runningRecipeStacks(ctx) : [];

  return {
    archiveName,
    archivePath: `${backupDir}/${archiveName}`,
    profile,
    dataDir,
    wouldStopGateway,
    excludes: excludesFor(profile, name),
    recipeStacksToQuiesce: sidecars.map((recipe) => recipe.name),
    refusals,
  };
}

export function printBackupPlan(plan: BackupPlan): void {
  log(`backup --dry-run: would archive ${plan.dataDir} as ${plan.archiveName} (profile: ${plan.profile})`);
  info(`archive: ${plan.archivePath}`);
  info(`gateway: ${plan.wouldStopGateway ? "would stop for the duration" : "stays running"}`);
  if (plan.recipeStacksToQuiesce.length > 0) info(`recipe stack(s) to quiesce: ${plan.recipeStacksToQuiesce.join(", ")}`);
  info(`excludes: ${plan.excludes.length === 0 ? "(none)" : plan.excludes.join(", ")}`);
  if (plan.refusals.length > 0) {
    for (const refusal of plan.refusals) warn(refusal);
  }
  info("does not cover: the actual tar output, the privacy verification a migrate/share profile runs after writing, or afterBackup hook side effects");
}
