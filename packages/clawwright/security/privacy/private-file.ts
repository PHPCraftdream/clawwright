import { chmod, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnLocal } from "../../runtime/transport/transport.ts";
import { createPathBridge } from "../../core/paths.ts";
import { info, warn } from "../../core/io/log.ts";
import { docsUrl } from "../../core/io/docs-url.ts";

const PRIVATE_MODE = 0o600;
// A private directory, unlike a file, needs the owner's execute bit to stay enterable.
const DIRECTORY_MODE = 0o700;

// The only trustees a credential file may carry: its owner plus LOCAL SYSTEM and the local
// Administrators group, by SID. icacls's display names are localized, so trustee names must
// never decide access — SIDs read the same on every machine.
const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";

// SDDL — what `icacls /save` writes — names well-known trustees with aliases and everything
// else with its full SID; both are locale-independent.
const SDDL_TRUSTEE_SIDS: Record<string, string> = {
  BA: ADMINISTRATORS_SID,
  SY: SYSTEM_SID,
};

/** Windows system tools by absolute path: a Git-Bash-style PATH puts its own whoami ahead
 *  of the Windows one, and its answer means nothing to icacls. */
function systemTool(name: string): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
}
function mountedWindowsPath(file: string): boolean {
  return process.platform === "linux" && /^\/mnt\/[a-z](?:\/|$)/i.test(resolve(file));
}

function filesystemAdvice(file: string): string {
  return mountedWindowsPath(file)
    ? "the path is on a mounted Windows/DrvFs filesystem; move the deployment into the Linux filesystem or configure Windows ACLs before retrying"
    : "check the filesystem and its ownership before retrying";
}

/** Runs one local support tool and hands the result back as data; `errno` carries the spawn
 *  failure's own cause, so a caller can tell "not on this machine" (ENOENT) from any other
 *  failure. */
export type ToolRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number; errno?: string; output: string }>;

const spawnTool: ToolRunner = async (command, args, timeoutMs) => {
  try {
    const result = await spawnLocal(command, args, { allowFailure: true, timeoutMs });
    return { code: result.code, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    return { code: -1, errno: (error as NodeJS.ErrnoException).code, output: (error as Error).message };
  }
};

// Module-level, not a parameter: callers needing to swap it are arbitrarily deep. Checks
// script Windows/WSL tools through this seam; production always reaches the real tools.
let toolRunner: ToolRunner = spawnTool;

/** Runs `body` with support tools answered by `substitute` instead of executed. */
export async function withToolRunner<T>(substitute: ToolRunner, body: () => Promise<T>): Promise<T> {
  const previous = toolRunner;
  toolRunner = substitute;
  try {
    return await body();
  } finally {
    toolRunner = previous;
  }
}

async function runTool(command: string, args: string[], timeoutMs: number): Promise<{ code: number; errno?: string; output: string }> {
  return toolRunner(command, args, timeoutMs);
}

async function windowsOwnerSid(file: string): Promise<string> {
  const who = await runTool(systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], 30_000);
  const sid = /S-1-\d+(?:-\d+)+/.exec(who.output)?.[0];
  if (who.code !== 0 || sid === undefined) {
    throw new Error(`cannot determine the Windows owner for ${file}: ${who.output.trim() || `exit ${who.code}`}`);
  }
  return sid;
}

/** Builds the DACL from nothing rather than patching it: drop inheritance, remove every
 *  foreign trustee, grant the closed SID set. No /reset in front — it would restore the
 *  parent's inheritable access onto a file that already held its secret. Every step here can
 *  only narrow, so a failure leaves the file no wider than it arrived. */
