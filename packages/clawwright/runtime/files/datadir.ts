// Preparing the target's data directory.
//
// The image runs as `node` (uid 1000), so the bind-mounted directories must belong to
// 1000:1000 or the gateway cannot write. Privileged calls are made only when the
// filesystem actually demands them — blindly prefixing sudo would prompt for a password on
// every routine run, which is how the shell version once hung.

import { log, info, die } from "../../core/io/log.ts";
import { renderArguments } from "../../core/io/invocation/render.ts";
import type { Context } from "../../core/context.ts";
import { lockHome } from "../lock/instance-lock.ts";

/** The fixed uid:gid the image runs as. Exported for callers that need to force escalation
 *  against it directly — a writable-probe on a tree's root says nothing about a
 *  restrictively-owned child underneath. */
export const OWNER = "1000:1000";
/** The standard layout of a data directory: what restore promises, and ensureDataDirs
 *  creates. Exported so restore can check these paths are physically inside the restored
 *  tree before creating, chmod-ing or deleting through them. */
export const DATA_SUBDIRS = ["config", "workspace", "auth-secrets"] as const;

export const SUDO_PASSWORD_REFUSAL = "sudo asks for a password, which cannot be typed here";

/** Provenance marker written by ensureDataDirs into a data root it created or adopted: its
 *  presence licenses narrow drift re-owning on later runs; its absence makes ensureDataDirs
 *  refuse to re-own anything. Exported for the check fixtures. */
export const DATA_DIR_MARKER = ".clawwright-data-dir";

const DATA_DIR_MARKER_CONTENT =
  "clawwright data directory — created or adopted by clawwright (runtime/files/datadir.ts).\n" +
  "Written by ensureDataDirs; its presence is what keeps ownership maintenance narrow:\n" +
  "a tree without it was not set up by this framework and is never re-owned automatically.\n";

type SudoAvailability = "absent" | "password" | "usable";
const sudoAnswers = new WeakMap<Context, SudoAvailability>();

/** Whether passwordless sudo works on the target, probed once per context. Both probes go
 *  through answeredProbe: a transport hiccup throws and is never cached as "no sudo".
 *  -n always: a password prompt has nowhere to appear over wsl.exe/ssh pipes and would hang. */
async function sudoAvailability(ctx: Context): Promise<SudoAvailability> {
  const known = sudoAnswers.get(ctx);
  if (known !== undefined) return known;
  let answer: SudoAvailability = "absent";
  if ((await answeredProbe(ctx, "sh", ["-c", "command -v sudo"], [0, 1, 127])).code === 0) {
    answer = (await answeredProbe(ctx, "sudo", ["-n", "true"], [0, 1])).code === 0 ? "usable" : "password";
  }
  sudoAnswers.set(ctx, answer);
  return answer;
}

/** "sudo" when the path is not writable by the current user, "" otherwise. `force: true`
 *  skips the writability shortcut: writable never implies a chown to some OTHER owner will
 *  succeed, so a caller that knows the target owner differs forces the sudo-availability
 *  path instead of trusting `test -w`. */
export async function sudoFor(ctx: Context, path: string, options: { force?: boolean } = {}): Promise<string[]> {
  let probe = path;
  while (probe !== "/" && probe !== "") {
    let present: boolean | undefined;
    // A refusal that repeats means a parent this user may not enter, which already answers
    // "can I write there without escalating": no. One that does not repeat was the transport
    // hiccuping (a wsl.exe/ssh call under load), and must not read as "needs root".
    for (let attempt = 0; attempt < 3 && present === undefined; attempt += 1) {
      try {
        present = await ctx.transport.exists(probe);
      } catch {
        // Ask again.
      }
    }
    if (present === undefined || present) break;
    probe = probe.slice(0, Math.max(probe.lastIndexOf("/"), 1));
  }

  if (options.force !== true) {
    const writable = await answeredProbe(ctx, "test", ["-w", probe], [0, 1]);
    if (writable.code === 0) return [];
  }

  const availability = await sudoAvailability(ctx);
  if (availability === "absent") die(`${probe} is not writable and sudo is not available on the target`);
  if (availability === "password") {
    const advice = await prepareFamilyAdvice(ctx);
    die(
      `${probe} needs root and ${SUDO_PASSWORD_REFUSAL}.\n` +
        "Prepare it once on the target — everything this deployment will need, not just this path:\n" +
        advice.map((line) => `  ${line}`).join("\n") +
        "\nor point OC_DATA_DIR (and OC_BACKUP_DIR/OC_SNAPSHOT_DIR) in the deployment's .env at directories you already own.",
    );
  }
  return ["sudo", "-n"];
}

