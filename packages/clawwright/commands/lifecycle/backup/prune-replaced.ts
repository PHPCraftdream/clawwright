// `clawwright backup prune-replaced` — deletes `<dataDir>.replaced-*` copies restore leaves
// next to the data directory once it has moved the previous data aside. Preview by default;
// only --apply deletes.
//
// Archive pruning is already handled by backup's own rotation (rotate(), in index.ts) — this
// never touches an archive, only replaced-data siblings, refusing any path that is not
// exactly one of those (strict name validation, symlinks refused, the data directory itself
// refused), re-checked immediately before each deletion rather than trusted from the listing.

import { log, info, warn, die } from "#src/core/io/log.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import * as kinds from "#src/core/values/kinds.ts";
import type { ArgumentSpec, Values } from "#src/core/command/spec.ts";
import { guardedWith } from "#src/runtime/lock/instance-lock.ts";
import { runMaybePrivileged, sudoFor, needsOwnerEscalation, OWNER, answeredProbe } from "#src/runtime/files/datadir.ts";
import {
  listReplacedCopies, dataDirName, dataDirParent, parseReplacedCopyName, type ReplacedCopyInfo,
} from "#src/service/archive/index.ts";
import { LOCK_TAKEOVER_ARGUMENTS, takeoverOf } from "#src/commands/interface/groups/shared-arguments.ts";
import { JSON_ARGUMENT } from "./list.ts";

/** Shared across every `backup` sub-action that previews by default — prune-replaced and
 *  install/uninstall alike — so the merged `backup` command's single `--apply` never carries
 *  two different descriptions. Declared once, here, reused by install.ts. --apply is the
 *  action's destructive form, so the effect model demands the confirmation. */
export const BACKUP_APPLY_ARGUMENT = {
  name: "apply",
  summary: "Apply, not preview",
  description: "Apply the action instead of only previewing it (delete, or install/uninstall the schedule)",
  kind: "flag",
  effect: "destroy",
} as const satisfies ArgumentSpec;

/** The declared, help/MCP-visible shape — `--json` is declared once, in list.ts, and
 *  reused here (not redeclared) so the merged `backup` command never lists it twice. */
export const BACKUP_PRUNE_ARGUMENTS = [
  BACKUP_APPLY_ARGUMENT,
  { name: "keep", summary: "Number to keep", description: "Keep this many newest copies instead of deleting all of them", kind: "option", valueName: "n", value: kinds.count("a non-negative integer") },
  ...LOCK_TAKEOVER_ARGUMENTS,
  JSON_ARGUMENT,
] as const satisfies readonly ArgumentSpec[];

export interface PruneValues extends Values<typeof BACKUP_PRUNE_ARGUMENTS> {}

function summary(entry: ReplacedCopyInfo): { name: string; path: string; sizeBytes: number | null; modifiedAt: string } {
  return { name: entry.name, path: entry.path, sizeBytes: entry.sizeBytes ?? null, modifiedAt: entry.modifiedAt };
}

/** Re-checked immediately before deletion, never trusted from the listing that chose it —
 *  the listing and the delete are not the same moment. Refuses anything that is not exactly
 *  a `<dataDir>.replaced-<stamp>` sibling, a symlink, or the data directory itself.
 *
 *  Exported for testing: this is the invariant worth pinning directly, not only reachable
 *  through whatever listReplacedCopies happened to filter first. */
export async function verifyPruneCandidate(ctx: Context, dataDir: string, path: string): Promise<void> {
  if (path === dataDir) die(`refusing to remove the data directory itself: ${path}`);
  if (dataDirParent(path) !== dataDirParent(dataDir)) die(`refusing ${path}: not a direct sibling of ${dataDir}`);
  if (parseReplacedCopyName(dataDirName(path), dataDirName(dataDir)) === undefined) {
    die(`refusing ${path}: name does not match <dataDir>.replaced-<stamp>`);
  }

  const prefix = await sudoFor(ctx, path);
  const [linkHead, ...linkRest] = [...prefix, "test", "-L", path];
  if ((await answeredProbe(ctx, linkHead, linkRest, [0, 1])).code === 0) die(`refusing ${path}: it is a symlink, not an ordinary directory`);

  const [dirHead, ...dirRest] = [...prefix, "test", "-d", path];
  if ((await answeredProbe(ctx, dirHead, dirRest, [0, 1])).code !== 0) die(`${path} is no longer an ordinary directory — refusing to remove it`);
}

async function deleteReplacedCopy(ctx: Context, dataDir: string, path: string): Promise<void> {
  await verifyPruneCandidate(ctx, dataDir, path);
  await runMaybePrivileged(ctx, path, "rm", ["-rf", "--", path], { force: await needsOwnerEscalation(ctx, OWNER) });
}

export async function backupPruneReplaced(ctx: Context, values: PruneValues): Promise<void> {
  const apply = values.apply === true;
  const jsonOnly = values.json === true;
  const keep = values.keep ?? 0;

  const { dataDir } = ctx.settings;
  // newest first, from listReplacedCopies — the newest `keep` are retained, everything
  // beyond them is a candidate.
  const copies = await listReplacedCopies(ctx, dataDir);
  const toKeep = copies.slice(0, keep);
  const toDelete = copies.slice(keep);

  if (!apply) {
    if (jsonOnly || isCaptured()) {
      emit(`${JSON.stringify({ apply: false, keep, candidates: toDelete.map(summary), keeping: toKeep.map(summary) }, null, 2)}\n`);
      return;
    }
    log(`<data>.replaced-* copies next to ${dataDir}`);
    if (copies.length === 0) {
      info("none found — nothing to prune");
      return;
    }
    for (const entry of toDelete) info(`would remove  ${entry.name}`);
    for (const entry of toKeep) info(`would keep    ${entry.name}  (within --keep ${keep})`);
    info(toDelete.length === 0 ? "nothing beyond --keep — pass a smaller --keep to remove any" : `pass --apply to remove ${toDelete.length} of them`);
    return;
  }

  if (toDelete.length === 0) {
    if (jsonOnly || isCaptured()) {
      emit(`${JSON.stringify({ apply: true, keep, deleted: [], failed: [], keeping: toKeep.map(summary) }, null, 2)}\n`);
    } else {
      info(copies.length === 0 ? "none found — nothing to prune" : `nothing beyond --keep ${keep} — kept ${toKeep.length}`);
    }
    return;
  }

  // The one mutating path here, so the one that takes the instance lock — deleting a
  // replaced copy while a restore is mid-move of a NEW one into that same name is exactly
  // the race guardedWith() exists to serialize against.
  await guardedWith(ctx, "backup prune-replaced", takeoverOf(values), async () => {
    const deleted: ReplacedCopyInfo[] = [];
    const failed: { path: string; error: string }[] = [];
    for (const entry of toDelete) {
      try {
        await deleteReplacedCopy(ctx, dataDir, entry.path);
        deleted.push(entry);
        log(`removed ${entry.name}`);
      } catch (error) {
        failed.push({ path: entry.path, error: (error as Error).message });
        warn(`could not remove ${entry.name}: ${(error as Error).message}`);
      }
    }

    if (jsonOnly || isCaptured()) {
      emit(
        `${JSON.stringify(
          { apply: true, keep, deleted: deleted.map((entry) => entry.name), failed, keeping: toKeep.map(summary) },
          null,
          2,
        )}\n`,
      );
    } else {
      info(`removed ${deleted.length} of ${toDelete.length} candidate(s); kept ${toKeep.length}`);
    }
    if (failed.length > 0) die(`prune-replaced completed with ${failed.length} failure(s)`);
  });
}