async function grantWindowsAcl(file: string, directory = false): Promise<string> {
  const owner = await windowsOwnerSid(file);
  const foreign = new Set(
    (await savedAces(file)).aces
      .filter((ace) => !ace.flags.includes("ID"))
      .map((ace) => ace.trustee)
      .filter((trustee) => ![owner, SYSTEM_SID, ADMINISTRATORS_SID].includes(resolvedTrustee(trustee, owner))),
  );
  const rights = directory ? "(OI)(CI)F" : "F";
  const grant = await runTool(
    systemTool("icacls.exe"),
    [
      file,
      "/inheritance:r",
      ...[...foreign].flatMap((trustee) => ["/remove", `*${trustee}`]),
      "/grant:r",
      `*${owner}:${rights}`,
      `*${SYSTEM_SID}:${rights}`,
      `*${ADMINISTRATORS_SID}:${rights}`,
    ],
    15_000,
  );
  if (grant.code !== 0) {
    throw new Error(`icacls failed for ${file} (exit ${grant.code}): ${grant.output.trim() || "no details"}`);
  }
  return owner;
}

/** Reads the DACL back through `icacls /save`: the SDDL it writes names every trustee by SID
 *  or SID alias, so verification cannot be fooled by a localized display name. */
async function savedAces(
  file: string,
): Promise<{ daclProtected: boolean; aces: { type: string; flags: string; rights: string; trustee: string }[] }> {
  const saved = join(tmpdir(), `clawwright-dacl-${randomBytes(6).toString("hex")}.txt`);
  try {
    const result = await runTool(systemTool("icacls.exe"), [file, "/save", saved], 15_000);
    if (result.code !== 0) {
      throw new Error(`icacls /save failed for ${file} (exit ${result.code}): ${result.output.trim() || "no details"}`);
    }
    const text = await readFile(saved, "utf16le");
    const line = text.split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.startsWith("D:"));
    if (line === undefined) {
      throw new Error(`could not read back the ACL of ${file}: icacls wrote no DACL line`);
    }
    const aces = [...line.matchAll(/\(([^()]*)\)/g)].map((match) => {
      const [type = "", flags = "", rights = "", , , trustee = ""] = match[1].split(";");
      return { type, flags, rights, trustee };
    });
    return { daclProtected: /^D:([A-Z]*)/.exec(line)?.[1]?.includes("P") === true, aces };
  } finally {
    await rm(saved, { force: true }).catch(() => {});
  }
}

function trusteeSid(trustee: string): string {
  return SDDL_TRUSTEE_SIDS[trustee.toUpperCase()] ?? trustee;
}

/** Resolves a trustee against a known owner SID, folding icacls's "LA" alias into the owner
 *  it names. LA is the SDDL alias for a machine's built-in Administrator (RID 500), not a
 *  fixed SID; when the owner IS that account, icacls prints its ACE as "LA" and a byte
 *  comparison would misread it as foreign. Resolved only when the owner actually is RID 500. */
function resolvedTrustee(trustee: string, owner: string): string {
  if (trustee.toUpperCase() === "LA" && owner.endsWith("-500")) return owner;
  return trusteeSid(trustee);
}

/** Proves the grant instead of trusting it: only allowed trustees may appear, the DACL must
 *  be sealed against inheritance, and the owner must hold full access. Reported by SID. */
async function assertDaclOwnerOnly(file: string, owner: string): Promise<void> {
  const { daclProtected, aces } = await savedAces(file);
  const allowed = new Set([owner, SYSTEM_SID, ADMINISTRATORS_SID]);
  const foreign = aces.filter((ace) => !allowed.has(resolvedTrustee(ace.trustee, owner)));
  if (foreign.length > 0) {
    throw new Error(
      `the ACL on ${file} still grants access to ${foreign.map((ace) => ace.trustee).join(", ")} — ` +
        "only the owner, SYSTEM and Administrators may hold a credential file",
    );
  }
  if (aces.some((ace) => ace.type !== "A")) {
    throw new Error(`the ACL on ${file} carries an entry that is not an allow ACE`);
  }
  if (!daclProtected || aces.some((ace) => ace.flags.includes("ID"))) {
    throw new Error(`the ACL on ${file} still inherits entries from its parent directory`);
  }
  if (!aces.some((ace) => resolvedTrustee(ace.trustee, owner) === owner && /^FA$/i.test(ace.rights))) {
    throw new Error(`the ACL on ${file} does not give the owner full access`);
  }
}

