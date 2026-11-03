// `clawwright restore` — puts an archive back onto the instance.
//
// Two properties matter and are preserved:
//   - the current data is moved aside, never deleted, so a wrong restore is recoverable
//   - the archive is validated BEFORE anything is stopped or overwritten

import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { log, info, warn, die } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit, withOutputSink } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import { DATA_SUBDIRS, OWNER, ensureDataDirs, sudoFor, runMaybePrivileged, needsOwnerEscalation, answeredProbe, assertCanonicalAncestry, physicalPath } from "#src/runtime/files/datadir.ts";
import {
  archiveRoot,
  inspectArchive,
  dataDirName,
  dataDirParent,
  extractArchive,
  listArchive,
  listArchiveLinks,
  parseBackupArchive,
  listBackupArchives,
  replacedCopyName,
  reportableProblems,
} from "#src/service/archive/index.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { openclawCli } from "#src/service/openclaw-cli.ts";
import { NATIVE_MANIFEST_NAME } from "#src/commands/lifecycle/backup/index.ts";
import { buildRestorePlan, printRestorePlan } from "./plan.ts";
import { preflightSecrets, MissingSecretsError } from "#src/commands/management/configuration/secrets.ts";
import {
  importRestoredPrivatePathsHistory,
  mutatePrivatePathsLedgerState,
  persistedPrivatePaths,
  privatePathsHistoryFile,
  privatePathsLedgerFile,
  privatePathsLedgerState,
  removePrivatePathsLedger,
  type PrivatePathsLedgerState,
} from "#src/security/privacy/private-paths-ledger.ts";
import { runningRecipeStacks } from "#src/commands/management/recipe/index.ts";
import type { Recipe } from "#src/service/recipe.ts";
import { commandBody, type ArgumentSpec } from "#src/core/command/spec.ts";
import { guardedWith } from "#src/runtime/lock/instance-lock.ts";
import { FORCE_ARGUMENT, LOCK_TAKEOVER_ARGUMENTS, takeoverOf } from "#src/commands/interface/groups/shared-arguments.ts";
import * as kinds from "#src/core/values/kinds.ts";

