// `clawwright backup` — a consistent snapshot of the data directory.
//
// The gateway is stopped for the duration by default: OpenClaw keeps state in SQLite
// databases with multi-megabyte -wal files, and a copy taken mid-write is not restorable.
// --hot skips the stop for those who accept that.
//
// Split into four files: this one keeps the creation path (BACKUP_ARGUMENTS, createBackup
// and the dispatcher below); list.ts is the read-only archive/replaced-copy inventory;
// prune-replaced.ts is the explicit, --apply-gated cleanup of `<dataDir>.replaced-*` copies
// restore leaves behind; install.ts wires `clawwright backup` onto a schedule (crontab, or
// a printed/applyable `schtasks` entry on Windows). `list`/`prune-replaced`/`install`/
// `uninstall` are additional first positional actions; no action still creates an archive.

import { log, info, warn, die } from "#src/core/io/log.ts";

/** The quiescence and transaction messages the checks assert by name. */
export const BACKUP_REFUSED = "backup refused because recipe stack(s) could not be quiesced";

export const SIDECARS_RUNNING = "recipe stack(s) remain running during this transaction";

export const GATEWAY_LEFT_STOPPED = "leaving the gateway stopped";

import { emit, isCaptured } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import { parseRetention } from "#src/core/env.ts";
import { randomUUID } from "node:crypto";
import { runMaybePrivileged, sudoFor } from "#src/runtime/files/datadir.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import {
  archiveCarriesContent, archiveRoot, createArchive, dataDirName, excludesFor, fileSize, backupArchiveName,
  listArchive, parseBackupArchive, privilegePrefixFor, symlinkedDataRoot, PROFILE_SHORTHAND_FLAGS, type Profile,
} from "#src/service/archive/index.ts";
import { guardedWith } from "#src/runtime/lock/instance-lock.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import { runningRecipeStacks } from "#src/commands/management/recipe/index.ts";
import { quiesceRecipeStacks, resumeRecipeStacks } from "#src/commands/management/recipe/run/lifecycle.ts";
import type { Recipe } from "#src/service/recipe.ts";
import { verifySnapshot } from "#src/commands/lifecycle/verify.ts";
import type { BackupPurpose } from "#src/core/app.ts";
import {
  multiActionBody, defineAction, type ArgumentSpec, type PrepareCall, type Values,
} from "#src/core/command/spec.ts";
import { openclawCliJson } from "#src/service/openclaw-cli.ts";
import { PROFILE_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";
import { backupList, BACKUP_LIST_ARGUMENTS } from "./list.ts";
import { backupPruneReplaced, BACKUP_PRUNE_ARGUMENTS } from "./prune-replaced.ts";
import { backupInstall, backupUninstall, BACKUP_INSTALL_ARGUMENTS, BACKUP_UNINSTALL_ARGUMENTS } from "./install.ts";
import { buildBackupPlan, printBackupPlan } from "./plan.ts";

export { backupList, BACKUP_LIST_ARGUMENTS, JSON_ARGUMENT } from "./list.ts";
export { backupPruneReplaced, BACKUP_APPLY_ARGUMENT, BACKUP_PRUNE_ARGUMENTS } from "./prune-replaced.ts";
export { backupInstall, backupUninstall, BACKUP_INSTALL_ARGUMENTS, BACKUP_UNINSTALL_ARGUMENTS } from "./install.ts";

/** The creation path's own arguments (the default `create` action). --dry-run is a read:
 *  the preview touches nothing, so the call itself is one. */
export const BACKUP_ARGUMENTS = [
  PROFILE_ARGUMENT,
  {
    name: "hot",
    summary: "Do not stop the service",
    description: "Do not stop the service (risks a partial write)",
    kind: "flag",
  },
  {
    name: "native",
    summary: "Live consistent snapshot (full only)",
    description: "Consistent snapshot without stopping the gateway (full profile only); auth-secrets/ and anything OpenClaw's own backup omits are copied in, hot",
    kind: "flag",
  },
  { name: "share", summary: "Share profile, verified", description: "Shareable profile with verification (same as --profile share)", kind: "flag" },
  { name: "migrate", summary: "Migrate profile, no keys", description: "Migrate profile: no provider keys (same as --profile migrate)", kind: "flag" },
  { name: "with-secrets", summary: "Full profile with keys", description: "Full profile: includes provider keys (already backup's default)", kind: "flag" },
  { name: "dry-run", description: "What would happen", kind: "flag", effect: "read" },
] as const satisfies readonly ArgumentSpec[];

export interface BackupCreateValues extends Values<typeof BACKUP_ARGUMENTS> {}

/** --share/--migrate/--with-secrets and --profile set one field; the last one typed wins.
 *  PROFILE_BY_FLAG is PROFILE_SHORTHAND_FLAGS with keys without `--`. */
const PROFILE_BY_FLAG: ReadonlyMap<string, Profile> = new Map(
  [...PROFILE_SHORTHAND_FLAGS].map(([flag, profile]) => [flag.slice("--".length), profile]),
);

interface BackupCreatePlan {
  readonly options: BackupOptions;
  readonly dryRun: boolean;
}

/** The plan for a create: the profile decision and the native/full refusal (an arguments-and-
 *  values refusal, so it happens in prepare — before requireBootstrapped and the lock). */
function createPlan(call: PrepareCall<BackupCreateValues>): BackupCreatePlan {
  const values = call.values;
  const last = call.given.filter((name) => name === "profile" || PROFILE_BY_FLAG.has(name)).at(-1);
  const profile = last === undefined ? undefined : last === "profile" ? values.profile : PROFILE_BY_FLAG.get(last);
  if (values.native === true && (profile ?? "full") !== "full") {
    call.refuse("native", "--native only supports the full profile — migrate/share stay on the framework's own tar path");
  }
  return { options: { hot: values.hot === true, native: values.native === true, profile }, dryRun: values["dry-run"] === true };
}

/** The `--dry-run` branch of a create: the plan, printed or emitted, nothing else. */
async function previewBackup(ctx: Context, options: BackupOptions): Promise<void> {
  const plan = await buildBackupPlan(ctx, options);
  if (isCaptured()) {
    emit(`${JSON.stringify({ ok: plan.refusals.length === 0, changed: false, dryRun: true, ...plan }, null, 2)}\n`);
    return;
  }
  printBackupPlan(plan);
}

/** The whole command: no action word creates an archive; the four other actions manage
 *  backups. Declaration order is the action word's choices, `create` last — as the default
 *  it is merged first, so its flags lead the derived `arguments` view exactly as before. */
export const BACKUP = multiActionBody({
  effect: "change",
  action: { description: "Omit to create a backup; an action word lists or manages backups instead", summary: "Omit to create a backup" },
  defaultAction: "create",
  actions: {
    list: defineAction({ summary: "List archives and replaced copies", effect: "read", arguments: BACKUP_LIST_ARGUMENTS.map((argument) => argument.name === "json" ? { ...argument, summary: "Emit as JSON" } : argument), run: backupList }),
    "prune-replaced": defineAction({ summary: "Delete copies restore left aside", effect: "read", arguments: BACKUP_PRUNE_ARGUMENTS.map((argument) => argument.name === "json" ? { ...argument, summary: "Emit as JSON" } : argument), run: backupPruneReplaced }),
    install: defineAction({ summary: "Schedule a plain backup", effect: "read", arguments: BACKUP_INSTALL_ARGUMENTS, run: backupInstall }),
    uninstall: defineAction({ summary: "Remove the backup schedule", effect: "read", arguments: BACKUP_UNINSTALL_ARGUMENTS, run: backupUninstall }),
    create: defineAction({
      summary: "Create an archive",
      arguments: BACKUP_ARGUMENTS,
      prepare: (call) => createPlan(call),
      run: (ctx, plan) => (plan.dryRun ? previewBackup(ctx, plan.options) : createBackup(ctx, plan.options).then(() => {})),
    }),
  },
});

export interface BackupOptions {
  hot?: boolean;
  profile?: Profile;
  /** Skip the restart this would otherwise do once the archive is published. For a caller
   *  about to restore right back into the same data directory (smoke's round-trip check):
   *  restarting here just to have restore's own stop() stop it again a moment later reopens
   *  the write window pausing was meant to close. The caller restarts once its own
   *  transaction is done. */
  leaveStopped?: boolean;
  /** Consistent snapshot without stopping the gateway, via OpenClaw's own `backup create`
   *  in the running instance's sidecar instead of a raw tar over live state. Full profile
   *  only (see createNativeArchive). */
  native?: boolean;
  /** Why this archive is being created — see BackupPurpose. Defaults to "backup": the
   *  ordinary case, where the application's `afterBackup` (if declared) runs once the
   *  archive is published and rotated. Pass "internal" for a caller (smoke) whose archive
   *  only proves the backup/restore mechanism still works and is not a copy for a hook to
   *  act on. */
  purpose?: BackupPurpose;
}

/** Thrown when native mode cannot be attempted at all — the caller (createBackup itself for
 *  a direct `--native` request, and clawwright upgrade for its pre-upgrade backup) falls
 *  back to the classic stopped tar path rather than treating it as a hard failure. Any other
 *  error out of the native path is a real failure and propagates as-is. */
export class NativeBackupUnsupportedError extends Error {}

/** The pristine archive `openclaw backup create` wrote, kept inside the published archive at
 *  this name so restore can feed it back to `openclaw backup verify` before trusting the
 *  rest — see createNativeArchive and restore.ts. */
export const NATIVE_MANIFEST_NAME = ".clawwright-native-manifest.tar.gz";

// UTC, not local time: state.ts's snapshot names and restore.ts's <data>.replaced-<stamp>
// both already are, and local time would put a backup taken the same moment as a pull two
// hours apart by name on a UTC+2 host — correlating "which backup was this snapshot copied
// from" would mean doing the arithmetic by hand.
function timestamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

/** Deletes the single oldest archive beyond the configured retention count, if any.
 *  Exported for testing. */
export async function rotate(ctx: Context, backupDir: string): Promise<void> {
  const keep = parseRetention("OC_BACKUP_KEEP", ctx.settings.env.OC_BACKUP_KEEP, 10);
  if (keep <= 0) return;

  const prefix = await sudoFor(ctx, backupDir);
  // find returns success for an empty directory and a non-zero status for an unreadable one.
  // `ls glob 2>/dev/null` cannot distinguish those cases.
  const [head, ...rest] = [
    ...prefix,
    "find",
    backupDir,
    "-maxdepth",
    "1",
    "-type",
    "f",
    "-name",
    `${deploymentName()}-*.tar.gz`,
    "-printf",
    "%T@\\t%p\\n",
  ];
  const listing = await ctx.transport.exec(head, rest, { allowFailure: true });
  if (listing.code !== 0) throw new Error(`backup rotation could not list archives (exit ${listing.code})`);
  const archives = listing.stdout
    .split("\n")
    .flatMap((line) => {
      const separator = line.indexOf("\t");
      if (separator < 0) return [];
      const modified = Number(line.slice(0, separator));
      const path = line.slice(separator + 1);
      return Number.isFinite(modified) ? [{ path, modified }] : [];
    })
    .sort((left, right) => right.modified - left.modified)
    .map(({ path }) => path);

  // Retention is counted per profile, and anything the glob caught that is not one of this
  // deployment's own archives is dropped here. Both for the same reason: `keep` means "how
  // many backups of this instance I can still restore from", and neither a share snapshot
  // `pull` left behind nor a sibling deployment's archive is one of those. Counted together,
  // a week of `pull` runs rotated away every full backup the instance had.
  const byProfile = new Map<Profile, string[]>();
  for (const line of archives) {
    const path = line.trim();
    const parsed = parseBackupArchive(path.slice(path.lastIndexOf("/") + 1), deploymentName());
    if (parsed === undefined) continue;
    byProfile.set(parsed.profile, [...(byProfile.get(parsed.profile) ?? []), path]);
  }

  // The listing is sorted newest first and each group keeps that order; restore it across
  // groups so "the oldest" below is the oldest of all of them.
  const staleSet = new Set([...byProfile.values()].flatMap((group) => group.slice(keep)));
  const stale = archives.map((line) => line.trim()).filter((path) => staleSet.has(path));
  if (stale.length === 0) return;

  // Only the single oldest excess archive is removed per run, not the whole backlog at
  // once — however a backlog beyond keep got there (a lowered OC_BACKUP_KEEP, archives
  // merged in from elsewhere), it drains one backup at a time instead of vanishing here in
  // one rotation.
  const path = stale[stale.length - 1].trim();
  const name = path.slice(path.lastIndexOf("/") + 1);
  const remaining = stale.length - 1;
  log(`removing 1 archive beyond the last ${keep}${remaining > 0 ? ` (${remaining} more still beyond it)` : ""}:`);
  info(name);
  const removePrefix = await sudoFor(ctx, path);
  const [rmHead, ...rmRest] = [...removePrefix, "rm", "-f", path];
  const removed = await ctx.transport.exec(rmHead, rmRest, { allowFailure: true });
  if (removed.code !== 0) throw new Error(`backup rotation could not remove stale archive (exit ${removed.code})`);
}

/** Live files the set difference must never re-add: SQLite sidecars (a hot -wal/-shm/-journal
 *  beside the native point-in-time database would be replayed onto it on restore and corrupt
 *  it), Chromium profile locks, and this run's own native archive, which sits in config/
 *  while the difference is taken. */
const NEVER_COPY_LIVE = [/-(wal|shm|journal)$/, /(^|\/)Singleton(Lock|Cookie|Socket)$/, /(^|\/)\.clawwright-native-[^/]*\.tar\.gz$/];

export function omittedOnPurpose(relative: string): boolean {
  return NEVER_COPY_LIVE.some((pattern) => pattern.test(relative));
}

/** Paths, relative to their own root, of every file under `liveDir` that `assembledDir` does
 *  not have — either directory may not exist yet, and that reads as an empty listing rather
 *  than an error. */
async function missingRelativeFiles(ctx: Context, liveDir: string, assembledDir: string): Promise<string[]> {
  const listing = async (dir: string): Promise<Set<string>> => {
    if (!(await ctx.transport.exists(dir))) return new Set();
    const prefix = await sudoFor(ctx, dir);
    const [head, ...rest] = [...prefix, "find", dir, "-type", "f", "-printf", "%P\\n"];
    const result = await ctx.transport.exec(head, rest, { allowFailure: true });
    if (result.code !== 0) throw new Error(`could not list ${dir} (exit ${result.code})`);
    return new Set(result.stdout.split("\n").filter((line) => line !== ""));
  };
  const [live, assembled] = await Promise.all([listing(liveDir), listing(assembledDir)]);
  return [...live].filter((relative) => !assembled.has(relative) && !omittedOnPurpose(relative));
}

/** Copies whatever `openclaw backup create` left out of its own payload — in the pinned
 *  image, every session transcript under `agents/<id>/sessions/` (dir listed, `.jsonl`/`.log`
 *  files excluded by upstream design). Computed as the live/native set difference, never a
 *  hardcoded name, so an image change in either direction stays covered.
 *
 *  These are live, append-only logs copied while the gateway keeps writing — a trailing
 *  partial line in the newest one is possible. The instance's SQLite state is unaffected:
 *  that part came from OpenClaw's own point-in-time mechanism, not this copy. Returns how
 *  many files were added. */
async function copyOmittedLiveFiles(ctx: Context, liveDir: string, assembledDir: string): Promise<number> {
  const missing = await missingRelativeFiles(ctx, liveDir, assembledDir);
  for (const relative of missing) {
    const destination = `${assembledDir}/${relative}`;
    const destinationDir = destination.slice(0, destination.lastIndexOf("/"));
    await runMaybePrivileged(ctx, destinationDir, "mkdir", ["-p", destinationDir]);
    await runMaybePrivileged(ctx, destination, "cp", ["-p", "--", `${liveDir}/${relative}`, destination]);
  }
  return missing.length;
}

/** Runs `openclaw backup create --verify` inside the sidecar and reshapes its output into
 *  the classic archive layout (root = data directory name) at `stagingArchive`, so rotate(),
 *  newestArchive() and restore need no native-specific case.
 *
 *  auth-secrets/ lives outside $OPENCLAW_STATE_DIR (a separate bind mount) so it is copied in
 *  directly from the live target — safe while the gateway runs since it is static key
 *  material. The pristine OpenClaw archive is embedded at NATIVE_MANIFEST_NAME so restore can
 *  re-verify it with `openclaw backup verify` before trusting the rest.
 *
 *  Failures asking OpenClaw for the archive become NativeBackupUnsupportedError, so callers
 *  fall back to the classic path; a failure in the reshape itself propagates unchanged. */
async function createNativeArchive(
  ctx: Context,
  stagingDir: string,
  stagingArchive: string,
  name: string,
  compensationErrors: unknown[],
): Promise<void> {
  const { dataDir } = ctx.settings;
  const nativeTarget = `${dataDir}/config/.clawwright-native-${randomUUID()}.tar.gz`;
  let containerOutput: string;
  try {
    containerOutput = ctx.paths.toContainer(nativeTarget);
  } catch (error) {
    throw new NativeBackupUnsupportedError(`${ctx.runtime.description} cannot address ${nativeTarget} inside the sidecar: ${(error as Error).message}`);
  }

  // Until the mv into staging, a full archive (credentials included) sits in the live data
  // directory; any failure below must not leave it there.
  let nativeArchive = nativeTarget;
  let movedIntoStaging = false;
  try {
    let outcome: { verified?: boolean; archivePath?: string };
    try {
      outcome = await openclawCliJson(ctx, ["backup", "create", "--verify", "--json", "--output", containerOutput]);
    } catch (error) {
      throw new NativeBackupUnsupportedError((error as Error).message);
    }
    if (outcome.archivePath !== undefined) nativeArchive = ctx.paths.fromContainer(outcome.archivePath);
    if (outcome.verified !== true) throw new Error("openclaw backup create did not report a verified archive");

    const nativeEntries = await listArchive(ctx, nativeArchive);
    const nativeRoot = archiveRoot(nativeEntries);
    const nativeWorkdir = `${stagingDir}/native`;
    const payload = `${nativeWorkdir}/${nativeRoot}/payload/posix/home/node/.openclaw`;
    const assembled = `${stagingDir}/${name}`;

    await runMaybePrivileged(ctx, nativeWorkdir, "mkdir", ["-p", nativeWorkdir]);
    const extractPrefix = await sudoFor(ctx, nativeArchive);
    const [exHead, ...exRest] = [...extractPrefix, "tar", "--numeric-owner", "-xzf", nativeArchive, "-C", nativeWorkdir];
    await ctx.transport.exec(exHead, exRest);
    if (!(await ctx.transport.exists(payload))) {
      throw new Error(`native archive ${nativeArchive} carries no ${nativeRoot}/payload/posix/home/node/.openclaw`);
    }

    await runMaybePrivileged(ctx, assembled, "mkdir", ["-p", assembled]);
    await runMaybePrivileged(ctx, assembled, "mv", [payload, `${assembled}/config`]);
    const nestedWorkspace = `${assembled}/config/workspace`;
    if (await ctx.transport.exists(nestedWorkspace)) {
      await runMaybePrivileged(ctx, assembled, "mv", [nestedWorkspace, `${assembled}/workspace`]);
    }

    const omitted = await copyOmittedLiveFiles(ctx, `${dataDir}/config`, `${assembled}/config`)
      + await copyOmittedLiveFiles(ctx, `${dataDir}/workspace`, `${assembled}/workspace`);
    if (omitted > 0) {
      log(`copied ${omitted} file(s) present live but left out of openclaw's own backup (e.g. session transcripts)`);
    }

    if (await ctx.transport.exists(`${dataDir}/auth-secrets`)) {
      await runMaybePrivileged(ctx, assembled, "cp", ["-a", `${dataDir}/auth-secrets`, `${assembled}/auth-secrets`]);
    }
    await runMaybePrivileged(ctx, assembled, "mv", [nativeArchive, `${assembled}/${NATIVE_MANIFEST_NAME}`]);
    movedIntoStaging = true;

    const excludeArgs = excludesFor("full", name).map((pattern) => `--exclude=${pattern}`);
    const packPrefix = await privilegePrefixFor(ctx, [`${assembled}/auth-secrets`, assembled], stagingArchive);
    const [head, ...rest] = [...packPrefix, "tar", "--numeric-owner", ...excludeArgs, "-czf", stagingArchive, "-C", stagingDir, name];
    await ctx.transport.exec(head, rest);
  } finally {
    // A removal failure is reported alongside the error in flight, never instead of it.
    if (!movedIntoStaging) {
      try {
        if (await ctx.transport.exists(nativeArchive)) {
          await runMaybePrivileged(ctx, nativeArchive, "rm", ["-f", "--", nativeArchive]);
        }
      } catch (error) {
        compensationErrors.push(new Error(`could not remove native archive left in the live data directory: ${nativeArchive}`, { cause: error }));
      }
    }
  }
}

/** Creates a backup and returns the archive path on the target.
 *
 *  Guarded like every other mutating command: it stops the gateway, archives the data
 *  directory, and starts it again, all of which race against apply/restore/rollback doing
 *  the same instance's work at once if nothing serializes them. guardedWith() is nesting-safe,
 *  so pull() and smoke() calling this while already holding the lock for their own
 *  operation cost nothing extra here. */
export async function createBackup(ctx: Context, options: BackupOptions = {}): Promise<string> {
  await requireBootstrapped(ctx);
  // No --break-lock support: its own parser (backup() below) rejects it, so a refusal here
  // must not offer a flag it will then reject as unknown.
  return guardedWith(ctx, "backup", { breakLock: false }, () => createBackupLocked(ctx, options), { breakLockSupported: false });
}

async function createBackupLocked(ctx: Context, options: BackupOptions): Promise<string> {
  const profile: Profile = options.profile ?? "full";
  const { dataDir, backupDir } = ctx.settings;

  await validateBackupTarget(ctx, options, profile, dataDir, backupDir);

  const archive = `${backupDir}/${backupArchiveName(deploymentName(), timestamp(), profile)}`;
  // Keep the archive in a private directory until it is complete. The final name must only
  // appear after tar and chmod succeed, so a failed tar cannot become the newest backup.
  const stagingDir = `${backupDir}/.clawwright-backup-${randomUUID()}`;
  const stagingArchive = `${stagingDir}/archive.tar.gz`;

  await runBackupTransaction(ctx, options, profile, dataDir, backupDir, archive, stagingDir, stagingArchive);

  return reportBackupCreated(ctx, archive, profile, backupDir, options);
}

/** Validate/prepare phase: refuses a request the rest of createBackupLocked cannot honor
 *  (native+non-full, a missing or symlinked data directory) and ensures the backup
 *  directory exists. Nothing is stopped yet — a die() here leaves the instance untouched. */
async function validateBackupTarget(ctx: Context, options: BackupOptions, profile: Profile, dataDir: string, backupDir: string): Promise<void> {
  if (options.native === true && profile !== "full") {
    die("--native only supports the full profile — migrate/share stay on the framework's own tar path");
  }

  if (!(await ctx.transport.exists(dataDir))) die(`data directory ${dataDir} does not exist`);

  // tar is handed the data directory's name relative to its parent, so a symlinked root
  // archives as the link itself — one entry, no data, a "successful" backup that restores
  // nowhere. Refused before the gateway stops: there is no consistent snapshot to take.
  const linkTarget = await symlinkedDataRoot(ctx);
  if (linkTarget !== undefined) {
    die(
      `data directory ${dataDir} is a symlink to ${linkTarget}: a backup would archive the link itself, not the data behind it — ` +
        `point the data directory setting at a real directory (the link's target is one) and run the backup again`,
    );
  }

  const mkdirPrefix = await sudoFor(ctx, backupDir);
  const [mkHead, ...mkRest] = [...mkdirPrefix, "mkdir", "-p", backupDir];
  await ctx.transport.exec(mkHead, mkRest);
}

/** Marks whether the staging directory was created, so settleBackupTransaction's cleanup
 *  runs only once there is something to clean up — set by writeAndPublishArchive as it
 *  progresses, read after it returns or throws. */
interface BackupProgress {
  stagingCreated: boolean;
}

/** Act phase (creation half): stops the gateway (unless hot/native), quiesces recipe
 *  stacks, writes the archive to staging, verifies it, and publishes it under its final
 *  name. Throws on any failure; settleBackupTransaction cleans up regardless. */
async function writeAndPublishArchive(
  ctx: Context,
  options: BackupOptions,
  profile: Profile,
  wasRunning: boolean,
  dataDir: string,
  backupDir: string,
  archive: string,
  stagingDir: string,
  stagingArchive: string,
  quiesced: Recipe[],
  compensationErrors: unknown[],
  progress: BackupProgress,
): Promise<void> {
  if (options.native === true) {
    log("native backup: OpenClaw's own point-in-time mechanism — the gateway keeps running throughout");
  } else if (options.hot === true) {
    warn("hot backup: the gateway keeps writing, the archive may catch a partial sqlite write");
  } else if (wasRunning) {
    log("stopping the gateway for a consistent snapshot");
    await ctx.runtime.pause();
  }

  // Every operation after pause, including sidecar discovery, belongs to this
  // compensation scope: discovery and hook loading can both fail. Native never pauses in
  // the first place, so quiescing recipe stacks buys it nothing either — same reasoning
  // --hot already applies below.
  const sidecars = await runningRecipeStacks(ctx);
  if (options.hot !== true && options.native !== true && options.leaveStopped !== true && sidecars.length > 0) {
    const outcome = await quiesceRecipeStacks(ctx, sidecars);
    quiesced.push(...outcome.quiesced);
    if (outcome.unquiesced.length > 0) {
      throw new Error(
        `${BACKUP_REFUSED}: ${outcome.unquiesced.map((recipe) => recipe.name).join(", ")}`,
      );
    }
  } else if (sidecars.length > 0) {
    warn(`${SIDECARS_RUNNING}: ${sidecars.map((recipe) => recipe.name).join(", ")}`);
  }

  log(`writing ${archive}`);
  const mkdirStagePrefix = await sudoFor(ctx, backupDir);
  const [mkdirStageHead, ...mkdirStageRest] = [...mkdirStagePrefix, "mkdir", "-m", "700", "--", stagingDir];
  await ctx.transport.exec(mkdirStageHead, mkdirStageRest);
  progress.stagingCreated = true;

  if (options.native === true) {
    await createNativeArchive(ctx, stagingDir, stagingArchive, dataDirName(dataDir), compensationErrors);
  } else {
    await createArchive(ctx, { archive: stagingArchive, profile });
  }
  // tar exiting 0 and the file landing are not evidence the data is inside: a symlinked
  // root can produce an archive that holds nothing beneath its root, which restores
  // nothing anywhere. Checked on the staging archive, before it can become the newest
  // backup.
  if (!archiveCarriesContent(await listArchive(ctx, stagingArchive))) {
    throw new Error(`the fresh archive of ${dataDir} carries no data beneath its root — refusing to publish it as a backup`);
  }
  if (profile !== "full" && !(await verifySnapshot(ctx, stagingArchive, profile))) {
    throw new Error(`the fresh '${profile}' backup failed its privacy check — refusing to publish it`);
  }

  const chmodPrefix = await sudoFor(ctx, stagingArchive);
  const [chHead, ...chRest] = [...chmodPrefix, "chmod", "600", stagingArchive];
  await ctx.transport.exec(chHead, chRest);

  const movePrefix = await sudoFor(ctx, archive);
  const [moveHead, ...moveRest] = [...movePrefix, "mv", "-nT", "--", stagingArchive, archive];
  const moved = await ctx.transport.exec(moveHead, moveRest, { allowFailure: true });
  if (moved.code !== 0) {
    throw new Error(`could not publish ${archive}: ${moved.stderr.trim() || `mv exited ${moved.code}`}`);
  }

  const remaining = await targetExists(ctx, stagingArchive);
  if (remaining) throw new Error(`backup path already exists: ${archive}`);
  if (!(await targetExists(ctx, archive))) {
    throw new Error(`could not confirm publication of ${archive}`);
  }
}

/** Act phase (settle half): always runs after writeAndPublishArchive, success or failure —
 *  removes the staging directory, restarts the gateway if this transaction stopped it, and
 *  resumes any quiesced recipe stacks. Compensation failures accumulate; they never replace
 *  the original error. */
async function settleBackupTransaction(
  ctx: Context,
  options: BackupOptions,
  wasRunning: boolean,
  stagingCreated: boolean,
  stagingDir: string,
  quiesced: Recipe[],
  compensationErrors: unknown[],
): Promise<void> {
  if (stagingCreated) {
    try {
      await runMaybePrivileged(ctx, stagingDir, "rm", ["-rf", "--", stagingDir]);
    } catch (error) {
      compensationErrors.push(new Error(`could not remove backup staging directory ${stagingDir}`, { cause: error }));
    }
  }
  if (options.hot !== true && options.native !== true && wasRunning && options.leaveStopped !== true) {
    try {
      log("starting the gateway again");
      await ctx.runtime.start();
      await ctx.runtime.waitForHealth();
      log("gateway is healthy");
    } catch (error) {
      compensationErrors.push(new Error("backup could not restore the gateway to its running state", { cause: error }));
    }
  } else if (options.leaveStopped === true && wasRunning) {
    info(`${GATEWAY_LEFT_STOPPED} — the caller restarts it once its own transaction is done`);
  }
  if (quiesced.length > 0) compensationErrors.push(...await resumeRecipeStacks(ctx, quiesced));
}

/** Act phase: orchestrates writeAndPublishArchive and settleBackupTransaction, and turns
 *  their combined outcome into the one thrown error (or none) the caller sees. */
async function runBackupTransaction(
  ctx: Context,
  options: BackupOptions,
  profile: Profile,
  dataDir: string,
  backupDir: string,
  archive: string,
  stagingDir: string,
  stagingArchive: string,
): Promise<void> {
  const wasRunning = await ctx.runtime.isRunning();
  const quiesced: Recipe[] = [];
  const progress: BackupProgress = { stagingCreated: false };
  let resultError: unknown;
  // Shared with createNativeArchive, whose cleanup failures are compensations too.
  const compensationErrors: unknown[] = [];

  try {
    await writeAndPublishArchive(ctx, options, profile, wasRunning, dataDir, backupDir, archive, stagingDir, stagingArchive, quiesced, compensationErrors, progress);
  } catch (error) {
    resultError = error;
  }

  await settleBackupTransaction(ctx, options, wasRunning, progress.stagingCreated, stagingDir, quiesced, compensationErrors);

  if (resultError !== undefined && compensationErrors.length > 0) {
    throw new AggregateError([resultError, ...compensationErrors], "backup failed and compensation also failed");
  }
  if (resultError !== undefined) throw resultError;
  if (compensationErrors.length > 0) throw new AggregateError(compensationErrors, "backup completed but compensation failed");
}

/** Verify/report phase: announces the published archive, rotates old ones, and runs the
 *  application's afterBackup hook (if declared). Runs only once runBackupTransaction has
 *  succeeded. */
async function reportBackupCreated(ctx: Context, archive: string, profile: Profile, backupDir: string, options: BackupOptions): Promise<string> {
  log(`backup done: ${archive} (${await fileSize(ctx, archive)}, profile: ${profile})`);
  await rotate(ctx, backupDir);

  // Runs after the archive is fully published and rotated — never before, so a hook never
  // sees a path that could still turn out to be staging. A hook failure must not read as
  // the backup itself failing: the archive stays exactly where it landed, and the caller
  // gets a distinct, actionable error instead of a deleted or hidden backup.
  const purpose = options.purpose ?? "backup";
  if (purpose !== "internal" && ctx.applicationAfterBackup !== undefined) {
    try {
      await ctx.applicationAfterBackup({ archive, profile, purpose });
    } catch (error) {
      die(`backup published at ${archive}, afterBackup hook failed: ${(error as Error).message}`);
    }
  }
  return archive;
}

/** Checks a target path with the privileges used for the backup operation. */
async function targetExists(ctx: Context, path: string): Promise<boolean> {
  const prefix = await sudoFor(ctx, path);
  const [head, ...rest] = [...prefix, "test", "-e", path];
  const result = await ctx.transport.exec(head, rest, { allowFailure: true });
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(`could not check backup path ${path} (exit ${result.code})`);
}

