// BACKUP_MISSING/BACKUP_STALE/DISK_LOW: whether this deployment could actually be
// recovered, not whether it is serving right now.
//
// Deliberately NOT wired into watch's liveness machinery (LIVENESS_CODES, check.ts): none
// of these mean the instance stopped doing its job (same reasoning keeps CONFIG_DRIFT and
// RECIPE_MIRROR_DRIFT out too). watch has its own differently-shaped DISK_LOW
// (health.ts: OC_WATCH_DISK_MIN_MB, data directory only, a liveness poll); this file's
// DISK_LOW (OC_DISK_MIN_FREE_MB, data + backup directory) is a separate warning-only
// finding that happens to share the code string — never merged, since that would fold a
// "down" liveness signal into a severity table that is warning-only by design.
//
// Reuses readers instead of inventing new ones: listBackupArchives/defaultRestoreArchive
// are what `backup list` reads; the disk probe is one `df -Pk` call, never a container exec.

import { problem } from "#src/service/inspection.ts";
import type { Problem } from "#src/service/inspection.ts";
import { parseDiskMinFreeMb, parseDurationThreshold } from "#src/core/env.ts";
import { listBackupArchives, defaultRestoreArchive, InventoryUnreadableError } from "#src/service/archive/index.ts";
import { TransportUnreachableError } from "#src/runtime/transport/transport.ts";
import type { Context } from "#src/core/context.ts";

/** Unexpected probes are best-effort; a known unreadable backup inventory is reported. */
async function bestEffort(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    if (error instanceof TransportUnreachableError) throw error;
  }
}

export const BACKUP_MAX_AGE_ENV = "OC_BACKUP_MAX_AGE";
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BACKUP_MAX_AGE_MS = 2 * DAY_MS;
const DEFAULT_BACKUP_MAX_AGE_LABEL = "2d";

export const DISK_MIN_FREE_MB_ENV = "OC_DISK_MIN_FREE_MB";
const DEFAULT_DISK_MIN_FREE_MB = 1024;

/** BACKUP_MISSING/BACKUP_STALE: same listing `backup list` reads, same "which one restore
 *  would pick" rule (newest FULL archive). Migrate/share-only reads as missing, same as
 *  empty: neither is restorable on its own. */
export async function observeBackupHealth(ctx: Context, problems: Problem[]): Promise<void> {
  await bestEffort(async () => {
    const { backupDir } = ctx.settings;
    let archives;
    try {
      archives = await listBackupArchives(ctx, backupDir);
    } catch (error) {
      if (!(error instanceof InventoryUnreadableError)) throw error;
      problems.push(problem("BACKUP_UNREADABLE", `${error.message}; backup availability cannot be determined`));
      return;
    }
    const newest = defaultRestoreArchive(archives);
    if (newest === undefined) {
      problems.push(problem("BACKUP_MISSING", `no full backup archive in ${backupDir}`));
      return;
    }

    const maxAgeMs = parseDurationThreshold(BACKUP_MAX_AGE_ENV, ctx.settings.env[BACKUP_MAX_AGE_ENV], DEFAULT_BACKUP_MAX_AGE_MS, DEFAULT_BACKUP_MAX_AGE_LABEL);
    if (maxAgeMs === 0) return;

    const ageMs = Date.now() - Date.parse(newest.modifiedAt);
    if (Number.isFinite(ageMs) && ageMs > maxAgeMs) {
      const ageDays = (ageMs / DAY_MS).toFixed(1);
      problems.push(
        problem("BACKUP_STALE", `the newest full backup ${newest.name} was created ${newest.modifiedAt} (${ageDays}d ago), older than ${BACKUP_MAX_AGE_ENV} allows`),
      );
    }
  });
}

/** `df -Pk`'s Available column (4th field). An unstattable path is simply absent from
 *  stdout (df reports it on stderr and keeps going), never a thrown error. */
function parseAvailableKbRows(stdout: string): number[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(1)
    .map((line) => Number(line.trim().split(/\s+/)[3]))
    .filter((value) => Number.isFinite(value) && value >= 0);
}

/** DISK_LOW: one `df -Pk` naming both data and backup directory (deduped when they
 *  coincide). Data dir always exists once bootstrapped and is listed first, so a missing
 *  row can only be the backup directory's (never created yet) — read as a gap, not guessed. */
export async function observeDiskSpace(ctx: Context, problems: Problem[]): Promise<void> {
  await bestEffort(async () => {
    const thresholdMb = parseDiskMinFreeMb(DISK_MIN_FREE_MB_ENV, ctx.settings.env[DISK_MIN_FREE_MB_ENV], DEFAULT_DISK_MIN_FREE_MB);
    if (thresholdMb === 0) return;

    const { dataDir, backupDir } = ctx.settings;
    const paths = dataDir === backupDir ? [dataDir] : [dataDir, backupDir];
    const result = await ctx.transport.exec("df", ["-Pk", ...paths], { allowFailure: true });
    const rows = parseAvailableKbRows(result.stdout);

    for (let index = 0; index < rows.length; index += 1) {
      const availableMb = rows[index] / 1024;
      if (availableMb < thresholdMb) {
        problems.push(
          problem("DISK_LOW", `${paths[index]} has ${availableMb.toFixed(0)} MB free, below the ${DISK_MIN_FREE_MB_ENV} threshold of ${thresholdMb} MB`),
        );
      }
    }
  });
}
