// `destroy`: removes what `bootstrap` created, with its removal-safety guards.

import { log, info, die } from "#src/core/io/log.ts";
import { humanSize } from "#src/core/io/size.ts";
import { NotBootstrapped } from "#src/runtime/runtime.ts";
import type { Context } from "#src/core/context.ts";
import { guardedWith } from "#src/runtime/lock/instance-lock.ts";
import { deploymentName, composeProjectName } from "#src/runtime/deployment.ts";
import { answeredProbe, sudoFor, sudoForRead } from "#src/runtime/files/datadir.ts";
import { commandBody, type ArgumentSpec, type Values } from "#src/core/command/spec.ts";
import { LOCK_TAKEOVER_ARGUMENTS, takeoverOf } from "#src/commands/interface/groups/shared-arguments.ts";
import * as kinds from "#src/core/values/kinds.ts";

/** --data/--backups/--snapshots name one of the three directories this deployment declares —
 *  never a free-form path — so "only remove what the deployment itself declared" is
 *  structural, not a check against user input. Default is a dry run (--yes performs it). */
export const DESTROY_ARGUMENTS = [
  {
    name: "data",
    summary: "Remove data directory",
    description: "Remove data directory (OC_DATA_DIR)",
    kind: "flag",
  },
  {
    name: "backups",
    summary: "Remove backup directory",
    description: "Remove backup directory (OC_BACKUP_DIR)",
    kind: "flag",
  },
  {
    name: "snapshots",
    summary: "Remove snapshot directory",
    description: "Remove snapshot directory (OC_SNAPSHOT_DIR)",
    kind: "flag",
  },
  { name: "yes", summary: "Perform the removal", description: "Perform the removal instead of a dry run", kind: "flag", effect: "destroy" },
  { name: "confirm-name", summary: "Deployment name", description: "Confirms the deployment's own name", kind: "option", valueName: "name", value: kinds.name("deployment", "read") },
  ...LOCK_TAKEOVER_ARGUMENTS,
] as const satisfies readonly ArgumentSpec[];

interface DestroyTarget {
  readonly flag: "data" | "backups" | "snapshots";
  readonly envName: string;
  readonly path: string;
}

/** Fixed order (data, backups, snapshots) regardless of flag order on the command line —
 *  what a check can assert against and what the plan prints in. */
function destroyTargets(ctx: Context, values: DestroyValues): DestroyTarget[] {
  const targets: DestroyTarget[] = [];
  if (values.data === true) targets.push({ flag: "data", envName: "OC_DATA_DIR", path: ctx.settings.dataDir });
  if (values.backups === true) targets.push({ flag: "backups", envName: "OC_BACKUP_DIR", path: ctx.settings.backupDir });
  if (values.snapshots === true) targets.push({ flag: "snapshots", envName: "OC_SNAPSHOT_DIR", path: ctx.settings.snapshotDir });
  return targets;
}

// A depth-2-or-more path can still BE a home directory (/home/alice), which core/env.ts's
// own OC_DATA_DIR floor lets through on purpose (see assertSafeDataDir) — destroy is more
// destructive than a chown, so it refuses this shape explicitly instead of relying on depth
// alone.
const HOME_SHAPED = /^(\/home\/[^/]+|\/root|\/Users\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)\/?$/i;

/** String-level safety for a path about to be `rm -rf`'d: the same depth floor
 *  core/env.ts's assertSafeDataDir applies to OC_DATA_DIR alone, extended here to
 *  OC_BACKUP_DIR/OC_SNAPSHOT_DIR (toSettings never validates either) and to the
 *  home-directory shape a depth floor alone does not catch. */
function assertSafeRemovalShape(target: DestroyTarget): void {
  const { path, envName } = target;
  const isPosixRoot = path.startsWith("/");
  const isWindowsRoot = /^[A-Za-z]:[\\/]/.test(path);
  const isFilesystemRoot = path === "/" || /^[A-Za-z]:[\\/]$/.test(path);
  if (!isPosixRoot && !isWindowsRoot) die(`${envName} "${path}" is not an absolute path — refusing to remove it`);
  if (/[\\/]{2,}/.test(path) || (!isFilesystemRoot && /[\\/]$/.test(path))) {
    die(`${envName} "${path}" is not a normalized path — refusing to remove it`);
  }
  if (path.includes("/") && path.includes("\\")) die(`${envName} "${path}" mixes path separators — refusing to remove it`);
  const segments = path.split(/[\\/]+/).slice(1).filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    die(`${envName} "${path}" contains a "." or ".." segment — refusing to remove it`);
  }
  if (segments.length < 2) die(`${envName} "${path}" is a top-level directory — refusing to remove it`);
  if (HOME_SHAPED.test(path)) die(`${envName} "${path}" looks like a home directory — refusing to remove it`);
}