export const RESTORE_ARGUMENTS = [
  { name: "archive", description: "Archive; newest if omitted", kind: "positional", value: kinds.text("path to the archive on the target", { leadingDash: "refuse" }) },
  { ...FORCE_ARGUMENT, setByConfirm: true },
  ...LOCK_TAKEOVER_ARGUMENTS,
  {
    name: "fresh-identity",
    summary: "Drop identity and paired devices",
    description: "Drop identity and paired devices (cloning, not moving)",
    kind: "flag",
  },
  { name: "no-start", summary: "Leave it stopped", description: "Leave the service stopped afterwards", kind: "flag" },
  { name: "dry-run", description: "What would happen", kind: "flag", effect: "read" },
  { name: "json", summary: "Emit restored data and the gateway startup outcome as JSON", description: "Emit restored data and actual gateway startup outcome as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

export interface RestoreOptions {
  force?: boolean;
  freshIdentity?: boolean;
  /** Leave the gateway stopped. Needed when credentials still have to be installed: the
   *  restored config references env variables, and the gateway refuses to start without
   *  them — it crash-loops on SecretRefResolutionError instead. */
  noStart?: boolean;
  /** Set by an internal caller (smoke's round-trip check) restoring into a scratch root
   *  that only proves the mechanism still works — never a hook subject, so the
   *  application's `beforeRestore` (if declared) is skipped. Ordinary callers never pass
   *  this. */
  internal?: boolean;
}

/** Data restoration and gateway startup are separate outcomes. */
export type RestoreOutcome =
  | { restored: true; started: true }
  | { restored: true; started: false; reason: "no-start" | "missing-secrets"; nextAction: string };

/** `backupArchiveName`'s stamp (`YYYYMMDD-HHMMSS`, always UTC — see backup/index.ts's
 *  timestamp()) as a readable date, for the pre-confirmation "which archive" line below. */
function formatArchiveStamp(stamp: string): string {
  const [date, time] = stamp.split("-");
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} ${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)} UTC`;
}

/** The newest FULL archive of this deployment, and what was skipped to find it.
 *
 *  `pull` writes migrate and share archives into the same backup directory; restoring one
 *  of those over a live instance is not a restore (a migrate archive has no config/.env, a
 *  share archive has neither identity nor devices) — so those are skipped by default. Named
 *  explicitly, any archive is still restorable. The shared inventory distinguishes an
 *  empty directory from an unreadable one. Exported to pin the selection rule. */
export async function newestArchive(
  ctx: Context,
  directory: string,
): Promise<{ archive?: string; skipped: string[] }> {
  const archives = await listBackupArchives(ctx, directory);
  const skipped: string[] = [];
  for (const entry of archives) {
    if (entry.profile === "full") return { archive: entry.path, skipped };
    skipped.push(`${entry.name} (profile: ${entry.profile})`);
  }
  return { skipped };
}

async function confirm(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    die("refusing to overwrite without confirmation; pass --force when running non-interactively");
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    return answer.trim() === "yes";
  } finally {
    rl.close();
  }
}

/** Checks the restored tree physically, before anything acts through it — inspectArchive
 *  reasons about the archive's record, this reasons about what tar actually created.
 *
 *  The root must be an ordinary directory, not a link (else everything below is reached
 *  through it). Each mandatory layout path that exists must resolve inside the root — a link
 *  elsewhere would carry fresh-identity deletion or directory prep (mkdir/chown/chmod 700)
 *  outside the promised data directory. Absent is fine (ensureDataDirs creates it); a link
 *  that fails to resolve is refused, since mkdir -p would follow it outside.
 *
 *  Probes run under the same privilege as the writes they guard — a check with fewer rights
 *  than the write is how a write lands through a path the check never saw. "Absent" is only
 *  trusted when the parent is also searchable with those privileges. */
async function verifyRestoredLayout(ctx: Context, dataDir: string): Promise<void> {
  const prefix = await sudoFor(ctx, dataDir);
  if (await isLink(ctx, prefix, dataDir)) {
    die(`refusing the restored root ${dataDir}: it is a symlink, not an ordinary directory`);
  }
  const root = await physicalPath(ctx, dataDir, prefix);
  for (const sub of DATA_SUBDIRS) {
    const path = `${dataDir}/${sub}`;
    if (!(await presenceOf(ctx, prefix, path))) continue;
    const physical = await physicalPath(ctx, path, prefix);
    // Exact-boundary comparison, not a bare string prefix — a sibling like `…/dataEVIL` must be refused too.
    if (physical !== root && !physical.startsWith(`${root}/`)) {
      die(`refusing ${path}: it resolves to ${physical}, outside the restored tree ${root}`);
    }
  }
}

/** Only test's own 0/1 is an answer; a transport hiccup under load is retried, then
 *  reported — never read as "not a link", which would skip the root's symlink boundary. */
async function isLink(ctx: Context, prefix: string[], path: string): Promise<boolean> {
  const [head, ...rest] = [...prefix, "test", "-L", path];
  return (await answeredProbe(ctx, head, rest, [0, 1])).code === 0;
}

/** Present as anything — a dangling symlink counts, because creating "through" it lands
 *  in its target. A clean 1 from both probes is only believed when the same privileges
 *  can search the path's parent: `test` answers an untraversable directory exactly like
 *  a missing one, and skipping a mandatory path the check could not actually see is what
 *  lets a privileged act travel it. */
async function presenceOf(ctx: Context, prefix: string[], path: string): Promise<boolean> {
  for (const flag of ["-e", "-L"] as const) {
    const [head, ...rest] = [...prefix, "test", flag, path];
    const result = await ctx.transport.exec(head, rest, { allowFailure: true });
    if (result.code === 0) return true;
    if (result.code !== 1) {
      die(`cannot determine whether ${path} exists on the target: ${result.stderr.trim() || `test ${flag} exited ${result.code}`}`);
    }
  }
  // The same idiom sudoFor() computes a probe path with: the deepest existing ancestor,
  // so the answer is about the directory actually gating this one.
  const parent = path.slice(0, Math.max(path.lastIndexOf("/"), 1));
  const [head, ...rest] = [...prefix, "test", "-x", parent];
  const searchable = await ctx.transport.exec(head, rest, { allowFailure: true });
  if (searchable.code !== 0) {
    die(
      `cannot verify ${path}: it answers as absent, but ${parent} cannot be searched with this run's privileges — ` +
        "restore would act through a path its checks could not see",
    );
  }
  return false;
}