/** `sudo -n` for reading a file this user may not read, [] when it may. Refuses in terms of the
 *  read: sudoFor's advice is about preparing directories to write. */
export async function sudoForRead(ctx: Context, path: string): Promise<string[]> {
  const readable = await answeredProbe(ctx, "test", ["-r", path], [0, 1]);
  if (readable.code === 0) return [];
  const availability = await sudoAvailability(ctx);
  if (availability !== "usable") {
    const why = availability === "password" ? SUDO_PASSWORD_REFUSAL : "sudo is not available on the target";
    die(`${path} is not readable by this user and ${why} — run as its owner (uid 1000) or allow passwordless sudo`);
  }
  return ["sudo", "-n"];
}

/** Runs a command, escalating only if the given path requires it. */
export async function runMaybePrivileged(
  ctx: Context,
  pathNeedingAccess: string,
  command: string,
  args: string[],
  options: { force?: boolean } = {},
): Promise<void> {
  const prefix = await sudoFor(ctx, pathNeedingAccess, options);
  const [head, ...rest] = [...prefix, command, ...args];
  await ctx.transport.exec(head, rest);
}

/** Splits an immediate parent from a path, on whichever separator it uses — kept local since
 *  this module has no other reason to import env.ts. */
function parentOf(path: string): string {
  const separator = path.includes("\\") ? "\\" : "/";
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? "" : path.slice(0, cut) || separator;
}

/** One "sudo install -d" line for a group of paths needing the same owner. Collapsed to
 *  their shared parent when more than one sits directly under it. A single path is named as
 *  itself — re-chowning a shared parent another group needs would undo its preparation. */
function prepareCommand(owner: string, paths: string[]): string {
  const [uid, gid] = owner.split(":");
  const parents = new Set(paths.map(parentOf));
  const target = paths.length > 1 && parents.size === 1 ? [...parents][0] : paths;
  return renderArguments(["sudo", "install", "-d", "-o", uid, "-g", gid, ...(Array.isArray(target) ? target : [target])]);
}

/** Every directory this deployment needs prepared with elevated privileges, grouped by owner:
 *  the container's fixed uid (data/backups/snapshots) and whoever runs the tooling (lock
 *  home). Read from ctx.settings so the advice always matches the ctx that hit the refusal. */
async function dataFamily(ctx: Context): Promise<Map<string, string[]>> {
  const groups = new Map<string, string[]>();
  const add = (owner: string, path: string | undefined): void => {
    if (path === undefined || path === "") return;
    const existing = groups.get(owner) ?? [];
    if (!existing.includes(path)) groups.set(owner, [...existing, path]);
  };
  add(OWNER, ctx.settings.dataDir);
  add(OWNER, ctx.settings.backupDir);
  add(OWNER, ctx.settings.snapshotDir);
  let current: string | undefined;
  try {
    current = await targetOwner(ctx);
  } catch {
    // Best effort advisory message; falling back to OWNER merges the lock home into the same
    // group, correct in the common case (WSL default user at uid 1000) and harmless otherwise.
    current = undefined;
  }
  add(current ?? OWNER, lockHome(ctx));
  return groups;
}

/** The commands to hand the operator so one pass covers every directory this deployment
 *  will need, not just the path that happened to fail first. When whoever runs the tooling
 *  already IS uid 1000, every group collapses into one line for the whole family. */
async function prepareFamilyAdvice(ctx: Context): Promise<string[]> {
  const groups = await dataFamily(ctx);
  return [...groups.entries()].map(([owner, paths]) => prepareCommand(owner, paths));
}