/** Keep the physical parent as cwd from verification through deletion. */
export const SAFE_DESTROY_SCRIPT = [
  "target=$1; mode=$2",
  "fail() { printf '%s\\n' \"$1\" >&2; exit 1; }",
  "case $target in /*) ;; *) fail 'target is not a POSIX absolute path' ;; esac",
  "case $mode in verify|remove) ;; *) fail 'invalid removal mode' ;; esac",
  "parent=${target%/*}; name=${target##*/}",
  "[ -n \"$parent\" ] || parent=/",
  "[ -n \"$name\" ] || fail 'target basename is empty'",
  "command -v readlink >/dev/null 2>&1 || fail 'readlink is unavailable'",
  "probe=$(readlink -e -- / 2>/dev/null) || fail 'readlink -e is unavailable'",
  "[ \"$probe\" = / ] || fail 'readlink -e is unavailable'",
  "command -v rm >/dev/null 2>&1 || fail 'rm is unavailable'",
  "physical=$(readlink -e -- \"$parent\") || fail 'parent cannot be resolved'",
  "[ \"$physical\" = \"$parent\" ] || fail 'parent resolves through a symlink'",
  "cd -P -- \"$parent\" || fail 'parent cannot be entered'",
  "physical=$(pwd -P) || fail 'parent cannot be resolved after entry'",
  "[ \"$physical\" = \"$parent\" ] || fail 'parent changed during verification'",
  "if test -L \"./$name\"; then fail 'target is a symlink'; else code=$?; [ \"$code\" -eq 1 ] || fail 'target link test failed'; fi",
  "if test -e \"./$name\"; then",
  "  physical=$(readlink -e -- \"./$name\") || fail 'target cannot be resolved'",
  "  [ \"$physical\" = \"$target\" ] || fail 'target resolves through a symlink'",
  "else",
  "  code=$?; [ \"$code\" -eq 1 ] || fail 'target existence test failed'",
  "  exit 0",
  "fi",
  "[ \"$mode\" = remove ] || exit 0",
  "physical=$(pwd -P) || fail 'parent cannot be resolved before removal'",
  "[ \"$physical\" = \"$parent\" ] || fail 'parent changed before removal'",
  "rm -rf -- \"./$name\"",
].join("\n");

interface PreparedDestroyTarget {
  readonly target: DestroyTarget;
  readonly prefix: readonly string[];
}

async function prepareDestroyTarget(ctx: Context, target: DestroyTarget): Promise<PreparedDestroyTarget> {
  const parent = target.path.slice(0, target.path.lastIndexOf("/")) || "/";
  const parentExecutable = (await answeredProbe(ctx, "test", ["-x", parent], [0, 1])).code === 0;
  const present = await ctx.transport.exists(target.path);
  const targetAccessible = !present ||
    (await answeredProbe(ctx, "test", ["-w", target.path], [0, 1])).code === 0 &&
    (await answeredProbe(ctx, "test", ["-x", target.path], [0, 1])).code === 0;
  return { target, prefix: await sudoFor(ctx, parent, { force: !parentExecutable || !targetAccessible }) };
}

