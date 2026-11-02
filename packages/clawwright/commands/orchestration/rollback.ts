// `rollback` — put back the configuration an operation replaced.
//
// NOT `restore`: restore replaces the whole data directory from a snapshot
// (every workspace, memory, transcript gone), right when the data itself is what went
// wrong. `apply` can only break the configuration, so this command puts back one file and
// stays deliberately separate from restore.
//
// Restarts afterwards, since a configuration the instance hasn't read isn't in force.

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { log, info, warn, die } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { deploymentName, deploymentDir } from "#src/runtime/deployment.ts";
import { Journal, readOperation, latestRollbackable, newOperationId } from "#src/service/operations.ts";
import { restart } from "#src/commands/lifecycle/instance/control.ts";
import { runOwning, takeLock } from "#src/runtime/lock/instance-lock.ts";
import { readInstalledSet, withUnpackedArtifact, requirementProblems, runningImageDigest } from "#src/set/artifacts/install.ts";
import type { InstalledSet, PreviousSet, VerifiedArtifact } from "#src/set/artifacts/install.ts";
import { frameworkVersion } from "#src/commands/management/lock.ts";
import { apply } from "./apply.ts";
import type { OperationRecord } from "#src/service/operations.ts";
import type { Context } from "#src/core/context.ts";
import type { ArgumentSpec } from "#src/core/command/spec.ts";
import { commandBody, runOnContext, type Values } from "#src/core/command/index.ts";
import { LOCK_TAKEOVER_ARGUMENTS } from "#src/commands/interface/groups/shared-arguments.ts";
import * as kinds from "#src/core/values/kinds.ts";
import type { OperationId } from "#src/core/values/plan.ts";
import { publishPrivateTargetFile } from "#src/security/privacy/private-target-file.ts";

// The same kind object prepare derives through, so the plan carries the branded OperationId;
// the record's existence is the run's target fact (design §5.2).
const OPERATION_ID = kinds.operationId("20260101000000000-apply-ab12cd");

export const ROLLBACK_ARGUMENTS = [
  {
    name: "operation",
    summary: "Operation id to undo",
    description: "Operation id to undo (default: the most recent one with a snapshot)",
    kind: "option",
    valueName: "id",
    value: OPERATION_ID,
  },
  { name: "no-restart", description: "Restore without restarting", kind: "flag" },
  // A flag, not `--set <artifact>`: rollback names no artifact of its own, it reinstalls
  // whichever one `apply --set` installed before the current one.
  {
    name: "previous-set",
    summary: "Reinstall the previous set",
    description: "Reinstall the previously installed set instead of restoring one config file",
    kind: "flag",
  },
  ...LOCK_TAKEOVER_ARGUMENTS,
  { name: "json", description: "Outcome as JSON", kind: "flag" },
  { name: "dry-run", description: "What would happen", kind: "flag", effect: "read" },
] as const satisfies readonly ArgumentSpec[];

/** The operation to undo, and why that one. Exported for the checks: choosing the wrong
 *  operation is the failure that matters here, and it is worth asserting without a target. */
export async function operationToRollback(ctx: Context, wanted?: string): Promise<OperationRecord> {
  if (wanted !== undefined) {
    const record = await readOperation(ctx, wanted);
    if (record === undefined) die(`no operation "${wanted}" was recorded — ${commandLine("operations")} lists what there is`);
    if (record.configSnapshot === undefined) {
      die(
        `operation "${wanted}" took no configuration snapshot, so there is nothing to put back.\n` +
          "Only runs that were about to change the configuration take one.",
      );
    }
    return record;
  }

  const latest = await latestRollbackable(ctx);
  if (latest === undefined) {
    die(
      "no operation with a configuration snapshot has been recorded, so there is nothing to roll back to.\n" +
        `If it is the instance's DATA you need back, that is a different operation: ${commandLine("push")} (from a snapshot).`,
    );
  }
  return latest;
}

/** Options validated before a rollback can touch the target. */
interface RollbackOptions {
  readonly previousSet: boolean;
  readonly jsonOnly: boolean;
  readonly dryRun: boolean;
  readonly breakLock: boolean;
  readonly breakForeignLockHost?: string;
  readonly restartAfter: boolean;
  readonly operation?: OperationId;
  readonly applyArgs: string[];
}

/** Every rollback argument mapped before reading or changing instance state; the
 *  cross-flag refusal is the declaration's rule now, enforced by the parser. The operation
 *  id arrives branded: prepare derived it through the declared kind. */