async function ownerOf(ctx: Context, path: string): Promise<string> {
  const result = await ctx.transport.exec("stat", ["-c", "%u:%g", path], { allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : "";
}

/** Whether handing a path to `fixedOwner` needs root: true except for root or the owner
 *  itself, the two identities POSIX lets chown without CAP_CHOWN. */
export async function needsOwnerEscalation(ctx: Context, fixedOwner: string): Promise<boolean> {
  const uid = await answeredProbe(ctx, "id", ["-u"], [0]);
  if (uid.stdout.trim() === "0") return false;
  const gid = await answeredProbe(ctx, "id", ["-g"], [0]);
  return `${uid.stdout.trim()}:${gid.stdout.trim()}` !== fixedOwner;
}

/** A probe whose exit code IS the answer: `answers` are the codes the tool itself gives. Any
 *  other code means the probe never ran, and reading that as "no" turns a transport hiccup
 *  into a sudo refusal. Retried, then reported as what it is. */
export async function answeredProbe(ctx: Context, command: string, args: string[], answers: readonly number[]): Promise<{ code: number; stdout: string }> {
  let last = { code: -1, stdout: "", stderr: "" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await ctx.transport.exec(command, args, { allowFailure: true });
    if (answers.includes(last.code)) return last;
  }
  throw new Error(`could not run \`${command} ${renderArguments(args)}\` on the target (exit ${last.code}${last.stderr.trim() ? `: ${last.stderr.trim()}` : ""}) — the transport failed, not the check`);
}

/** Resolves `path` through every symlink on the target, optionally through a privileged
 *  `prefix`; dies when it can't. "Cannot verify" must never read as "verified" — every
 *  caller is about to act through this path. */
export async function physicalPath(ctx: Context, path: string, prefix: string[] = []): Promise<string> {
  const [head, ...rest] = [...prefix, "readlink", "-f", path];
  const resolved = await ctx.transport.exec(head, rest, { allowFailure: true });
  const canonical = resolved.stdout.trim();
  if (resolved.code !== 0 || canonical === "") {
    die(`cannot resolve ${path} on the target: ${resolved.stderr.trim() || "the path does not resolve"}`);
  }
  return canonical;
}

/** The canonical destructive root, verified before anything is created or re-owned. `test -L
 *  dataDir` sees only the final component: a symlink one level UP redirects every later
 *  mkdir/chown/chmod while the configured path still looks harmless. So the ancestry is
 *  walked up to the deepest existing ancestor, resolved, and required to equal the
 *  configured one. `prefix` — or a callback making it from the probe — is prepended to the
 *  readlink, so a caller that acts privileged (restore) verifies through the same privileges.
 *  One implementation for datadir and restore: the two copies had already diverged (R32-11). */
export async function assertCanonicalAncestry(
  ctx: Context,
  dataDir: string,
  prefix: string[] | ((probe: string) => Promise<string[]>) = [],
): Promise<void> {
  let probe = dataDir;
  for (;;) {
    let present: boolean;
    try {
      present = await ctx.transport.exists(probe);
    } catch {
      break; // the transport refuses to answer — readlink below fails closed
    }
    if (present) break;
    const parent = probe.slice(0, Math.max(probe.lastIndexOf("/"), 1));
    if (parent === probe) break;
    probe = parent;
  }
  const canonical = await physicalPath(ctx, probe, typeof prefix === "function" ? await prefix(probe) : prefix);
  // An empty answer with exit 0 is a refusal, not a confirmation ("cannot verify" never
  // reads as "verified") — physicalPath died on it above.
  if (canonical !== probe) {
    die(
      `${dataDir} would act through ${canonical}: ${probe} sits behind a symlink, so creating or ` +
        "re-owning it would reach a different tree than OC_DATA_DIR names — " +
        "point OC_DATA_DIR at the real path",
    );
  }
}

/** A pre-existing standard path must resolve inside the verified root before this run acts
 *  through it: a link resolving WITHIN the tree is tolerated, outside is refused. */
async function assertResolvesInsideRoot(ctx: Context, path: string, root: string): Promise<void> {
  const physical = await physicalPath(ctx, path);
  if (physical !== root && !physical.startsWith(`${root}/`)) {
    die(`refusing ${path}: it resolves to ${physical}, outside the data directory ${root}`);
  }
}

/** Hands exactly `paths` to the fixed owner, never `-R`: ownership follows creation and
 *  provenance, not whatever a directory happens to contain. */
async function chownToOwner(ctx: Context, paths: string[], why: string): Promise<void> {
  const wrong: string[] = [];
  for (const path of paths) {
    if ((await ownerOf(ctx, path)) !== OWNER) wrong.push(path);
  }
  if (wrong.length === 0) return;
  log(`${why}: setting owner ${OWNER} on ${wrong.join(" ")}`);
  await runMaybePrivileged(ctx, wrong[0], "chown", [OWNER, ...wrong], {
    force: await needsOwnerEscalation(ctx, OWNER),
  });
}

/** Whether `dataDir` itself is a symlink, and where it points — undefined for a real
 *  directory. `chown -R` dereferences a symlink named directly on its command line before
 *  recursing, so a data directory that's actually a link would chown whatever it resolves
 *  to. Checked separately from ownerOf/sudoFor, which answer "who owns this path", not "is
 *  this path what it claims to be". */
async function dataDirSymlinkTarget(ctx: Context, dataDir: string): Promise<string | undefined> {
  const check = await ctx.transport.exec("test", ["-L", dataDir], { allowFailure: true });
  if (check.code === 1) return undefined;
  if (check.code !== 0) {
    die(`could not check whether ${dataDir} is a symlink (exit ${check.code}): ${check.stderr.trim()}`);
  }
  const resolved = await ctx.transport.exec("readlink", ["-f", dataDir], { allowFailure: true });
  const target = resolved.stdout.trim();
  return resolved.code === 0 && target !== "" ? target : dataDir;
}

/** Creates config/, workspace/ and auth-secrets/ and makes sure uid 1000 owns them. Ordered
 *  so every verification precedes every mutation, and ownership is changed only for paths
 *  this run can account for. No `chown -R`: recursion is what turned a mistyped OC_DATA_DIR
 *  into a whole-tree re-owning. A pre-existing tree without the marker is never re-owned. */
export async function ensureDataDirs(
  ctx: Context,
  options: { trustExisting?: boolean } = {},
): Promise<void> {
  const { dataDir } = ctx.settings;
  const marker = `${dataDir}/${DATA_DIR_MARKER}`;

  const linkTarget = await dataDirSymlinkTarget(ctx, dataDir);
  if (linkTarget !== undefined) {
    die(
      `data directory ${dataDir} is a symlink to ${linkTarget}: working through it would reach ` +
        "whatever it points at, not just this deployment's own tree — " +
        "point OC_DATA_DIR at a real directory (the link's target is one) and run this again",
    );
  }
  await assertCanonicalAncestry(ctx, dataDir);

  // The created/pre-existing split below is the whole ownership policy, so it's read, not
  // assumed.
  const rootExisted = await ctx.transport.exists(dataDir);
  const markerExists = rootExisted && (await ctx.transport.exists(marker));
  // trustExisting is for a caller that created/extracted the tree earlier in the SAME
  // operation, where "pre-existing" only means "this call didn't create it" — without it a
  // freshly restored tree reads as an untrusted adoption.
  const ours = markerExists || options.trustExisting === true;
  const existed = new Map<string, boolean>();
  for (const sub of DATA_SUBDIRS) {
    existed.set(sub, await ctx.transport.exists(`${dataDir}/${sub}`));
  }
  const preExisting: string[] = [];
  if (rootExisted) preExisting.push(dataDir);
  for (const sub of DATA_SUBDIRS) {
    if (existed.get(sub) === true) preExisting.push(`${dataDir}/${sub}`);
  }

  // Must resolve inside the (already canonical) root before this run chowns/chmods through it.
  for (const path of preExisting) {
    if (path !== dataDir) await assertResolvesInsideRoot(ctx, path, dataDir);
  }

  // Provenance gate: without the marker a wrong owner is refused, never corrected.
  if (!ours) {
    for (const path of preExisting) {
      const owner = await ownerOf(ctx, path);
      if (owner === OWNER) continue;
      die(
        `refusing to take ownership of ${path}${owner === "" ? "" : ` (owned by ${owner})`}: ` +
          `${dataDir} carries no ${DATA_DIR_MARKER} marker, so nothing proves clawwright created this ` +
          "tree, and re-owning a directory this deployment did not set up is how a shared or system " +
          "directory gets handed to the container's uid.\n" +
          "If it really is this deployment's data, adopt it explicitly once:\n" +
          `  sudo chown -R ${OWNER} ${dataDir}\n` +
          "then run this again — the marker written then keeps every future maintenance pass narrow",
      );
    }
  }

  const created: string[] = [];
  if (!rootExisted) {
    log(`creating ${dataDir}`);
    const made = await ctx.transport.exec("mkdir", ["-p", dataDir], { allowFailure: true });
    if (made.code !== 0) await runMaybePrivileged(ctx, dataDir, "mkdir", ["-p", dataDir]);
    created.push(dataDir);
  }
  for (const sub of DATA_SUBDIRS) {
    if (existed.get(sub) === true) continue;
    const dir = `${dataDir}/${sub}`;
    log(`creating ${dir}`);
    const made = await ctx.transport.exec("mkdir", ["-p", dir], { allowFailure: true });
    if (made.code !== 0) await runMaybePrivileged(ctx, dir, "mkdir", ["-p", dir]);
    created.push(dir);
  }

  // Written BEFORE either chown: writing it after can die EACCES once ownership differs.
  if (!markerExists) {
    await ctx.transport.writeFile(marker, DATA_DIR_MARKER_CONTENT, "644");
    log(`recorded provenance in ${marker}`);
  }
  await chownToOwner(ctx, created, "created by this run");
  if (ours) {
    await chownToOwner(ctx, preExisting, "ownership drift on a proven clawwright data directory");
  }

  // auth-secrets holds encryption keys.
  const secretsDir = `${dataDir}/auth-secrets`;
  const mode = await ctx.transport.exec("stat", ["-c", "%a", secretsDir], { allowFailure: true });
  if (mode.stdout.trim() !== "700") {
    await runMaybePrivileged(ctx, secretsDir, "chmod", ["700", secretsDir]);
  }

  await ensureLockHome(ctx);
}

/** Somewhere the instance lock can actually be created. Has to live outside the data
 *  directory, because `restore` replaces that whole tree — but "outside" lands in a parent
 *  bootstrap never chowned, which can stay root:root. Owned by whoever runs the tooling
 *  rather than uid 1000: the container never sees this directory. */
export async function ensureLockHome(ctx: Context): Promise<void> {
  const home = lockHome(ctx);

  if (!(await ctx.transport.exists(home))) {
    log(`creating ${home}`);
    const created = await ctx.transport.exec("mkdir", ["-p", home], { allowFailure: true });
    if (created.code !== 0) {
      // The parent needs root. Create and hand it over in one step, so later runs never
      // escalate for it again.
      await runMaybePrivileged(ctx, home, "mkdir", ["-p", home]);
      await runMaybePrivileged(ctx, home, "chown", [await targetOwner(ctx), home]);
    }
  }

  if (await isWritable(ctx, home)) return;

  log(`making ${home} writable`);
  await runMaybePrivileged(ctx, home, "chown", [await targetOwner(ctx), home]);

  // Checked rather than assumed: an ownership change that didn't take resurfaces later as an
  // unrelated failed claim.
  if (!(await isWritable(ctx, home))) {
    const advice = await prepareFamilyAdvice(ctx);
    die(
      `${home} is still not writable after preparing it.\n` +
        `The instance lock is created there, so nothing that changes this deployment can run.\n` +
        "Prepare it once on the target — everything this deployment will need, not just this path:\n" +
        advice.map((line) => `  ${line}`).join("\n"),
    );
  }
}

async function isWritable(ctx: Context, path: string): Promise<boolean> {
  const result = await ctx.transport.exec("test", ["-w", path], { allowFailure: true });
  return result.code === 0;
}

/** The uid and gid of whoever runs the tooling ON THE TARGET, read before any escalation.
 *  `sudo -n sh -c 'chown "$(id -u):$(id -g)" …'` looks like "hand it to the current user" but
 *  resolves to 0:0, since the substitution is evaluated by the shell sudo started. The
 *  numbers are resolved here, unprivileged, and passed to chown as plain arguments. */
async function targetOwner(ctx: Context): Promise<string> {
  const uid = await ctx.transport.exec("id", ["-u"], { allowFailure: true });
  const gid = await ctx.transport.exec("id", ["-g"], { allowFailure: true });
  if (uid.code !== 0 || gid.code !== 0) {
    die("could not read the target's user and group ids, so nothing can be handed over to them");
  }
  return `${uid.stdout.trim()}:${gid.stdout.trim()}`;
}

/** Provider credentials live here: OpenClaw reads $OPENCLAW_STATE_DIR/.env as its trusted
 *  global environment, so keys stay out of the repository and out of openclaw.json. */
export function secretsFileOnTarget(ctx: Context): string {
  return `${ctx.settings.dataDir}/config/.env`;
}

export async function ensureSecretsFile(ctx: Context): Promise<void> {
  const path = secretsFileOnTarget(ctx);
  if (await ctx.transport.exists(path)) return;

  log(`creating ${path} for provider keys`);
  await ctx.transport.writeFile(
    path,
    "# Provider credentials read by OpenClaw at startup, e.g.:\n# ANTHROPIC_API_KEY=...\n",
    "600",
  );
  await runMaybePrivileged(ctx, path, "chown", [OWNER, path], { force: await needsOwnerEscalation(ctx, OWNER) });
  info(`put provider keys there, then run ${commandLine(["configure-provider"])}`);
}
import { commandLine } from "../../core/io/invocation/render.ts";