async function verifyOrRemoveTarget(ctx: Context, prepared: PreparedDestroyTarget, mode: "verify" | "remove"): Promise<void> {
  const { target, prefix } = prepared;
  const [head, ...rest] = [...prefix, "sh", "-s", "--", target.path, mode];
  const result = await ctx.transport.exec(head, rest, { allowFailure: true, input: SAFE_DESTROY_SCRIPT });
  if (result.code !== 0) {
    die(`${target.envName} "${target.path}" ${mode === "remove" ? "could not be removed" : "could not be verified"} safely: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
}

async function sizeReport(ctx: Context, path: string): Promise<string> {
  if (!(await ctx.transport.exists(path))) return "absent";
  const prefix = await sudoForRead(ctx, path);
  const [head, ...rest] = [...prefix, "du", "-sk", path];
  const result = await ctx.transport.exec(head, rest, { allowFailure: true });
  const kb = Number(result.stdout.trim().split(/\s+/)[0]);
  return result.code === 0 && Number.isFinite(kb) ? humanSize(kb * 1024) : "unknown size";
}

async function printDestroyPlan(ctx: Context, targets: DestroyTarget[], bootstrapped: boolean, anyPresent: boolean): Promise<void> {
  if (bootstrapped) {
    log(`containers, network and volumes of ${composeProjectName()} — would stop and remove:`);
    await ctx.runtime.showStatus();
  } else log(NEVER_BOOTSTRAPPED);
  for (const target of bootstrapped ? targets : targets.filter((entry) => entry.flag !== "data")) {
    const size = await sizeReport(ctx, target.path);
    info(size === "absent" ? `${target.path} (${target.envName}) absent — nothing to remove` : `${WOULD_REMOVE} ${target.path} (${target.envName}, ${size})`);
  }
  if (targets.length === 0 && bootstrapped) {
    info("no --data/--backups/--snapshots given — only the containers/network/volumes above would go");
  }
  if (!bootstrapped && !anyPresent) info(DRY_RUN_NOTHING_TO_REMOVE);
  else info(DRY_RUN_REAL_RUN_HINT);
}

export const WOULD_REMOVE = "would remove";
export const DRY_RUN_NOTHING_TO_REMOVE = "dry run — nothing to remove";
export const DRY_RUN_REAL_RUN_HINT = "dry run — nothing removed. Pass --yes and --confirm-name <deployment name> for a real run";
export const NEVER_BOOTSTRAPPED = "nothing to destroy: never bootstrapped — no containers, network, volumes or data directory";

/** containers/network/volumes first, always (when bootstrapped); the declared directories
 *  after, in destroyTargets' fixed order. */
async function destroyLocked(ctx: Context, targets: PreparedDestroyTarget[], bootstrapped = true): Promise<void> {
  if (bootstrapped) {
    log(`stopping and removing containers, network and volumes of ${composeProjectName()}`);
    await ctx.runtime.stop(["-v"]);
  } else log(NEVER_BOOTSTRAPPED);
  for (const prepared of targets) {
    const { target } = prepared;
    log(`removing ${target.path}`);
    await verifyOrRemoveTarget(ctx, prepared, "remove");
  }
}

interface DestroyValues extends Values<typeof DESTROY_ARGUMENTS> {}

export function confirmNameMismatch(confirmName: string): string {
  return `--confirm-name "${confirmName}" does not match this deployment's name "${deploymentName()}"`;
}
interface DestroyPlan extends DestroyValues {
  /** Set only when a real run was asked for and the name matched. */
  readonly confirmName?: string;
}

/** Removes what `bootstrap` created. Default is a dry run: prints the plan and exits 0,
 *  nothing touched. A real run needs `--yes` AND `--confirm-name <deployment name>` — two
 *  independent typo-proofs, since this is the one command that can take an instance's data
 *  with it. Never touches the deployment directory itself (.env, config/, recipes/,
 *  secrets/) — that is `remove-app`'s job, one layer up, repository-side.
 *
 *  No operation record: Journal writes into `${dataDir}/clawwright-operations`, which
 *  `--data` is about to remove along with everything else in the tree — recording a
 *  destruction inside the thing being destroyed answers nothing a later reader could use. */
export const DESTROY = commandBody({
  effect: "read",
  arguments: DESTROY_ARGUMENTS,
  rules: [
    { rule: "requires", name: "yes", with: ["confirm-name"], reason: "so a typo cannot remove the wrong instance" },
  ],
  prepare(call): DestroyPlan {
    const values = call.values as DestroyValues;
    // Presence (--yes needs --confirm-name) is the declared rule above, refused at parse on
    // every surface; here only the value has to match the deployment's own name. Shape
    // guards below stay in run — they read the deployment's settings.
    if (values.yes === true) {
      const confirmName = values["confirm-name"] ?? "";
      if (confirmName !== deploymentName()) {
        call.refuse("confirm-name", confirmNameMismatch(confirmName));
      }
      return { ...values, confirmName };
    }
    return { ...values };
  },
  async run(ctx, plan) {
    const targets = destroyTargets(ctx, plan);
    for (const target of targets) assertSafeRemovalShape(target);

    // Never bootstrapped: no instance or lock home exists — only the independent dirs can be there.
    const bootstrapped = await ctx.runtime.isRunning().then(() => true, (error) => {
      if (error instanceof NotBootstrapped) return false;
      throw error;
    });

    if (plan.confirmName === undefined) {
      // An absent target is reported absent without any privilege probe.
      let anyPresent = false;
      for (const target of targets) {
        if (!(await ctx.transport.exists(target.path))) continue;
        anyPresent = true;
        await verifyOrRemoveTarget(ctx, await prepareDestroyTarget(ctx, target), "verify");
      }
      await printDestroyPlan(ctx, targets, bootstrapped, anyPresent);
      return;
    }

    const present = bootstrapped ? targets : [];
    if (!bootstrapped) for (const target of targets) if (await ctx.transport.exists(target.path)) present.push(target);
    const prepared = await Promise.all(present.map((target) => prepareDestroyTarget(ctx, target)));
    for (const target of prepared) await verifyOrRemoveTarget(ctx, target, "verify");

    if (bootstrapped) await guardedWith(ctx, "destroy", takeoverOf(plan), () => destroyLocked(ctx, prepared));
    else await destroyLocked(ctx, prepared, false);
  },
});
