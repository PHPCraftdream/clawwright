// `clawwright backup install` / `backup uninstall` — a scheduler entry that runs
// `clawwright backup` on an interval, mirroring `watch install`/`watch uninstall` exactly:
// same crontab conventions, same Windows fallback, both built on schedule.ts.
//
// OC_BACKUP_KEEP (.env.example) presumes backups happen on a schedule; this command supplies
// backup's own job name, target invocation and interval shape onto schedule.ts's machinery.
//
// `--interval` is the shared duration grammar (30m/6h/1d or bare minutes; default 1d),
// parsed by parseIntervalToMinutes — the same parser `watch install` uses — into the minutes
// cronSchedule() validates, so the two commands cannot drift.

import { info, log, warn } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import type { Context } from "#src/core/context.ts";
import { cronSchedule, nearestValidIntervals } from "#src/commands/operate/schedule.ts";
import * as kinds from "#src/core/values/kinds.ts";
import { intervalRangeRefusal } from "#src/core/values/kinds.ts";
import type { ArgumentSpec, Values } from "#src/core/command/spec.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { guardedWith } from "#src/runtime/lock/instance-lock.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import { LOCK_TAKEOVER_ARGUMENTS, takeoverOf } from "#src/commands/interface/groups/shared-arguments.ts";
import {
  cronLine,
  jobMarker,
  parseIntervalToMinutes,
  posixTargetInvocation,
  printSchedulingInstructions,
  printUnschedulingInstructions,
  schedulingSupport,
  schedulerIdentity,
  updateCrontab,
} from "#src/commands/operate/schedule.ts";
import { BACKUP_APPLY_ARGUMENT } from "./prune-replaced.ts";

const JOB = "backup";
const DEFAULT_BACKUP_INTERVAL = "1d";
export const NOTHING_INSTALLED = "no backup schedule was installed for this deployment — nothing to remove";

/** The slice of `backup`'s declaration `install`'s own argv actually uses. `--apply` is the
 *  shared BACKUP_APPLY_ARGUMENT (prune-replaced.ts), not a second declaration of the same
 *  name — see its own comment for why. */
export const BACKUP_INSTALL_ARGUMENTS = [
  {
    name: "interval",
    summary: "Interval: default 1d; explicit unit required",
    description: "With install: how often (default 1d) — 30m, 6h or 1d, explicit unit required (a bare number is minutes only for watch install); minutes must divide 60, hours must divide a day",
    kind: "option",
    valueName: "interval",
    // The kind's grammar with schedule.ts's range policy: the cron range check throws the
    // same ValueError the legacy wrapper produced (the command's own voice), the grammar
    // refusal moves into the kind. An explicit unit stays required here.
    value: kinds.interval({
      requireUnit: true,
      nearestUnit: (value) => nearestValidIntervals(value).join(", "),
      enforceRange: (minutes) => {
        try {
          cronSchedule(minutes);
        } catch (error) {
          // The same ValueError the legacy wrapper produced: intervalRangeRefusal
          // re-joins the label into cronSchedule's own "--interval …" sentence, byte for byte.
          intervalRangeRefusal(error); // throws
        }
      },
    }),
  },
  BACKUP_APPLY_ARGUMENT,
  ...LOCK_TAKEOVER_ARGUMENTS,
] as const satisfies readonly ArgumentSpec[];

/** The slice `uninstall` uses — no --interval, since there is no schedule to set. A strict
 *  subset of BACKUP_INSTALL_ARGUMENTS's own names, so it is never merged into the top-level
 *  declaration itself (same convention as watch's own WATCH_UNINSTALL_ARGUMENTS). */
export const BACKUP_UNINSTALL_ARGUMENTS = [
  BACKUP_APPLY_ARGUMENT,
  ...LOCK_TAKEOVER_ARGUMENTS,
] as const satisfies readonly ArgumentSpec[];

export interface InstallValues extends Values<typeof BACKUP_INSTALL_ARGUMENTS> {}
export interface UninstallValues extends Values<typeof BACKUP_UNINSTALL_ARGUMENTS> {}

function installPlan(values: InstallValues): { minutes: number; interval: string; apply: boolean } {
  // An empty --interval is refused (not defaulted), and a bare number is refused: a backup
  // cadence must always carry an explicit unit — "6" is probably a typo for "6h", and a
  // gateway-stopping backup every 6 minutes would out-rotate OC_BACKUP_KEEP within an hour.
  const interval = values.interval === undefined ? DEFAULT_BACKUP_INTERVAL : String(values.interval);
  return { minutes: values.interval ?? parseIntervalToMinutes(interval, { bareMinutes: false }), interval, apply: values.apply === true };
}

export async function backupInstall(ctx: Context, values: InstallValues): Promise<void> {
  const { minutes, interval, apply } = installPlan(values);
  const takeover = takeoverOf(values);
  const support = schedulingSupport(ctx);
  const name = deploymentName();

  if (!support.supported) {
    warn(`cannot install an unattended schedule on ${ctx.transport.description}: ${support.reason}`);
    await printSchedulingInstructions(ctx, JOB, name, minutes, [JOB], apply);
    return;
  }

  const invocation = await posixTargetInvocation(ctx, [JOB]);
  cronLine(minutes, invocation, JOB, name); // Validate cron syntax before querying the target.
  if (apply) await requireBootstrapped(ctx);
  const identity = await schedulerIdentity(ctx);
  const line = cronLine(minutes, invocation, JOB, identity);

  log(`crontab entry (every ${interval}, runs on ${ctx.transport.description})`);
  info(line);
  info(`marked "${jobMarker(JOB, identity)}" — re-running this replaces only that line; backup uninstall removes only it`);
  if (ctx.transport.description.startsWith("ssh:")) {
    info(`assumes this deployment was mirrored to ${ctx.settings.remotePath} by ${commandLine("deploy")} (set OC_REMOTE_PATH if --path differed)`);
  }

  if (!apply) {
    info("add it yourself with `crontab -e`, or re-run with --apply to install it directly");
    return;
  }

  await guardedWith(ctx, "backup install --apply", takeover, async () => {
    await updateCrontab(ctx, JOB, identity, line, { name, invocation });
    log("installed");
  });
}

export async function backupUninstall(ctx: Context, values: UninstallValues): Promise<void> {
  const apply = values.apply === true;
  const takeover = takeoverOf(values);
  const support = schedulingSupport(ctx);
  const name = deploymentName();

  if (!support.supported) {
    warn(`no unattended schedule could have been installed on ${ctx.transport.description} in the first place: ${support.reason}`);
    await printUnschedulingInstructions(ctx, JOB, apply);
    return;
  }

  const identity = await schedulerIdentity(ctx);
  const invocation = await posixTargetInvocation(ctx, [JOB]);

  if (!apply) {
    info(`would remove the crontab entry marked "${jobMarker(JOB, identity)}" on ${ctx.transport.description}; re-run with --apply`);
    return;
  }

  await guardedWith(ctx, "backup uninstall --apply", takeover, async () => {
    if (!await updateCrontab(ctx, JOB, identity, undefined, { name, invocation })) {
      info(NOTHING_INSTALLED);
      return;
    }
    log("removed");
  });
}