function rollbackOptions(values: Values<typeof ROLLBACK_ARGUMENTS>, operation: OperationId | undefined): RollbackOptions {
  const previousSet = values["previous-set"];
  const jsonOnly = values.json;
  const dryRun = values["dry-run"];
  const breakLock = values["break-lock"];
  const breakForeignLockHost = values["break-foreign-lock"];
  const restartAfter = values["no-restart"] !== true;

  const applyArgs: string[] = [];
  if (jsonOnly) applyArgs.push("--json");
  if (breakLock) applyArgs.push("--break-lock");
  if (breakForeignLockHost !== undefined) applyArgs.push("--break-foreign-lock", breakForeignLockHost);
  return { previousSet, jsonOnly, dryRun, breakLock, breakForeignLockHost, restartAfter, operation, applyArgs };
}

export const ROLLBACK = commandBody({
  effect: "destroy",
  arguments: ROLLBACK_ARGUMENTS,
  rules: [{
    rule: "conflicts",
    name: "previous-set",
    with: ["operation", "no-restart"],
    // A getter: the invocation is set after import, so the line is spelled when refused.
    get reason(): string {
      return `rolls back the whole set through ${commandLine("apply")} — --operation and --no-restart belong to the single-file path only`;
    },
  }],
  prepare: async (call) =>
    // The branded operation id arrives resolved: the pipeline resolved it through the
    // declared kind (S2.5).
    rollbackOptions(call.values, call.values.operation),
  run: (ctx, plan) => rollbackRun(ctx, plan),
});

/** The full-context entry for callers outside this group (the set lifecycle checks): the
 *  same declaration, parsed and run on a context they already hold. */
export const rollback = (ctx: Context, args: string[]): Promise<void> => runOnContext(ROLLBACK, ctx, args);

/** `--dry-run`: names the operation/snapshot (or --previous-set's artifact) a real rollback
 *  would use and whether it's usable, plus whether a restart would follow — nothing beyond
 *  an existence check is read, nothing written, no lock taken. Doesn't cover the
 *  step-by-step plan --previous-set would run through apply — see plan --set <artifact>. */
