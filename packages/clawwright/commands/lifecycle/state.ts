// `clawwright pull` and `clawwright push` — moving an instance's whole state around.
//
// Both are thin layers over backup/restore rather than a second implementation: those
// already stop the gateway before touching sqlite and move existing data aside instead of
// deleting it.

import { log, info, warn, die } from "#src/core/io/log.ts";
import { emit, withOutputSink } from "#src/core/io/output.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { randomBytes } from "node:crypto";
import type { Context } from "#src/core/context.ts";
import { parseEnv, parseRetention } from "#src/core/env.ts";
import { guardedWith, type LockTakeover } from "#src/runtime/lock/instance-lock.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import { sudoFor, runMaybePrivileged, secretsFileOnTarget } from "#src/runtime/files/datadir.ts";
import { publishPrivateTargetFile } from "#src/security/privacy/private-target-file.ts";
import { archiveRoot, listArchive, listSnapshotArchives, fileSize, parseSnapshotArchive, snapshotDeploymentNames, SHARE_ALLOWED, PROFILE_SHORTHAND_FLAGS, type Profile } from "#src/service/archive/index.ts";
import { installedRecipePrivatePaths } from "#src/service/recipe.ts";
import { requirements, template } from "#src/service/secrets.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { createBackup } from "./backup/index.ts";
import { restoreArchive, prepareRestore } from "./restore/index.ts";
import type { RestoreOptions } from "./restore/index.ts";
import { buildRestorePlan, printRestorePlan } from "./restore/plan.ts";
import { forbiddenViolations, verifySnapshot } from "./verify.ts";
import { preflightSecrets, MissingSecretsError } from "#src/commands/management/configuration/secrets.ts";
import type { BackupPurpose } from "#src/core/app.ts";
import { commandBody, type ArgumentSpec, type ParsedCall, type Values } from "#src/core/command/spec.ts";
import { PROFILE_ARGUMENT, FORCE_ARGUMENT, LOCK_TAKEOVER_ARGUMENTS, takeoverOf } from "#src/commands/interface/groups/shared-arguments.ts";
import * as kinds from "#src/core/values/kinds.ts";

const SECRETS_SUFFIX = ".secrets.env";

