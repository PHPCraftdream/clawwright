import { emit, isCaptured } from "#src/core/io/output.ts";
import { info, log } from "#src/core/io/log.ts";
import type { Context } from "#src/core/context.ts";
import type { ArgumentSpec, Values } from "#src/core/command/spec.ts";
import { commandBody, runOnContext } from "#src/core/command/index.ts";
import { BREAK_FOREIGN_LOCK_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";
import { withLockUnlessHeld } from "#src/runtime/lock/instance-lock.ts";
import { newOperationId } from "#src/service/operations.ts";
import { planFiles, applyFiles, type FilesPlan } from "#src/runtime/files/files-deployment.ts";

export const FILES_ARGUMENTS = [
  { name: "apply", summary: "Apply declared deployment files", description: "Write declared files into the data directory and prune according to mirror/overlay ownership", kind: "flag", effect: "destroy" },
  { name: "dry-run", summary: "Preview file changes", description: "Plan writes and removals without changing the data directory", kind: "flag", effect: "read" },
  { name: "json", description: "Emit the plan or result as JSON", kind: "flag" },
  { name: "break-lock", summary: "Take over the lock", description: "Take over the instance lock held by another operation", kind: "flag" },
  BREAK_FOREIGN_LOCK_ARGUMENT,
] as const satisfies readonly ArgumentSpec[];
export interface FilesValues extends Values<typeof FILES_ARGUMENTS> {}
interface FilesCommandPlan { readonly apply: boolean; readonly dryRun: boolean; readonly json: boolean; readonly takeover: { breakLock: boolean; breakForeignLockHost?: string } }
function view(plan: FilesPlan) {
  return {
    targets: [
      ...plan.entries.map((entry) => ({ target: entry.target, mode: entry.mode, writes: entry.files, removals: entry.removals })),
      ...plan.retired.map((entry) => ({ target: entry.target, mode: "retired", writes: [], removals: entry.files.filter((path) => entry.actual.includes(path)) })),
    ],
    warnings: plan.warnings,
  };
}
export const FILES = commandBody({
  effect: "read",
  arguments: FILES_ARGUMENTS,
  rules: [
    { rule: "conflicts", name: "apply", with: ["dry-run"], reason: "--dry-run previews without applying" },
    { rule: "conflicts", name: "break-lock", with: ["dry-run"], reason: "a dry run takes no lock, so there is no lock to break" },
    { rule: "conflicts", name: "break-foreign-lock", with: ["dry-run"], reason: "a dry run takes no lock, so there is no lock to break" },
  ],
  prepare: (call) => ({
    apply: call.values.apply === true,
    dryRun: call.values["dry-run"] === true,
    json: call.values.json === true,
    takeover: { breakLock: call.values["break-lock"] === true, breakForeignLockHost: call.values["break-foreign-lock"] },
  } satisfies FilesCommandPlan),
  async run(ctx, plan) { await runFiles(ctx, plan as FilesCommandPlan); },
});
export async function filesCommand(ctx: Context, args: string[]): Promise<void> { await runOnContext(FILES, ctx, args); }
async function runFiles(ctx: Context, command: FilesCommandPlan): Promise<void> {
  const render = (plan: FilesPlan, changed: boolean): void => {
    const result = view(plan);
    if (command.json || isCaptured()) emit(`${JSON.stringify({ ok: true, changed, dryRun: !changed, ...result }, null, 2)}\n`);
    else {
      log(changed ? "deployment files applied" : command.dryRun ? "files --dry-run" : "files status");
      for (const target of result.targets) {
        info(`${target.target} (${target.mode})`);
        for (const path of target.writes) info(`  write ${path}`);
        for (const path of target.removals) info(`  remove ${path}`);
      }
      for (const warning of result.warnings) info(`warning: ${warning}`);
    }
  };
  if (!command.apply) { render(await planFiles(ctx), false); return; }
  await withLockUnlessHeld(ctx, "files apply", newOperationId("files"), command.takeover, async () => {
    const plan = await planFiles(ctx);
    await applyFiles(ctx, plan);
    render(plan, true);
  });
}