/** What listing this machine's WSL distributions found. `absent` = genuinely no Linux side;
 *  `listed` = distributions to probe; `unlisted` = enumeration failed, not evidence of "no
 *  Linux side". */
export type WslListing =
  | { state: "absent" }
  | { state: "listed"; distros: string[] }
  | { state: "unlisted"; reason: string };

/** The WSL distributions this machine can run, as far as listable. Only wsl.exe missing
 *  outright, an empty listing, or "no installed distributions" count as absent; any other
 *  failed listing is `unlisted` and must be reported, never read as "no WSL". */
export async function installedWslDistros(): Promise<WslListing> {
  if (process.platform !== "win32") return { state: "absent" };
  const result = await runTool(systemTool("wsl.exe"), ["-l", "-q"], 15_000);
  const text = result.output.replaceAll("\0", "");
  if (result.code === 0) {
    const distros = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
    return distros.length === 0 ? { state: "absent" } : { state: "listed", distros };
  }
  // The "no installed distributions" wording is localized; accepted here since the miss
  // direction is safe — a message that doesn't match falls into the reported branch instead.
  if (result.errno === "ENOENT" || /no installed distributions/i.test(text)) return { state: "absent" };
  return {
    state: "unlisted",
    reason: result.code < 0
      ? `wsl.exe could not be run: ${text.trim() || `code ${result.code}`}`
      : `wsl.exe -l -q exited ${result.code}: ${text.trim() || "no output"}`,
  };
}

/** The file's path inside a distribution, via the same bridge the transports use — the
 *  automount root is the distribution's own, not an assumed /mnt. Undefined off a Windows
 *  drive. */
async function automountedPath(distro: string, file: string): Promise<string | undefined> {
  const bridge = await createPathBridge({
    kind: "wsl",
    distro,
    mounts: [],
    readFile: async (path) => {
      const result = await runTool(systemTool("wsl.exe"), ["-d", distro, "-u", "root", "--exec", "cat", path], 10_000);
      if (result.code !== 0) throw new Error(result.output.trim() || `exit ${result.code}`);
      return result.output;
    },
  });
  try {
    return await bridge.toTarget(file);
  } catch {
    return undefined;
  }
}

/** The verdict the unprivileged side prints. The path arrives as "$1", never pasted into
 *  this string, so a file name stays data through every shell. No argument → NOPROBE. */
const PROBE_SCRIPT =
  'if [ "${1+set}" = set ] && [ -n "$1" ]; then ' +
  'if head -c 0 -- "$1" >/dev/null 2>&1; then echo OPEN; else echo DENIED; fi; ' +
  "else echo NOPROBE; fi";

/** Asks one distribution whether an unprivileged user can open the file. The path travels as
 *  a positional parameter at every shell hop, so no metacharacter in a name can become shell
 *  code. `head -c 0` makes the open itself the answer. Probed per file, never cached per
 *  drive: reachability depends on the file's own mode and parent directories. */
export async function probeWslOpen(distro: string, targetPath: string): Promise<string> {
  const script =
    "if command -v runuser >/dev/null 2>&1; then " +
    `runuser -u nobody -- sh -c '${PROBE_SCRIPT}' sh "$1"; ` +
    "elif command -v su >/dev/null 2>&1; then " +
    `su -s /bin/sh -c '${PROBE_SCRIPT}' nobody sh "$1"; ` +
    "else echo NOPROBE; fi";
  const result = await runTool(
    systemTool("wsl.exe"),
    ["-d", distro, "-u", "root", "--exec", "sh", "-c", script, "sh", targetPath],
    15_000,
  );
  const verdict = result.output.replaceAll("\0", "").trim();
  if (verdict === "OPEN" || verdict === "DENIED") return verdict;
  return `no verdict (exit ${result.code})`;
}