export const PULL_ARGUMENTS = [
  PROFILE_ARGUMENT,
  { name: "share", description: "Share profile, verified", kind: "flag" },
  { name: "with-secrets", description: "Full profile, with keys", kind: "flag" },
  { name: "migrate", summary: "Migrate profile", description: "Migrate profile (already pull's default) — accepted so backup and pull share the same flag vocabulary", kind: "flag" },
  {
    name: "hot",
    summary: "Do not stop the service",
    description: "Do not stop the service (risks a partial write)",
    kind: "flag",
  },
  ...LOCK_TAKEOVER_ARGUMENTS,
  { name: "json", description: "Outcome as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

export const PUSH_ARGUMENTS = [
  { name: "archive", description: "Snapshot; newest if omitted", kind: "positional", value: kinds.text("a snapshot path on the target") },
  { ...FORCE_ARGUMENT, setByConfirm: true },
  ...LOCK_TAKEOVER_ARGUMENTS,
  {
    name: "fresh-identity",
    summary: "Drop identity and paired devices",
    description: "Drop identity and paired devices (cloning, not moving)",
    kind: "flag",
  },
  { name: "dry-run", description: "What would happen", kind: "flag", effect: "read" },
  { name: "json", description: "Outcome as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

async function ensureSnapshotDir(ctx: Context): Promise<string> {
  const directory = ctx.settings.snapshotDir;
  if (directory.startsWith("/mnt/")) {
    warn(`snapshot directory ${directory} is on a Windows mount — chmod 600 will not apply there`);
  }
  if (!(await ctx.transport.exists(directory))) {
    await runMaybePrivileged(ctx, directory, "mkdir", ["-p", directory]);
    await runMaybePrivileged(ctx, directory, "chown", ["1000:1000", directory]);
  }
  return directory;
}

function stamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-").slice(0, 19);
}

/** Writes a staged sidecar, escalating when its directory requires it. */
async function writeSnapshotSidecar(ctx: Context, path: string, content: string, mode?: string): Promise<void> {
  const prefix = await sudoFor(ctx, path);
  if (prefix.length === 0) {
    await ctx.transport.writeFile(path, content, mode);
    return;
  }
  const [head, ...rest] = [...prefix, "tee", path];
  await ctx.transport.exec(head, rest, { input: content });
  if (mode !== undefined) {
    const [chmodHead, ...chmodRest] = [...prefix, "chmod", mode, path];
    await ctx.transport.exec(chmodHead, chmodRest);
  }
  const uid = (await ctx.transport.exec("id", ["-u"])).stdout.trim();
  const gid = (await ctx.transport.exec("id", ["-g"])).stdout.trim();
  if (!/^\d+$/.test(uid) || !/^\d+$/.test(gid)) throw new Error("could not determine snapshot sidecar owner");
  const [ownerHead, ...ownerRest] = [...prefix, "chown", `${uid}:${gid}`, path];
  await ctx.transport.exec(ownerHead, ownerRest);
}

/** Checks a snapshot path with the same privileges used to publish it. */
async function snapshotExists(ctx: Context, path: string): Promise<boolean> {
  const prefix = await sudoFor(ctx, path);
  const [head, ...rest] = [...prefix, "test", "-e", path];
  const result = await ctx.transport.exec(head, rest, { allowFailure: true });
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(`could not check snapshot path ${path} (exit ${result.code})`);
}

/** A move whose final state could not be observed safely. */
class SnapshotMoveUncertainError extends Error {
  readonly sourceAbsent: boolean | undefined;

  constructor(destination: string, cause: unknown, sourceAbsent: boolean | undefined) {
    super(`could not confirm publication of ${destination}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "SnapshotMoveUncertainError";
    this.sourceAbsent = sourceAbsent;
  }
}

/** Publishes one file without replacing an existing path. */
async function moveSnapshotFile(ctx: Context, source: string, destination: string): Promise<void> {
  const prefix = await sudoFor(ctx, destination);
  const [head, ...rest] = [...prefix, "mv", "-nT", "--", source, destination];
  let result: Awaited<ReturnType<Context["transport"]["exec"]>>;
  try {
    result = await ctx.transport.exec(head, rest, { allowFailure: true });
  } catch (error) {
    let sourceAbsent: boolean | undefined;
    try {
      sourceAbsent = !(await snapshotExists(ctx, source));
    } catch {
      // The move and its acknowledgement are both unavailable; preserve any final
      // sidecar because removing a possible publication could destroy prior data.
    }
    if (sourceAbsent !== false) throw new SnapshotMoveUncertainError(destination, error, sourceAbsent);
    throw error;
  }
  if (result.code !== 0) {
    const failure = new Error(`could not publish ${destination}: ${result.stderr.trim() || `mv exited ${result.code}`}`);
    let sourceAbsent: boolean | undefined;
    try {
      sourceAbsent = !(await snapshotExists(ctx, source));
    } catch {
      // A failed probe leaves the move outcome unknown, so the caller must retain
      // sidecars until it can establish whether the archive was committed.
    }
    if (sourceAbsent !== false) throw new SnapshotMoveUncertainError(destination, failure, sourceAbsent);
    throw failure;
  }
  let sourcePresent: boolean;
  try {
    sourcePresent = await snapshotExists(ctx, source);
  } catch (error) {
    throw new SnapshotMoveUncertainError(destination, error, undefined);
  }
  if (sourcePresent) {
    throw new Error(`snapshot path already exists: ${destination}`);
  }
  let destinationPresent: boolean;
  try {
    destinationPresent = await snapshotExists(ctx, destination);
  } catch (error) {
    throw new SnapshotMoveUncertainError(destination, error, true);
  }
  if (!destinationPresent) {
    throw new SnapshotMoveUncertainError(destination, new Error("mv did not create the destination"), true);
  }
}

/** Removes owned pull artifacts, attempting every path before reporting failure. */
async function removeSnapshotFiles(ctx: Context, paths: string[]): Promise<void> {
  const failures: unknown[] = [];
  for (const path of paths) {
    try {
      await runMaybePrivileged(ctx, path, "rm", ["-f", path]);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "could not remove all pull artifacts");
}

/** Filters a newest-first listing to snapshots owned by this deployment. */
export function selectSnapshotPaths(listing: string, deployment: string): string[] {
  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter((path) => path !== "")
    .filter((path) => parseSnapshotArchive(path.slice(path.lastIndexOf("/") + 1), deployment) !== undefined);
}

/** Deletes snapshots beyond the configured retention count, each with its sidecar files
 *  (.template.env, and .secrets.env when a migrate pull produced one) — snapshot's own
 *  version of backup.ts's rotate(), needed since a deployment pulled regularly (smoke, a
 *  cron) grows the snapshot directory without bound.
 *
 *  Escalation is checked once for the directory, not per file, so a large unrotated backlog
 *  costs two round trips total, not one per file. Exported for tools/checks/state.check.ts. */
export async function rotateSnapshots(ctx: Context, snapshotDir: string): Promise<void> {
  const keep = parseRetention("OC_SNAPSHOT_KEEP", ctx.settings.env.OC_SNAPSHOT_KEEP, 10);
  if (keep <= 0) return;

  const prefix = await sudoFor(ctx, snapshotDir);

  // Select only owned base archives; sidecars and sibling deployments are excluded.
  const names = snapshotDeploymentNames(deploymentName());
  const findArgs = [
    ...prefix,
    "find",
    snapshotDir,
    "-maxdepth",
    "1",
    "-type",
    "f",
    "(",
    ...names.flatMap((name, index) => [...(index === 0 ? [] : ["-o"]), "-name", `${name}-state-*.tar.gz`]),
    ")",
    "-printf",
    "%T@\\t%p\\n",
  ];
  const [findHead, ...findRest] = findArgs;
  const listing = await ctx.transport.exec(findHead, findRest, { allowFailure: true });
  if (listing.code !== 0) {
    throw new Error(`snapshot rotation could not list archives (exit ${listing.code})`);
  }
  const snapshots = listing.stdout
    .split("\n")
    .flatMap((line) => {
      const separator = line.indexOf("\t");
      if (separator < 0) return [];
      const modified = Number(line.slice(0, separator));
      const path = line.slice(separator + 1);
      return Number.isFinite(modified) && selectSnapshotPaths(path, deploymentName()).length === 1
        ? [{ path, modified }]
        : [];
    })
    .sort((left, right) => right.modified - left.modified)
    .map(({ path }) => path);

  const stale = snapshots.slice(keep);
  if (stale.length === 0) return;

  log(`removing ${stale.length} snapshot(s) beyond the last ${keep}:`);
  const targets: string[] = [];
  for (const old of stale) {
    const path = old.trim();
    info(path.slice(path.lastIndexOf("/") + 1));
    // A share snapshot has no .secrets.env; rm -f on a sidecar that was never written is
    // not an error, just a no-op.
    targets.push(path, `${path}.template.env`, `${path}${SECRETS_SUFFIX}`);
  }
  const [rmHead, ...rmRest] = [...prefix, "rm", "-f", ...targets];
  const removal = await ctx.transport.exec(rmHead, rmRest, { allowFailure: true });
  if (removal.code !== 0) {
    throw new Error(`snapshot rotation could not remove stale archives (exit ${removal.code})`);
  }
}

// --- secrets ------------------------------------------------------------------

/** Reads the target's provider keys. */
export async function dumpSecrets(ctx: Context): Promise<string | undefined> {
  const path = secretsFileOnTarget(ctx);
  if (!(await ctx.transport.exists(path))) return undefined;
  return ctx.transport.readFile(path);
}

/** Installs provider keys on the target with mode 600, owner 1000:1000 — OpenClaw refuses
 *  to read a root-owned env file.
 *
 *  Staged beside the final path and published with one rename, never written in place (an
 *  in-place write sits at process umask until chmod, and an interrupted one leaves the half
 *  file as the only copy). The chown is forced but only after comparing the target owner
 *  against the current identity — owning the staging file is not the right to hand it to a
 *  different uid. */
export async function loadSecrets(ctx: Context, content: string): Promise<void> {
  if (content.trim() === "") die("refusing to install an empty secrets file");
  const path = secretsFileOnTarget(ctx);
  await publishPrivateTargetFile(ctx, path, content);
  const count = content.split("\n").filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)).length;
  log(`installed ${path} (${count} variable(s))`);
}

// --- pull ---------------------------------------------------------------------

/** Not part of the CLI surface: a caller already holding the instance lock across a larger
 *  transaction (smoke's round-trip check) that must not let the gateway come back up
 *  between this pull and the restore that follows it. Ordinary callers never pass this. */
export interface PullTransactionOptions {
  leaveStopped?: boolean;
  /** Passed straight through to createBackup's own purpose (default "pull") — smoke's
   *  internal share check sets this to "internal" so afterBackup does not fire for a
   *  backup that exists only to prove pull's own privacy check still works. */
  purpose?: BackupPurpose;
}

interface PullPlan {
  readonly profile: Profile;
  readonly hot: boolean;
  readonly jsonOnly: boolean;
  readonly takeover: LockTakeover;
}

/** --share/--with-secrets/--migrate and --profile set one field; keys without `--`. */
const PROFILE_BY_FLAG: ReadonlyMap<string, Profile> = new Map(
  [...PROFILE_SHORTHAND_FLAGS].map(([flag, profile]) => [flag.slice("--".length), profile]),
);

/** The plan for a pull: the profile decision and the output mode. --share, --with-secrets,
 *  --migrate (the same shorthand vocabulary `backup` accepts) and --profile all set one
 *  field, so whichever was typed LAST wins — `given` is in typing order, so the last
 *  profile-naming argument decides it. */
function pullPlan(call: ParsedCall<Values<typeof PULL_ARGUMENTS>>): PullPlan {
  const values = call.values;
  const last = call.given.filter((name) => name === "profile" || PROFILE_BY_FLAG.has(name)).at(-1);
  const profile = last === undefined ? "migrate" : last === "profile" ? values.profile as Profile : PROFILE_BY_FLAG.get(last)!;
  return { profile, hot: values.hot === true, jsonOnly: values.json === true, takeover: takeoverOf(values) };
}

export const PULL = commandBody({
  effect: "change",
  arguments: PULL_ARGUMENTS,
  prepare: (call) => pullPlan(call),
  async run(ctx, plan, transaction: PullTransactionOptions = {}) {
    const pull = () => pullLocked(ctx, plan.profile, plan.hot, transaction.leaveStopped === true, transaction.purpose ?? "pull");
    // The guard before the lock, like every sibling preflight: the lock home is only ever
    // prepared by bootstrap, so on a never-bootstrapped target the lock claim would answer
    // with its own refusal and the guard behind it would never run.
    const guardedPull = async () => {
      await requireBootstrapped(ctx);
      return guardedWith(ctx, "pull", plan.takeover, pull);
    };
    if (plan.jsonOnly) {
      let result: PullPaths | undefined;
      let caught: unknown;
      await withOutputSink(() => {}, async () => {
        try {
          result = await guardedPull();
        } catch (error) {
          caught = error;
        }
      });
      if (caught !== undefined) {
        const message = caught instanceof Error ? caught.message : String(caught);
        emit(`${JSON.stringify({ ok: false, changed: true, profile: plan.profile, problems: [message] }, null, 2)}\n`);
        throw caught;
      }
      const paths = result!;
      emit(`${JSON.stringify({ ok: true, changed: true, profile: plan.profile, snapshot: paths.snapshot, template: paths.snapshotTemplate }, null, 2)}\n`);
      return;
    }
    await guardedPull();
  },
});

/** Not part of the CLI surface: a caller already inside a larger transaction (smoke's
 *  round-trip check) that pulls directly, without argv — the body's phases do not carry the
 *  transaction options (leaveStopped, purpose). Ordinary callers go through PULL. */
export async function pullSnapshot(ctx: Context, profile: Profile, transaction: PullTransactionOptions = {}): Promise<void> {
  await guardedWith(ctx, "pull", { breakLock: false }, () =>
    pullLocked(ctx, profile, false, transaction.leaveStopped === true, transaction.purpose ?? "pull"));
}



/** The full set of paths one pull writes — the staging copies and their final destinations. */
interface PullPaths {
  readonly snapshotDir: string;
  readonly snapshot: string;
  readonly snapshotTemplate: string;
  readonly snapshotSecrets: string;
  readonly staging: string;
  readonly staged: string;
  readonly stagedTemplate: string;
  readonly stagedSecrets: string;
}

function computePullPaths(snapshotDir: string): PullPaths {
  const snapshot = `${snapshotDir}/${deploymentName()}-state-${stamp()}.tar.gz`;
  const staging = `${snapshotDir}/.clawwright-pull-${randomBytes(8).toString("hex")}`;
  const staged = `${staging}/${snapshot.slice(snapshot.lastIndexOf("/") + 1)}`;
  return {
    snapshotDir,
    snapshot,
    snapshotTemplate: `${snapshot}.template.env`,
    snapshotSecrets: `${snapshot}${SECRETS_SUFFIX}`,
    staging,
    staged,
    stagedTemplate: `${staged}.template.env`,
    stagedSecrets: `${staged}${SECRETS_SUFFIX}`,
  };
}

async function refuseExistingSnapshot(ctx: Context, paths: PullPaths): Promise<void> {
  if (await snapshotExists(ctx, paths.snapshot) || await snapshotExists(ctx, paths.snapshotTemplate) || await snapshotExists(ctx, paths.snapshotSecrets)) {
    die(`snapshot name already exists: ${paths.snapshot}`);
  }
}

/** What one pull tracks across its staging steps, for the catch block's cleanup decision. */
interface PullPublicationState {
  publishedSidecars: string[];
  uncertainSidecars: string[];
  hasStagedSecrets: boolean;
  publishedArchive: boolean;
  archivePublicationUncertain: boolean;
}

/** Copies the archive into staging and, for the share profile, verifies it — deleting both
 *  the staged copy and the source archive on a failed or rejected verification. */
async function stageArchiveForPull(ctx: Context, paths: PullPaths, archive: string, profile: Profile): Promise<void> {
  log(`preparing snapshot in ${paths.snapshotDir}`);
  await runMaybePrivileged(ctx, paths.staging, "cp", [archive, paths.staged]);
  await runMaybePrivileged(ctx, paths.staged, "chmod", ["600", paths.staged]);

  if (profile !== "share") return;
  let passed: boolean;
  try {
    passed = await verifySnapshot(ctx, paths.staged, "share");
  } catch (error) {
    try {
      await removeSnapshotFiles(ctx, [paths.staged, archive]);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "share snapshot verification and cleanup failed");
    }
    throw error;
  }
  if (!passed) {
    await removeSnapshotFiles(ctx, [paths.staged, archive]);
    die(`snapshot rejected and deleted, along with ${archive}`);
  }
}

/** Writes the template sidecar always, and the migrate-profile secrets sidecar when the
 *  target has any to dump — refusing first if a required value is missing target-side. */
async function stageSnapshotSidecars(ctx: Context, paths: PullPaths, profile: Profile, state: PullPublicationState): Promise<void> {
  const needed = await requirements(ctx);
  await writeSnapshotSidecar(ctx, paths.stagedTemplate, template(needed));
  if (profile !== "migrate") return;

  const secrets = await dumpSecrets(ctx);
  const requiredTarget = needed.filter((entry) => entry.location === "target-env" && entry.required);
  const values = secrets === undefined ? {} : parseEnv(secrets, secretsFileOnTarget(ctx));
  const absent = requiredTarget.filter((entry) => values[entry.name] === undefined || values[entry.name]?.trim() === "");
  if (absent.length > 0) {
    for (const entry of absent) warn(`${secretsFileOnTarget(ctx)} has no value for ${entry.name} (${entry.usedBy})`);
    die(`cannot publish a migrate snapshot: ${absent.length} required value(s) are missing`);
  }
  if (secrets === undefined || secrets.trim() === "") {
    warn("the target has no config/.env — no keys were dumped");
    return;
  }
  await writeSnapshotSidecar(ctx, paths.stagedSecrets, secrets, "600");
  state.hasStagedSecrets = true;
}

/** The exclusion is a promise about paths, checked against the listing already in hand —
 *  one parse of output already fetched, not a second unpack. Migrate-only. */
async function refuseForbiddenMigrateContent(ctx: Context, paths: PullPaths, archive: string, profile: Profile, entries: string[]): Promise<void> {
  if (profile !== "migrate") return;
  const root = archiveRoot(entries);
  const relativeEntries = entries.map((entry) => entry.replace(/^\.\//, "").slice(root.length + 1));
  const violations = forbiddenViolations("migrate", await installedRecipePrivatePaths(), relativeEntries);
  if (violations.length > 0) {
    for (const path of violations) warn(`snapshot contains ${path}, which the migrate profile must exclude`);
    await removeSnapshotFiles(ctx, [paths.staged, archive]);
    die(`snapshot rejected and deleted, along with ${archive}`);
  }
}

/** Moves sidecars then the archive into place — the archive last, since it is the commit
 *  point: sidecars published before it are retraced from state.publishedSidecars if a later
 *  step in this sequence fails. */
async function publishSnapshotFiles(ctx: Context, paths: PullPaths, state: PullPublicationState): Promise<void> {
  try {
    await moveSnapshotFile(ctx, paths.stagedTemplate, paths.snapshotTemplate);
  } catch (error) {
    if (error instanceof SnapshotMoveUncertainError && error.sourceAbsent === true) state.uncertainSidecars.push(paths.snapshotTemplate);
    throw error;
  }
  state.publishedSidecars.push(paths.snapshotTemplate);
  if (state.hasStagedSecrets) {
    try {
      await moveSnapshotFile(ctx, paths.stagedSecrets, paths.snapshotSecrets);
    } catch (error) {
      if (error instanceof SnapshotMoveUncertainError && error.sourceAbsent === true) state.uncertainSidecars.push(paths.snapshotSecrets);
      throw error;
    }
    state.publishedSidecars.push(paths.snapshotSecrets);
  }
  try {
    await moveSnapshotFile(ctx, paths.staged, paths.snapshot);
  } catch (error) {
    // The archive is the commit point. If its move succeeded but the confirmation
    // failed, retain both sidecars: deleting them could expose an incomplete archive.
    state.archivePublicationUncertain = error instanceof SnapshotMoveUncertainError;
    throw error;
  }
  state.publishedArchive = true;
}

function reportPulledSnapshot(paths: PullPaths, profile: Profile, entries: string[], size: string, state: PullPublicationState): void {
  log(`pulled ${entries.length} entries (${size}), profile: ${profile}`);
  info(`required variables: ${paths.snapshotTemplate}`);
  if (state.hasStagedSecrets) info(`keys: ${paths.snapshotSecrets}`);
  info(paths.snapshot);
  if (profile === "full") warn("FULL archive — contains provider keys and the operator token. Never share it.");
  if (profile === "migrate") info("no provider keys inside; still private (transcripts, identity tokens)");
  if (profile === "share") info(`shareable profile: ${SHARE_ALLOWED.join(", ")}`);
}

/** Captures the archive and sidecars under one instance lock. Returns the published paths,
 *  for pull()'s own --json summary. */
async function pullLocked(ctx: Context, profile: Profile, hot: boolean, leaveStopped: boolean, purpose: BackupPurpose): Promise<PullPaths> {
  const snapshotDir = await ensureSnapshotDir(ctx);
  const archive = await createBackup(ctx, { profile, hot, leaveStopped, purpose });
  const paths = computePullPaths(snapshotDir);
  await refuseExistingSnapshot(ctx, paths);

  const state: PullPublicationState = {
    publishedSidecars: [],
    uncertainSidecars: [],
    hasStagedSecrets: false,
    publishedArchive: false,
    archivePublicationUncertain: false,
  };
  let stagingCreated = false;

  try {
    // Build the complete pair in a private directory. The final archive is moved last.
    await runMaybePrivileged(ctx, snapshotDir, "mkdir", ["-m", "700", paths.staging]);
    stagingCreated = true;
    await stageArchiveForPull(ctx, paths, archive, profile);

    // Sidecars are prepared and checked before any final path becomes visible.
    await stageSnapshotSidecars(ctx, paths, profile, state);

    const entries = await listArchive(ctx, paths.staged);
    const size = await fileSize(ctx, paths.staged);

    // Share verifies by unpacking and searching; migrate published without leaning on the
    // verifier at all.
    await refuseForbiddenMigrateContent(ctx, paths, archive, profile, entries);

    // Refuse collisions without replacing a previous complete snapshot.
    await publishSnapshotFiles(ctx, paths, state);

    reportPulledSnapshot(paths, profile, entries, size, state);
    await rotateSnapshots(ctx, snapshotDir);
    return paths;
  } catch (error) {
    // A failure before archive publication must not leave a discoverable partial snapshot.
    if (!state.publishedArchive && !state.archivePublicationUncertain) {
      await removeSnapshotFiles(ctx, [...state.publishedSidecars, ...state.uncertainSidecars]);
    }
    throw error;
  } finally {
    if (stagingCreated) await runMaybePrivileged(ctx, paths.staging, "rm", ["-rf", paths.staging]);
  }
}

// --- push ---------------------------------------------------------------------

/** The snapshot a bare `push` (no `<archive>`) would pick: newest first, resolved the same
 *  way whether the run is real or --dry-run. Read-only — no lock needed to compute this. */
export async function resolvePushArchive(ctx: Context, archiveArg: string | undefined): Promise<string> {
  const snapshotDir = ctx.settings.snapshotDir;
  let archive = archiveArg;
  if (archive !== undefined && !archive.startsWith("/")) archive = `${snapshotDir}/${archive}`;
  if (archive !== undefined) return archive;

  const found = (await listSnapshotArchives(ctx, snapshotDir))[0];
  if (found === undefined) die(`no snapshots in ${snapshotDir} — run ${commandLine("pull")} first`);
  return found;
}

/** `--dry-run`: shares restore's read-only preview, then reports the secrets sidecar. */
async function pushDryRun(ctx: Context, archive: string, options: RestoreOptions, jsonOnly: boolean): Promise<void> {
  const prepared = await prepareRestore(ctx, archive, options, "preview");
  const plan = await buildRestorePlan(ctx, prepared, options);
  const secretsPath = `${archive}${SECRETS_SUFFIX}`;
  const hasSecrets = await ctx.transport.exists(secretsPath);

  if (jsonOnly) {
    emit(`${JSON.stringify({ ok: true, changed: false, dryRun: true, ...plan, secretsToInstall: hasSecrets ? secretsPath : null }, null, 2)}\n`);
    return;
  }
  log(`push --dry-run: would restore ${plan.dataDir} from ${plan.archiveName}, then install keys and start`);
  printRestorePlan(plan);
  info(hasSecrets ? `would install provider keys from ${secretsPath}` : `no ${SECRETS_SUFFIX} beside the archive — provider keys would not be installed`);
  info("does not cover: whether the restored config's required secrets are actually satisfied — a real push checks that before starting");
}

export const PUSH = commandBody({
  effect: "destroy",
  arguments: PUSH_ARGUMENTS,
  async run(ctx, values) {
    const jsonOnly = values.json === true;

    if (values["dry-run"] === true) {
      const archive = await resolvePushArchive(ctx, values.archive);
      const options: RestoreOptions = { force: values.force === true, freshIdentity: values["fresh-identity"] === true, noStart: true };
      return pushDryRun(ctx, archive, options, jsonOnly);
    }

    if (jsonOnly) {
      let outcome: { archive: string; secretsInstalled: boolean; started: boolean } | undefined;
      let caught: unknown;
      await withOutputSink(() => {}, async () => {
        try {
          outcome = await guardedWith(ctx, "push", takeoverOf(values), () => restoreFromSnapshot(ctx, values));
        } catch (error) {
          caught = error;
        }
      });
      if (caught !== undefined) {
        const message = caught instanceof Error ? caught.message : String(caught);
        emit(`${JSON.stringify({ ok: false, changed: true, problems: [message] }, null, 2)}\n`);
        throw caught;
      }
      emit(`${JSON.stringify({ ok: true, changed: true, ...outcome }, null, 2)}\n`);
      return;
    }

    await guardedWith(ctx, "push", takeoverOf(values), () => restoreFromSnapshot(ctx, values));
  },
});

async function restoreFromSnapshot(ctx: Context, values: Values<typeof PUSH_ARGUMENTS>): Promise<{ archive: string; secretsInstalled: boolean; started: boolean }> {
  const force = values.force === true;
  const freshIdentity = values["fresh-identity"] === true;

  const archive = await resolvePushArchive(ctx, values.archive);
  if (values.archive === undefined) log(`using the newest snapshot: ${archive}`);

  const secretsPath = `${archive}${SECRETS_SUFFIX}`;
  const hasSecrets = await ctx.transport.exists(secretsPath);

  // Never started by restore: the restored config references environment variables, and
  // starting before they are in place is a crash-loop on SecretRefResolutionError with the
  // reason buried in the gateway's own log.
  await restoreArchive(ctx, archive, { force, freshIdentity, noStart: true });

  if (hasSecrets) {
    log("installing provider keys from the snapshot");
    await loadSecrets(ctx, await ctx.transport.readFile(secretsPath));
  } else {
    info(`no ${SECRETS_SUFFIX} beside the archive — provider keys were not installed`);
  }

  // Whatever the keys came from, the restored config decides what is actually required.
  try {
    await preflightSecrets(ctx);
  } catch (error) {
    if (!(error instanceof MissingSecretsError)) throw error;
    warn(error.message);
    info("the instance is restored but left stopped");
    info(`supply the keys with: ${commandLine(["secrets", "--apply", "--store", "<name>"])}, then ${commandLine("up")}`);
    return { archive, secretsInstalled: hasSecrets, started: false };
  }

  log("starting the gateway");
  await ctx.runtime.start();
  await ctx.runtime.waitForHealth();
  log("gateway is healthy");

  log("state pushed");
  return { archive, secretsInstalled: hasSecrets, started: true };
}