async function rollbackDryRun(ctx: Context, options: RollbackOptions): Promise<void> {
  if (options.previousSet) {
    const { installed, previous, artifact } = await resolvePreviousSetArtifact(ctx);
    let problem: string | undefined;
    try {
      await withUnpackedArtifact(artifact, async (_staging, verified) => {
        if (verified.id !== previous.id) { problem = "the rollback artifact does not match the recorded previous set"; return; }
        await refuseRuntimeMismatch(ctx, verified);
      });
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    const report = {
      ok: problem === undefined,
      changed: false,
      dryRun: true,
      mode: "previous-set" as const,
      from: `${installed.name} (${installed.id})`,
      to: `${previous.name} (${previous.id})`,
      artifact,
      wouldRestart: true,
      problems: problem === undefined ? [] : [problem],
    };
    if (options.jsonOnly || isCaptured()) {
      emit(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    log(`rollback --dry-run: would reinstall "${previous.name}" (${previous.id}) over "${installed.name}" (${installed.id})`);
    info(`artifact: ${artifact}`);
    info("reversed together: prompts, MCP server registrations, schedules, gateway settings");
    if (problem !== undefined) warn(problem);
    info(`does not cover: the step-by-step plan ${commandLine("apply")} would run for it — see ${commandLine(["plan", "--set", "<artifact>"])}`);
    return;
  }

  const target = await operationToRollback(ctx, options.operation);
  const snapshot = target.configSnapshot!;
  const exists = await ctx.transport.exists(snapshot);
  const report = {
    ok: exists,
    changed: false,
    dryRun: true,
    mode: "config-snapshot" as const,
    operation: target.id,
    snapshot,
    wouldRestart: options.restartAfter,
    problems: exists ? [] : [`the snapshot for operation "${target.id}" is gone (${snapshot})`],
  };
  if (options.jsonOnly || isCaptured()) {
    emit(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  log(`rollback --dry-run: would put back the configuration from before ${target.id}`);
  info(`snapshot: ${snapshot}${exists ? "" : " (missing!)"}`);
  info(`restart afterwards: ${options.restartAfter}`);
  if (!exists) warn(`a real rollback of ${target.id} would refuse — the snapshot is gone`);
}

/** The recorded previous set and the artifact that installs it, or a refusal when either is
 *  missing. Read before anything is touched. */
async function resolvePreviousSetArtifact(ctx: Context): Promise<{ installed: InstalledSet; previous: PreviousSet; artifact: string }> {
  const installed = await readInstalledSet(ctx);
  if (installed?.previous === undefined) {
    die(
      "no previous set is recorded on this instance — rollback --previous-set only knows what apply --set " +
        "installed here before the one currently in force, and there is none on record (or this instance " +
        "was never installed from a set at all)",
    );
  }
  const previous = installed.previous;

  const artifact = resolve(deploymentDir(), "sets", `${previous.name}-${previous.id}.tar.gz`);
  await access(artifact).catch(() => {
    die(
      `the artifact for the previous set is gone — expected ${artifact}.\n` +
        `Set "${previous.name}" (${previous.id}), installed ${previous.installedAt}, cannot be reinstalled without it. ` +
        `Rebuild it if the source that produced it is still available: ${commandLine(["set", "build"])}.`,
    );
  });

  return { installed, previous, artifact };
}

/** Runtime/framework compatibility, checked here rather than left to the nested apply()
 *  call, which runs AFTER the config-snapshot restore already wrote to live config — a
 *  refusal there would leave openclaw.json on the previous set while the installed marker
 *  still names the current one. Same check apply --set's own pre-check runs. */
async function refuseRuntimeMismatch(ctx: Context, verified: VerifiedArtifact): Promise<void> {
  const runtimeIssues = requirementProblems(verified.manifest, {
    framework: await frameworkVersion(),
    imageDigest: await runningImageDigest(ctx, verified.manifest),
  });
  if (runtimeIssues.length > 0) {
    die(
      `the previous set cannot be reinstalled here:\n${runtimeIssues.map((entry) => `  ${entry.detail}`).join("\n")}\n` +
        "Point this deployment's OPENCLAW_IMAGE at the required digest (or update the framework) before rolling back.",
    );
  }
}

/** Reinstalls the previous set through apply, preserving instance data. */
async function rollbackSet(ctx: Context, options: RollbackOptions): Promise<void> {
  const { installed, previous, artifact } = await resolvePreviousSetArtifact(ctx);

  // Verified BEFORE anything is touched — a corrupt or mismatched archive must be refused
  // before the live config is written, not discovered afterward.
  await withUnpackedArtifact(artifact, async (_staging, verified) => {
    if (verified.id !== previous.id) die("the rollback artifact does not match the recorded previous set");
    await refuseRuntimeMismatch(ctx, verified);

    // Said before anything runs: which parts move together is the one thing a coder must
    // know before agreeing to this.
    log(`rolling back from set "${installed.name}" (${installed.id}) to "${previous.name}" (${previous.id})`);
    info("reversed together: prompts, MCP server registrations, schedules, gateway settings — everything the set declares");
    info("left alone: an agent's own memory, and anything else written to the data directory since — this is a set install, not a data restore");

    await rollbackSetUnderLock(ctx, options, installed, previous, artifact);
  }, `installing from ${artifact}`);
}

/** Takes the run-level lock and reinstalls the previous set under it. One lock for the
 *  whole rollback: a gap between "config put back" and "recipes/agents/MCP reconciled"
 *  is a window another operation could mutate the instance in. apply --set's own
 *  lock-taking is nesting-safe, skipping acquisition when this outer one is already held. */
async function rollbackSetUnderLock(ctx: Context, options: RollbackOptions, installed: InstalledSet, previous: PreviousSet, artifact: string): Promise<void> {
  const operationId = newOperationId("rollback");
  const held = await takeLock(ctx, `rollback --previous-set to ${previous.id}`, operationId, { breakLock: options.breakLock, breakForeignLockHost: options.breakForeignLockHost });
  try {
    await runOwning(held, () => reinstallPreviousSet(ctx, options, installed, previous, artifact, operationId));
  } finally {
    await held.release();
  }
}

/** Re-verifies the installed set is still the one this rollback was prepared for, restores
 *  the configuration from before it, then reinstalls the previous set through apply. */
async function reinstallPreviousSet(
  ctx: Context,
  options: RollbackOptions,
  installed: InstalledSet,
  previous: PreviousSet,
  artifact: string,
  operationId: string,
): Promise<void> {
  // Re-verified under the lock: which set is installed could have changed between the
  // initial read and taking this lock. Acting on the stale read would silently overwrite a
  // later install with the wrong transition entirely (B -> A instead of the actual C -> B).
  const stillInstalled = await readInstalledSet(ctx);
  if (stillInstalled?.id !== installed.id) {
    die(
      `the installed set changed while this rollback was preparing (was "${installed.name}" (${installed.id}), ` +
        `is now ${stillInstalled === undefined ? "nothing recorded" : `"${stillInstalled.name}" (${stillInstalled.id})`}) — ` +
        `re-run ${commandLine(["rollback", "--previous-set"])} against the current state.`,
    );
  }

  const journal = await Journal.open(ctx, "rollback", deploymentName(), operationId);
  try {
    await restoreConfigBeforeCurrentSet(ctx, installed, previous, journal);

    // Reinstalls recipes/agents/MCP/cron and reapplies the previous set's declared config —
    // a no-op for anything the restore already fixed, a real fix for anything else drifted.
    await apply(ctx, [...options.applyArgs, "--set", artifact]);
    await journal.close("succeeded", `rolled back to "${previous.name}" (${previous.id})`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await journal.close("failed", detail);
    throw error;
  }
}

/** Puts back the configuration exactly as the previous set left it — the EXACT operation
 *  that installed the current set, not latestRollbackable()'s newest snapshot: a later
 *  ordinary apply's own snapshot would already include whatever the current set added. */
async function restoreConfigBeforeCurrentSet(ctx: Context, installed: InstalledSet, previous: PreviousSet, journal: Journal): Promise<void> {
  const installingOperation = installed.operationId === undefined
    ? undefined
    : await readOperation(ctx, installed.operationId);
  if (installingOperation?.configSnapshot !== undefined && (await ctx.transport.exists(installingOperation.configSnapshot))) {
    const live = `${ctx.settings.dataDir}/config/openclaw.json`;
    log(`putting back the configuration from before ${installingOperation.id}, so nothing the current set added is left behind`);
    await publishPrivateTargetFile(ctx, live, await ctx.transport.readFile(installingOperation.configSnapshot));
    await journal.step("restore-config", "done", `from ${installingOperation.configSnapshot}`);
    return;
  }

  // Without this snapshot there's no way to prove a setting the current set added (but the
  // previous never declared) gets undone — reinstalling the previous set only SETS its own
  // paths, never unsets anything.
  await journal.step("restore-config", "failed", "no recorded snapshot for the operation that installed the current set");
  die(
    `cannot roll back "${installed.name}" (${installed.id}) to "${previous.name}" (${previous.id}): ` +
      "no configuration snapshot is available for the operation that installed the current set" +
      (installed.operationId === undefined
        ? " (none was ever recorded for it)"
        : ` (operation ${installed.operationId} recorded none, or its snapshot file is gone)`) +
      ".\nWithout it, a setting the current set added but the previous one never declared cannot be " +
      `proven undone. Put the configuration back by hand, or restore data from a snapshot instead: ` +
      `${commandLine("push")}.`,
  );
}

async function rollbackRun(ctx: Context, options: RollbackOptions): Promise<void> {
  if (options.dryRun) return rollbackDryRun(ctx, options);
  if (options.previousSet) return rollbackSet(ctx, options);

  const target = await operationToRollback(ctx, options.operation);
  const snapshot = target.configSnapshot!;

  if (!(await ctx.transport.exists(snapshot))) {
    die(`the snapshot for operation "${target.id}" is gone (${snapshot}) — nothing to put back`);
  }

  // Recorded like any other mutating run: rolling back is itself a change to the instance,
  // and the next person asking "what happened here" should see it.
  const journal = await Journal.open(ctx, "rollback", deploymentName());
  const live = `${ctx.settings.dataDir}/config/openclaw.json`;

  const held = await takeLock(ctx, `rollback of ${target.id}`, journal.id, { breakLock: options.breakLock, breakForeignLockHost: options.breakForeignLockHost });
  try {
    await runOwning(held, async () => {
      log(`putting back the configuration from before ${target.id}`);
      await publishPrivateTargetFile(ctx, live, await ctx.transport.readFile(snapshot));
      await journal.step("restore-config", "done", `from ${snapshot}`);

      if (options.restartAfter) {
        // A configuration the instance has not read is not in force.
        await restart(ctx, []);
        await journal.step("restart", "done");
      } else {
        await journal.step("restart", "advisory", "--no-restart: the instance is still running the configuration this replaced");
      }

      await journal.close("succeeded", `rolled back ${target.id}`);
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await journal.step("rollback", "failed", detail);
    await journal.close("failed", detail);
    throw error;
  } finally {
    // Released whatever happened: a failed rollback that kept the lock would block the very
    // command someone runs next to fix it.
    await held.release();
  }

  const answer = {
    deployment: deploymentName(),
    operationId: journal.id,
    changed: true,
    rolledBack: target.id,
    restored: snapshot,
    restarted: options.restartAfter,
  };

  if (options.jsonOnly || isCaptured()) {
    emit(`${JSON.stringify(answer, null, 2)}\n`);
    return;
  }

  log(`rolled back ${target.id}`);
  info(`configuration restored from ${snapshot}`);
  if (!options.restartAfter) info("not restarted (--no-restart): the instance is still running what this replaced");
  info(`this rollback is itself recorded: ${commandLine(["operations", journal.id])}`);
}