/** Directories already reported this process. Avoids re-running wsl.exe (once per installed
 *  distribution) for every write of a deployment's .env. Keyed on the containing directory,
 *  kept for the process's lifetime only. */
const reportedBoundaryDirs = new Set<string>();

/** Test-only seam: the checks below script the same probe repeatedly against different
 *  answers and need it un-throttled, unlike every real caller. */
export function resetWslBoundaryDedupe(): void {
  reportedBoundaryDirs.clear();
}

/** Fixed phrases of the boundary report, exported so checks assert the same text the
 *  product prints instead of restating it. */
export const WSL_BOUNDARY_NOTE = "Windows/WSL boundary";
export const UNLISTED_NOTE = "could not be listed";
export const OPEN_IN_ANOTHER_PROGRAM = "open in another program";

/** What the boundary probe below found, before either caller turns it into text. */
type WslBoundaryFindings = { exposed: { distro: string; targetPath: string }[]; unverified: string[] };

/** The Windows half is only half the protection when WSL is installed: every drive is
 *  automounted into every distribution, and a Windows ACL carries no weight between Linux
 *  users across that boundary. Reported rather than enforced: each installed distribution is
 *  probed, and whatever it can open is said out loud. At most once per process per directory. */
async function findWslBoundary(file: string): Promise<WslBoundaryFindings | undefined> {
  const directory = dirname(resolve(file));
  if (reportedBoundaryDirs.has(directory)) return undefined;
  reportedBoundaryDirs.add(directory);

  const listing = await installedWslDistros();
  if (listing.state === "absent") return undefined;
  const unverified: string[] = [];
  const exposed: { distro: string; targetPath: string }[] = [];
  if (listing.state === "unlisted") {
    unverified.push(`the installed distributions ${UNLISTED_NOTE} (${listing.reason})`);
  }
  for (const distro of listing.state === "listed" ? listing.distros : []) {
    const targetPath = await automountedPath(distro, file);
    if (targetPath === undefined) {
      unverified.push(`"${distro}" has no path for it (the file is not on a Windows drive)`);
      continue;
    }
    const verdict = await probeWslOpen(distro, targetPath);
    if (verdict === "DENIED") continue;
    if (verdict === "OPEN") {
      exposed.push({ distro, targetPath });
      continue;
    }
    unverified.push(`"${distro}" at ${targetPath}: ${verdict}`);
  }
  return { exposed, unverified };
}

/** The full, two-part warning every protectPrivateFile caller gets by default. */
async function reportWslBoundary(file: string): Promise<void> {
  const findings = await findWslBoundary(file);
  if (findings === undefined) return;
  const { exposed, unverified } = findings;
  // One line naming every exposed distribution, not one each, to avoid flooding output.
  if (exposed.length > 0) {
    warn(
      `${file} is owner-only on the Windows side only: ` +
        `${exposed.map(({ distro, targetPath }) => `"${distro}" opens it as an unprivileged Linux user via ${targetPath}`).join("; ")} — ` +
        "a Windows ACL does not separate Linux users on a mounted drive",
    );
    info(
      "optional hardening: move the deployment into a distribution's own filesystem (and run the framework from " +
        "there), or give the drive restrictive DrvFs permissions in that distribution's /etc/wsl.conf",
    );
  }
  if (unverified.length > 0) {
    warn(`could not verify ${file} as owner-only across the ${WSL_BOUNDARY_NOTE} — ${unverified.join("; ")}`);
    info(
      "check by hand with: wsl.exe -d <distro> -u root --exec runuser -u nobody -- head -c 0 <path in the distribution>; " +
        "a file this opens is readable by every Linux user of this machine",
    );
  }
}

const WSL_BOUNDARY_DOC = docsUrl("guide/requirements.md#windows-acl-and-the-wsl-boundary");