/** Refuses a data root whose existing ancestry is redirected before restore moves or
 * creates anything. Re-run this at each destructive boundary to catch changed parents.
 * The one shared helper (datadir.ts), taken through restore's own privileges. */
function verifyDataDirAncestry(ctx: Context, dataDir: string): Promise<void> {
  return assertCanonicalAncestry(ctx, dataDir, async (probe) => sudoFor(ctx, probe));
}

/** Brings the archive's privacy history back to the deployment-side ledger, before anything
 *  acts on the restored data.
 *
 *  The ledger lives in the operator-side deployment directory, so restoring into a new/lost
 *  one needs its own copy: otherwise the next migrate/share builds exclusions from an empty
 *  record. A full backup carries a copy inside the data root; when present it is imported
 *  (union) inside the try whose catch restores the previous data — a copy that exists but
 *  cannot be read fails the restore, never reads as "nothing to protect". An archive without
 *  one predates history travelling with backups. */
async function importRestoredHistory(ctx: Context, name: string, entries: readonly string[], dataDir: string): Promise<void> {
  const historyEntry = `${name}/config/clawwright-private-paths.json`;
  if (entries.some((entry) => entry.replace(/^\.\//, "") === historyEntry)) {
    const added = await importRestoredPrivatePathsHistory(ctx, privatePathsHistoryFile(dataDir));
    if (added.length > 0) info(`privacy history restored with the data: ${added.length} path(s) stay protected`);
    return;
  }
  if ((await persistedPrivatePaths()).length > 0) {
    info(
      "this archive carries no privacy history (a backup made before clawwright copied it into backups) — " +
        "this deployment's own ledger still protects its recorded paths",
    );
    return;
  }
  warn(
    "this archive carries no privacy history and this deployment has none recorded: private files that recipe " +
      "hooks wrote before clawwright kept records cannot be classified from what is here — declare the paths " +
      "(recipes' privatePaths) or record them with a private write before trusting migrate/share with this data",
  );
}

/** Re-verifies a native backup's own pristine archive (createNativeArchive embeds one at
 *  NATIVE_MANIFEST_NAME) with `openclaw backup verify`, before anything else in this archive
 *  is trusted or unpacked — this one may have aged, moved, or been tampered with since the
 *  --verify createNativeArchive ran at creation, which this does not merely repeat. Extracted
 *  under the data directory's own state mount so the sidecar can reach it (the only mounted
 *  path available before restore has put anything back), and removed again whatever happens. */
async function verifyEmbeddedNativeManifest(ctx: Context, archive: string, manifestEntry: string): Promise<void> {
  log("this archive embeds OpenClaw's own native backup manifest — verifying it before unpacking anything else");
  const session = `${ctx.settings.dataDir}/config/.clawwright-restore-verify-${randomBytes(6).toString("hex")}`;
  const prefix = await sudoFor(ctx, archive);
  let created = false;
  try {
    await runMaybePrivileged(ctx, session, "mkdir", ["-p", session]);
    created = true;
    const [exHead, ...exRest] = [...prefix, "tar", "-xzf", archive, "-C", session, manifestEntry];
    await ctx.transport.exec(exHead, exRest);
    const extracted = `${session}/${manifestEntry}`;
    if (!(await ctx.transport.exists(extracted))) {
      die(`refusing to restore ${archive}: its embedded native manifest (${manifestEntry}) did not extract`);
    }
    let containerPath: string;
    try {
      containerPath = ctx.paths.toContainer(extracted);
    } catch (error) {
      die(`refusing to restore ${archive}: cannot reach its embedded native manifest from the sidecar — ${(error as Error).message}`);
    }
    try {
      await openclawCli(ctx, ["backup", "verify", "--json", containerPath]);
    } catch (error) {
      die(`refusing to restore ${archive}: its embedded native manifest failed verification — ${(error as Error).message}`);
    }
  } finally {
    if (created) await runMaybePrivileged(ctx, session, "rm", ["-rf", "--", session]).catch(() => {});
  }
}

/** Prepared inputs for execution or a read-only preview. */
export interface PreparedRestore {
  archive: string;
  entries: string[];
  name: string;
  dataDir: string;
  parent: string;
  nativeManifestVerified: boolean;
  nativeManifestPresent: boolean | null;
  archiveValidationDeferred: boolean;
  /** Confirmed before replacement; reporting must not introduce a late policy refusal. */
  runningRecipes: Recipe[];
}

/** Validate an archive; preview defers hooks and native verification that may write. */
export async function prepareRestore(
  ctx: Context,
  archive: string,
  options: RestoreOptions,
  mode: "execute" | "preview" = "execute",
): Promise<PreparedRestore> {
  const { dataDir } = ctx.settings;
  const name = dataDirName(dataDir);
  const parent = dataDirParent(dataDir);

  // Execute callers hold the instance lock. Preview makes the same read-only policy
  // checks, but execution always repeats them under that lock before any restore work.
  // Unknown inventory and ownership refusals propagate; neither means "no recipes".
  const runningRecipes = await runningRecipeStacks(ctx);
  // A hook may fetch or decrypt another archive. Preview must defer its validation.
  if (mode === "preview" && options.internal !== true && ctx.applicationBeforeRestore !== undefined) {
    await verifyDataDirAncestry(ctx, dataDir);
    return { archive, entries: [], name, dataDir, parent, nativeManifestVerified: false, nativeManifestPresent: null, archiveValidationDeferred: true, runningRecipes };
  }

  // The ownership policy is confirmed, but no archive has been validated or data moved.
  // A hook can decrypt or fetch the real archive and hand back the path to use instead;
  // a failure here means the restore never started, so there is nothing to compensate.
  if (options.internal !== true && ctx.applicationBeforeRestore !== undefined) {
    try {
      const prepared = await ctx.applicationBeforeRestore({ archive });
      if (typeof prepared === "string" && prepared !== "") archive = prepared;
    } catch (error) {
      die(`beforeRestore hook failed, restore did not start: ${(error as Error).message}`);
    }
  }

  if (!(await ctx.transport.exists(archive))) die(`archive not found: ${archive}`);

  log("verifying the archive");
  const entries = await listArchive(ctx, archive);
  if (entries.length === 0) die(`archive is empty or unreadable: ${archive}`);

  // Every entry, not just the first: one absolute path or one .. among thousands is enough
  // to write outside the data directory, and this runs before anything is stopped.
  const problems = inspectArchive(entries, await listArchiveLinks(ctx, archive));
  // Links into the container image are expected on every real snapshot, so they fold into
  // one summary line instead of one warning per plugin-skill/codex-home tool shim.
  const { toReport, foldedImageLinks } = reportableProblems(problems);
  for (const problem of toReport.filter((entry) => !entry.fatal)) warn(problem.message);
  if (foldedImageLinks > 0) warn(`${foldedImageLinks} expected link(s) into the OpenClaw image`);
  const fatal = problems.filter((problem) => problem.fatal);
  if (fatal.length > 0) {
    for (const problem of fatal) warn(problem.message);
    die(`refusing to unpack ${archive}: it would write outside ${dataDir}`);
  }

  const root = archiveRoot(entries);
  if (root !== name) {
    die(`archive holds '${root}/' but the data directory is '${name}/' — restoring it would misplace every file`);
  }

  const nativeManifestEntry = `${name}/${NATIVE_MANIFEST_NAME}`;
  const nativeManifestPresent = entries.some((entry) => entry.replace(/^\.\//, "") === nativeManifestEntry);
  if (nativeManifestPresent && mode === "execute") await verifyEmbeddedNativeManifest(ctx, archive, nativeManifestEntry);

  await verifyDataDirAncestry(ctx, dataDir);

  return { archive, entries, name, dataDir, parent, nativeManifestVerified: nativeManifestPresent && mode === "execute", nativeManifestPresent, archiveValidationDeferred: false, runningRecipes };
}

/** State performRestore's try block accumulates, needed by rollbackRestore if it fails. */
interface RestoreProgress {
  wasRunning: boolean;
  aside: string | undefined;
  oldDataMoved: boolean;
  restoreMayHaveWritten: boolean;
  historyImported: boolean;
  ledgerBefore: PrivatePathsLedgerState | undefined;
}

/** Compensation for a failed act phase: restores the previous data, reverts the privacy
 *  ledger to exactly what it held before, and restarts the gateway if it was running —
 *  then always rethrows, wrapped in an AggregateError when a compensation itself fails. */
async function rollbackRestore(ctx: Context, dataDir: string, parent: string, progress: RestoreProgress, error: unknown): Promise<never> {
  const { wasRunning, aside, oldDataMoved, restoreMayHaveWritten, historyImported, ledgerBefore } = progress;
  // A half-unpacked or rejected directory is worse than nothing: this operation's own
  // staging root must never survive its own failure, whether or not there was previous
  // data to put back in its place — a clean target left with a failed extraction's
  // leftovers reads as existing state to the next bootstrap/restore.
  warn(oldDataMoved ? "restore failed — restoring the previous data" : "restore failed — removing the unpacked tree");
  const compensationErrors: unknown[] = [];
  if (restoreMayHaveWritten) {
    try {
      await verifyDataDirAncestry(ctx, dataDir);
      await runMaybePrivileged(ctx, dataDir, "rm", ["-rf", dataDir], { force: await needsOwnerEscalation(ctx, OWNER) });
    } catch (rollbackError) { compensationErrors.push(rollbackError); }
  }
  if (oldDataMoved && aside !== undefined) {
    try {
      await verifyDataDirAncestry(ctx, dataDir);
      await runMaybePrivileged(ctx, parent, "mv", [aside, dataDir]);
    } catch (rollbackError) { compensationErrors.push(rollbackError); }
  }
  // The import already landed in the operator-side ledger before this failure: put it back
  // to exactly what it held before this restore touched it, not just "whatever the merge
  // added" — a concurrent change during the same held lock is not expected, and this is the
  // rollback of THIS restore's own effect, nothing else's. The rollback restores that state
  // FAITHFULLY, absence included: writing an empty ledger when none existed before would
  // fabricate a forget-shaped file — a witness to a forget this operator never asked for.
  if (historyImported) {
    warn("restore failed after privacy history was imported — reverting the ledger");
    const snapshot = ledgerBefore;
    // historyImported is only ever true after the snapshot succeeded, so the undefined case
    // is unreachable today; it stays a plain no-op rather than a non-null assertion.
    if (snapshot !== undefined) {
      if (snapshot.existed) {
        try {
          await mutatePrivatePathsLedgerState(privatePathsLedgerFile(), () => ({
            next: { paths: snapshot.paths, forgotten: snapshot.forgotten },
            value: undefined,
          }));
        } catch (rollbackError) { compensationErrors.push(rollbackError); }
      } else {
        try { await removePrivatePathsLedger(privatePathsLedgerFile()); }
        catch (rollbackError) { compensationErrors.push(rollbackError); }
      }
    }
  }
  if (wasRunning) {
    try {
      if (!(await ctx.runtime.isRunning())) {
        await ctx.runtime.start();
        await ctx.runtime.waitForHealth();
      }
    } catch (rollbackError) { compensationErrors.push(rollbackError); }
  }
  if (compensationErrors.length > 0) {
    for (const compensationError of compensationErrors) warn(`restore compensation failed: ${(compensationError as Error).message}`);
    throw new AggregateError([error, ...compensationErrors], "restore failed and one or more compensations also failed");
  }
  throw error;
}

/** Act phase: stops the gateway, moves the current data aside, unpacks the archive and
 *  applies its post-unpack steps (layout check, privacy history import, fresh-identity,
 *  ensureDataDirs). On failure, delegates to rollbackRestore, which always throws. */
async function performRestore(ctx: Context, prepared: PreparedRestore, options: RestoreOptions): Promise<string | undefined> {
  const { archive, entries, name, dataDir, parent } = prepared;
  const wasRunning = await ctx.runtime.isRunning();
  log("stopping containers");
  let aside: string | undefined;
  let oldDataMoved = false;
  let restoreMayHaveWritten = false;
  let historyImported = false;
  let ledgerBefore: PrivatePathsLedgerState | undefined;
  try {
    await ctx.runtime.stop();
    await verifyDataDirAncestry(ctx, dataDir);
    if (await ctx.transport.exists(dataDir)) {
      aside = replacedCopyName(dataDir);
      log(`moving current data aside: ${aside}`);
      await verifyDataDirAncestry(ctx, dataDir);
      await runMaybePrivileged(ctx, parent, "mv", [dataDir, aside]);
      oldDataMoved = true;
    }

    log(`unpacking into ${parent}`);
    await verifyDataDirAncestry(ctx, dataDir);
    await runMaybePrivileged(ctx, parent, "mkdir", ["-p", parent]);
    await verifyDataDirAncestry(ctx, dataDir);
    restoreMayHaveWritten = true;
    await extractArchive(ctx, archive, parent);

    // Between unpack and the first action through the restored tree — inspectArchive only
    // reasons about the archive's record, this checks what tar actually created, since
    // --fresh-identity and ensureDataDirs both follow paths without looking.
    log("verifying the restored layout");
    await verifyRestoredLayout(ctx, dataDir);

    // Ledger state before this restore's history import may change it — fresh-identity and
    // ensureDataDirs run AFTER the import, so a failure there undoes the import with the
    // data tree. Inside the try: a snapshot read failure is handled by the same rollback,
    // since historyImported stays false.
    ledgerBefore = await privatePathsLedgerState();

    // Before the fresh-identity deletion and ensureDataDirs' writes, and inside the try
    // whose catch puts the previous data back: the import is part of "the archive is good".
    await importRestoredHistory(ctx, name, entries, dataDir);
    historyImported = true;

    // Cloning rather than moving: two instances must not share one identity, or both will
    // claim the same device and paired-device records.
    if (options.freshIdentity === true) {
      log("dropping identity and paired devices (--fresh-identity)");
      await runMaybePrivileged(ctx, `${dataDir}/config`, "rm", [
        "-rf",
        `${dataDir}/config/identity`,
        `${dataDir}/config/devices`,
      ]);
    }

    // trustExisting: this tree was just extracted from an archive verifyRestoredLayout has
    // already proven contained, not found lying around — it must not read as an unrelated
    // pre-existing directory this run merely stumbled onto.
    await ensureDataDirs(ctx, { trustExisting: true });
  } catch (error) {
    await rollbackRestore(ctx, dataDir, parent, { wasRunning, aside, oldDataMoved, restoreMayHaveWritten, historyImported, ledgerBefore }, error);
  }
  return aside;
}

/** The lines that re-point a sidecar at the restored tree: one command per line, never joined
 *  with `&&` (Windows PowerShell 5.1 has no such operator). */
export function repointLines(name: string): Array<string> {
  const remove = commandLine(["recipe", "remove", name]);
  const install = commandLine(["recipe", "install", name]);
  return [`to point ${name} at the restored tree:`, remove, install];
}

/** Verify/report phase: warns about sidecars still bound to the previous data, then starts
 *  the gateway back up (or explains why it was left stopped). Runs only once performRestore
 *  has succeeded. */
async function reportRestoreOutcome(ctx: Context, archive: string, aside: string | undefined, options: RestoreOptions, sidecars: PreparedRestore["runningRecipes"]): Promise<RestoreOutcome> {
  // The gateway was stopped; recipe stacks are not and cannot be — they are separate
  // Compose projects, and re-resolving another project's bind mounts is not this
  // command's to do. A sidecar mounting a file or directory under the data directory
  // therefore still holds the previous data: the moved-aside tree when one was moved,
  // the replaced file's old content otherwise. Named here so the gap is the operator's
  // decision, not a silent one.
  // Reuse the preflight observation: discovery is a mandatory policy check, not a
  // fallible reporting read after replacement. We do not mutate/recreate these stacks.
  if (sidecars.length > 0) {
    warn(
      `recipe stack(s) running at preflight, not recreated after this restore: ${sidecars.map((recipe) => recipe.name).join(", ")} — ` +
        "their containers may still bind-mount the previous data rather than the restored tree" +
        (aside !== undefined ? ` (kept at ${aside})` : ""),
    );
    for (const recipe of sidecars) for (const line of repointLines(recipe.name)) info(line);
  }

  if (options.noStart === true) {
    log(`restore complete from ${archive} (gateway not started)`);
    if (aside !== undefined) info(`previous data kept at ${aside}`);
    return { restored: true, started: false, reason: "no-start", nextAction: commandLine("up") };
  }

  // The restored config can reference variables nothing on this instance has yet — push()
  // works around this by always restoring with noStart and doing its own preflight after
  // installing keys, but a direct `clawwright restore` has no such second step. Without this, an
  // archive missing its secrets starts straight into a SecretRefResolutionError crash-loop.
  try {
    await preflightSecrets(ctx);
  } catch (error) {
    if (!(error instanceof MissingSecretsError)) throw error;
    warn(error.message);
    info(`restore complete from ${archive} (gateway left stopped)`);
    info(`supply the keys with: ${commandLine(["secrets", "--apply", "--store", "<name>"])}, then ${commandLine("up")}`);
    if (aside !== undefined) info(`previous data kept at ${aside}`);
    return {
      restored: true,
      started: false,
      reason: "missing-secrets",
      nextAction: `${commandLine(["secrets", "--apply", "--store", "<name>"])}, then ${commandLine("up")}`,
    };
  }

  log("starting the gateway");
  await ctx.runtime.start();
  await ctx.runtime.waitForHealth();
  log(`restore complete from ${archive}`);
  if (aside !== undefined) info(`previous data kept at ${aside}`);
  return { restored: true, started: true };
}

export async function restoreArchive(
  ctx: Context,
  archive: string,
  options: RestoreOptions = {},
): Promise<RestoreOutcome> {
  const prepared = await prepareRestore(ctx, archive, options);
  if (options.force !== true) {
    warn(`this will replace the contents of ${prepared.dataDir}`);
    info(`the current directory is kept as ${prepared.dataDir}.replaced-<timestamp>`);
    if (!(await confirm("Type 'yes' to continue: "))) die("aborted");
  }
  const aside = await performRestore(ctx, prepared, options);
  return reportRestoreOutcome(ctx, prepared.archive, aside, options, prepared.runningRecipes);
}

/** `--dry-run`: report read-only checks and those deferred until execution. */
export async function restoreDryRun(ctx: Context, archive: string, options: RestoreOptions = {}, jsonOnly = false): Promise<void> {
  const prepared = await prepareRestore(ctx, archive, options, "preview");
  const plan = await buildRestorePlan(ctx, prepared, options);
  if (jsonOnly) {
    emit(`${JSON.stringify({ ok: true, changed: false, dryRun: true, ...plan }, null, 2)}\n`);
    return;
  }
  printRestorePlan(plan);
}

export const RESTORE = commandBody({
  effect: "destroy",
  arguments: RESTORE_ARGUMENTS,
  async run(ctx, values) {
    const options: RestoreOptions = {};
    if (values.force === true) options.force = true;
    if (values["fresh-identity"] === true) options.freshIdentity = true;
    if (values["no-start"] === true) options.noStart = true;
    const dryRun = values["dry-run"] === true;
    const jsonOnly = values.json === true;
    let archive = values.archive;

    if (archive === undefined) {
      const { archive: newest, skipped } = await newestArchive(ctx, ctx.settings.backupDir);
      if (newest === undefined) {
        if (skipped.length > 0) {
          die(
            `no full archives in ${ctx.settings.backupDir} — the ${skipped.length} archive(s) there are profile-limited ` +
              `(${skipped[0]}) and restoring one replaces this instance with something that cannot start. ` +
              `Run ${commandLine("backup")} first, or pass the archive explicitly if that is really what you want.`,
          );
        }
        die(`no archives found in ${ctx.settings.backupDir} — pass one explicitly`);
      }
      archive = newest;
      if (!jsonOnly) {
        // Said rather than done quietly: the operator who just ran `pull --share` and then
        // `restore` is entitled to know why the newest file in that directory was not used.
        for (const entry of skipped) info(`skipping ${entry} — not a full backup`);
        // Before any confirmation prompt (below, inside restoreArchive) or anything else runs:
        // an operator asking "which one" must not have to read it out of a log a restore is
        // already mid-way through.
        const pickedName = archive.slice(archive.lastIndexOf("/") + 1);
        const pickedStamp = parseBackupArchive(pickedName, deploymentName())?.stamp;
        log(`using the newest archive: ${pickedName}${pickedStamp === undefined ? "" : ` (${formatArchiveStamp(pickedStamp)})`}`);
      }
    }

    if (dryRun) {
      // Read-only, same convention as apply --dry-run/plan: no instance lock taken, so this
      // never blocks a concurrent apply/restore/push longer than the validation itself takes.
      await restoreDryRun(ctx, archive, options, jsonOnly);
      return;
    }

    if (jsonOnly) {
      let caught: unknown;
      let outcome: RestoreOutcome | undefined;
      await withOutputSink(() => {}, async () => {
        try {
          outcome = await guardedWith(ctx, "restore", takeoverOf(values), () => restoreArchive(ctx, archive!, options));
        } catch (error) {
          caught = error;
        }
      });
      if (caught !== undefined) {
        const message = caught instanceof Error ? caught.message : String(caught);
        emit(`${JSON.stringify({ ok: false, changed: true, archive, problems: [message] }, null, 2)}\n`);
        throw caught;
      }
      emit(`${JSON.stringify({ ok: true, changed: true, archive, freshIdentity: options.freshIdentity === true, ...outcome }, null, 2)}\n`);
      return;
    }

    // The most destructive command here, and until now the only mutating one taking no lock:
    // it replaces the entire data directory while anything else may be writing into it.
    // Nested under push, which already holds it, this is a no-op.
    await guardedWith(ctx, "restore", takeoverOf(values), () => restoreArchive(ctx, archive!, options));
  },
});
