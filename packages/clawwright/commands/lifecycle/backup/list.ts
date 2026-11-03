// `clawwright backup list` — read-only inventory: every backup archive in
// ctx.settings.backupDir, and every `<dataDir>.replaced-*` copy restore left next to the
// data directory, both from the target through ctx.transport. Marks which archive a bare
// `clawwright restore` would pick by default.
//
// What is not shown: WHY an archive was created (backup/pull/upgrade — BackupPurpose,
// core/app.ts). That is a runtime option passed to createBackup for the afterBackup hook;
// it is never written into the archive's name or anywhere else retrievable afterwards, so
// there is nothing here to read it back from — omitted rather than guessed.

import { log, info, die } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { humanSize } from "#src/core/io/size.ts";
import { TransportUnreachableError } from "#src/runtime/transport/transport.ts";
import { unreachableProblem } from "#src/service/inspection.ts";
import type { Context } from "#src/core/context.ts";
import type { ArgumentSpec, Values } from "#src/core/command/spec.ts";
import {
  listBackupArchives, listReplacedCopies, defaultRestoreArchive,
  InventoryUnreadableError,
  type BackupArchiveInfo, type ReplacedCopyInfo,
} from "#src/service/archive/index.ts";

export const JSON_ARGUMENT = { name: "json", description: "Emit archives and replaced copies as JSON instead of text", kind: "flag" } as const satisfies ArgumentSpec;

export const BACKUP_LIST_ARGUMENTS = [JSON_ARGUMENT] as const satisfies readonly ArgumentSpec[];

export interface BackupListValues extends Values<typeof BACKUP_LIST_ARGUMENTS> {}

function archiveLine(entry: BackupArchiveInfo, isDefault: boolean): string {
  return `${entry.name}  ${humanSize(entry.sizeBytes)}  ${entry.modifiedAt}  ${entry.profile}${isDefault ? "  (default for restore)" : ""}`;
}

function replacedLine(entry: ReplacedCopyInfo): string {
  return `${entry.name}  ${humanSize(entry.sizeBytes)}  ${entry.modifiedAt}`;
}

export async function backupList(ctx: Context, values: BackupListValues): Promise<void> {
  const jsonOnly = values.json === true;

  const { backupDir, dataDir } = ctx.settings;
  let archives: BackupArchiveInfo[];
  let replaced: ReplacedCopyInfo[];
  try {
    [archives, replaced] = await Promise.all([
      listBackupArchives(ctx, backupDir),
      listReplacedCopies(ctx, dataDir),
    ]);
  } catch (error) {
    if (error instanceof InventoryUnreadableError) die(error.message);
    if (!(error instanceof TransportUnreachableError)) throw error;
    const found = unreachableProblem(error);
    die(`${found.code}  ${found.detail}`, found.next);
  }
  const picked = defaultRestoreArchive(archives);

  if (jsonOnly || isCaptured()) {
    emit(
      `${JSON.stringify(
        {
          backupDir,
          archives: archives.map((entry) => ({
            name: entry.name,
            path: entry.path,
            sizeBytes: entry.sizeBytes,
            modifiedAt: entry.modifiedAt,
            profile: entry.profile,
            default: picked !== undefined && entry.path === picked.path,
          })),
          dataDir,
          replacedCopies: replaced.map((entry) => ({
            name: entry.name,
            path: entry.path,
            sizeBytes: entry.sizeBytes ?? null,
            modifiedAt: entry.modifiedAt,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  log(`backup archives in ${backupDir}`);
  if (archives.length === 0) {
    info("none found");
  } else {
    for (const entry of archives) info(archiveLine(entry, picked !== undefined && entry.path === picked.path));
  }

  log(`<data>.replaced-* copies next to ${dataDir}`);
  if (replaced.length === 0) {
    info("none found");
  } else {
    for (const entry of replaced) info(replacedLine(entry));
    info(`remove with: ${commandLine(["backup", "prune-replaced", "--apply"])}`);
  }
}