/** The condensed form: one line plus a pointer to the full explanation, instead of the two
 *  warning/info pairs above. For new-app/init, which suppress reportWslBoundary at
 *  file-creation time and call this once their own "next:" block is already on screen. */
export async function wslBoundaryNote(file: string): Promise<string | undefined> {
  const findings = await findWslBoundary(file);
  if (findings === undefined) return undefined;
  if (findings.exposed.length > 0) {
    return `${file} is reachable by another Linux user under WSL — a Windows ACL does not stop that; see ${WSL_BOUNDARY_DOC}`;
  }
  if (findings.unverified.length > 0) {
    return `${file}'s exposure across the WSL boundary could not be fully verified; see ${WSL_BOUNDARY_DOC}`;
  }
  return undefined;
}

/** Ensures a credential-bearing file is owner-only, and can prove it: POSIX modes where they
 *  apply; on Windows a rebuilt SID-exact ACL plus a WSL boundary report. `boundary: false`
 *  skips that report — for a temporary file nobody will ever read a credential under. */
export async function protectPrivateFile(file: string, options: { boundary?: boolean } = {}): Promise<void> {
  if (process.platform === "win32") {
    const owner = await grantWindowsAcl(file);
    await assertDaclOwnerOnly(file, owner);
    if (options.boundary !== false) await reportWslBoundary(file);
    return;
  }

  let chmodError: unknown;
  try {
    await chmod(file, PRIVATE_MODE);
  } catch (error) {
    chmodError = error;
  }

  let mode: number;
  try {
    mode = (await stat(file)).mode & 0o777;
  } catch (error) {
    throw new Error(`cannot verify private file ${file}: ${(error as Error).message}`);
  }

  if ((mode & 0o077) !== 0) {
    const detail = chmodError === undefined
      ? `mode is ${mode.toString(8)}, expected 600`
      : `chmod failed: ${(chmodError as Error).message}; mode is ${mode.toString(8)}`;
    throw new Error(`cannot protect private file ${file}: ${detail}; ${filesystemAdvice(file)}`);
  }
}

/** Seals a directory that holds private files: 700 where POSIX modes apply, same closed
 *  SID-exact DACL on Windows. Sealed because an atomic-replace editor's temporary file
 *  inherits the DIRECTORY's access before rename. No WSL boundary probe here, unlike a file. */
export async function protectPrivateDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIRECTORY_MODE });
  if (process.platform === "win32") {
    const owner = await grantWindowsAcl(dir, true);
    await assertDaclOwnerOnly(dir, owner);
    return;
  }

  let chmodError: unknown;
  try {
    await chmod(dir, DIRECTORY_MODE);
  } catch (error) {
    // Remembered rather than fatal: on a filesystem that refuses mode changes the state
    // decides, exactly as protectPrivateFile's does.
    chmodError = error;
  }

  let mode: number;
  try {
    mode = (await stat(dir)).mode & 0o777;
  } catch (error) {
    throw new Error(`cannot verify private directory ${dir}: ${(error as Error).message}`);
  }

  if ((mode & 0o077) !== 0) {
    const detail = chmodError === undefined
      ? `mode is ${mode.toString(8)}, expected 700`
      : `chmod failed: ${(chmodError as Error).message}; mode is ${mode.toString(8)}`;
    throw new Error(`cannot protect private directory ${dir}: ${detail}; ${filesystemAdvice(dir)}`);
  }
}

/** What is wrong with `file`'s owner-only protection, or undefined when it holds. Read-only
 *  on purpose, unlike protectPrivateFile: the caller (secrets --apply) reads without
 *  rewriting, so an operator's ACL state is reported, never silently corrected. No WSL
 *  boundary probe here either — that belongs to protection. */
export async function unprotectedPrivateFile(file: string): Promise<string | undefined> {
  if (process.platform === "win32") {
    try {
      await assertDaclOwnerOnly(file, await windowsOwnerSid(file));
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  }
  let mode: number;
  try {
    mode = (await stat(file)).mode & 0o777;
  } catch (error) {
    return `its mode could not be read: ${(error as Error).message}`;
  }
  return (mode & 0o077) === 0 ? undefined : `mode is ${mode.toString(8)}, expected 600`;
}

/** Creates a private file without exposing its first byte under the process umask. `temp:
 *  true` skips the WSL boundary report (replacePrivateFile's temporary file). `boundary:
 *  false` skips it too, for a caller that prints its own condensed note later. */
async function createPrivateFileContent(file: string, content: string | Uint8Array, options: { temp?: boolean; boundary?: boolean } = {}): Promise<void> {
  const boundary = options.boundary ?? options.temp !== true;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(file, "wx", PRIVATE_MODE);
    created = true;
    if (process.platform === "win32") {
      await handle.close();
      handle = undefined;
      await protectPrivateFile(file, { boundary });
      handle = await open(file, "r+");
    }
    if (typeof content === "string") await handle.writeFile(content, "utf8");
    else await handle.writeFile(content);
  } catch (error) {
    if (created) await unlink(file).catch(() => {});
    throw error;
  } finally {
    await handle?.close();
  }
  try {
    if (process.platform !== "win32") await protectPrivateFile(file, { boundary });
  } catch (error) {
    await unlink(file).catch(() => {});
    throw error;
  }
}

export function createPrivateFile(file: string, content: string, options?: { temp?: boolean; boundary?: boolean }): Promise<void> {
  return createPrivateFileContent(file, content, options);
}

export function createPrivateBinaryFile(file: string, content: Uint8Array): Promise<void> {
  return createPrivateFileContent(file, content);
}

/** Host this module judges the rename retry by — injectable so the Windows-only path is
 *  provable from any host. */
export const privateFileHost: { platform: string } = { platform: process.platform };

type Renamer = (from: string, to: string) => Promise<void>;
let renamer: Renamer = rename;

/** Swappable for checks: real Windows file-lock contention isn't reproducible on demand, so
 *  the retry is proven against a scripted failure instead. */
export async function withPrivateFileRenamer<T>(substitute: Renamer, body: () => Promise<T>): Promise<T> {
  const previous = renamer;
  renamer = substitute;
  try {
    return await body();
  } finally {
    renamer = previous;
  }
}

const RENAME_RETRY_ATTEMPTS = 5;
const RENAME_RETRY_DELAY_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** POSIX rename(2) replaces an open target without complaint — nothing to retry there.
 *  Windows can hold the target open (an editor, an antivirus scan) and MoveFileEx fails
 *  EPERM/EBUSY for a hold usually gone a moment later. A short retry absorbs that. */
export async function renameOverPrivateFile(temporary: string, file: string): Promise<void> {
  const attempts = privateFileHost.platform === "win32" ? RENAME_RETRY_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renamer(temporary, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EBUSY";
      if (!transient || attempt >= attempts) {
        if (privateFileHost.platform === "win32" && transient) {
          throw new Error(
            `could not replace ${file}: it appears to be ${OPEN_IN_ANOTHER_PROGRAM} (an editor, backup tool or ` +
              `antivirus scan) — close it and retry (${(error as Error).message})`,
          );
        }
        throw error;
      }
      await delay(RENAME_RETRY_DELAY_MS * attempt);
    }
  }
}

/** Replaces a private file atomically on the same filesystem. */
export async function replacePrivateFile(file: string, content: string): Promise<void> {
  // Random per call: a PID+timestamp name once collided across replacements, and the old
  // cleanup deleted a temporary this call never created. `created` scopes cleanup to files
  // this call actually made.
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let created = false;
  try {
    await createPrivateFile(temporary, content, { temp: true });
    created = true;
    await renameOverPrivateFile(temporary, file);
  } catch (error) {
    if (created) await unlink(temporary).catch(() => {});
    throw error;
  }
  await protectPrivateFile(file);
}
