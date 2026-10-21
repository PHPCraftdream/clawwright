// Guarded git-worktree helper for the `worktrees/<name>/` layout. Development worktrees share
// the primary checkout's node_modules through a directory link (a junction on Windows, a
// symlink elsewhere). On Windows, `git worktree remove` has TWICE followed that link into the
// primary checkout and emptied its node_modules. This module exists so removal always unlinks
// the link first, non-recursively, and re-verifies the primary node_modules survived before
// any `git worktree remove` argv is ever handed to git — `--force` never bypasses that check.
// The pure decision functions are exported so a check file can exercise them without touching
// git or the filesystem.

import { lstatSync, rmdirSync, symlinkSync, unlinkSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

/**
 * The worktree-name grammar. Kept local rather than imported from
 * tools/framework/core/values/names.ts: that module's branded kinds are deployment-domain
 * concepts, but the pattern itself is the repo's portable name rule and must stay identical.
 */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const NAME_MAX = 64;

/** The refusal message for a bad worktree name; undefined when the name is acceptable. */
export function invalidWorktreeName(name: string): string | undefined {
  if (name.length > NAME_MAX) return `worktree name "${name}" exceeds ${NAME_MAX} characters`;
  if (!NAME_PATTERN.test(name)) return `invalid worktree name "${name}" — use lowercase letters, digits and dashes, starting with a letter`;
  return undefined;
}

/**
 * Classifies an lstat fact about a worktree's node_modules. lstat().isSymbolicLink() is true
 * for Windows junctions in Node, so "symlink" covers both link kinds. Deliberately total with
 * exactly three answers: the CLI cannot improvise a fourth.
 */
export function classifyNodeModules(kind: "symlink" | "directory" | "absent" | undefined): "link" | "real-directory" | "absent" {
  if (kind === "symlink") return "link";
  if (kind === "directory") return "real-directory";
  return "absent";
}

/** argv for `git worktree add` — the leading "worktree" lets callers execFileSync("git", argv). */
export function addArgv(name: string, base: string | undefined): string[] {
  return ["worktree", "add", "-b", name, `worktrees/${name}`, base ?? "origin/main"];
}

/** argv for `git worktree remove`. The link check always runs before this reaches git, regardless of `force`. */
export function removeArgv(path: string, force: boolean): string[] {
  return ["worktree", "remove", ...(force ? ["--force"] : []), path];
}

/** Lowercase -d: refuses unmerged branches, matching the tool's conservative posture. */
export function deleteBranchArgv(name: string): string[] {
  return ["branch", "-d", name];
}

// --- CLI --------------------------------------------------------------------------------------

function fail(message: string): never {
  process.stderr.write(`worktree: ${message}\n`);
  process.exit(1);
}

/** The primary checkout, wherever this script is run from: the common git dir's parent. A linked
 *  worktree's own root is NOT the primary checkout, and worktrees must be created beside it. */
function primaryRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: here, encoding: "utf8" }).trim();
  return dirname(common);
}

/** lstat that only treats a missing entry as absence; any other failure is unknown and refuses. */
function lstatOrAbsent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return fail(`cannot inspect ${path}: ${(error as Error).message}`);
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  const usage = "usage: npm run worktree -- add <name> [base]\n       npm run worktree -- remove <name> [--force] [--delete-branch]";
  const [command, name, ...rest] = process.argv.slice(2);
  if ((command !== "add" && command !== "remove") || name === undefined) fail(usage);
  const invalid = invalidWorktreeName(name);
  if (invalid !== undefined) fail(invalid);

  const root = primaryRoot();
  const primaryNodeModules = join(root, "node_modules");
  const worktreePath = join(root, "worktrees", name);
  const linkPath = join(worktreePath, "node_modules");
  const git = (argv: string[]): void => {
    execFileSync("git", argv, { cwd: root, stdio: "inherit" });
  };

  if (command === "add") {
    if (lstatOrAbsent(worktreePath) !== undefined) fail(`${join("worktrees", name)} already exists`);
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { cwd: root, stdio: "ignore" });
      fail(`branch ${name} already exists`);
    } catch (error) {
      // A non-zero rev-parse means the branch does not exist — the good case. Anything else is fail() above.
      if (!(error as { status?: number | null }).status) throw error;
    }
    if (lstatOrAbsent(primaryNodeModules) === undefined) fail(`${primaryNodeModules} is missing — a worktree shares the primary checkout's node_modules through a link, so there is nothing to share`);
    git(addArgv(name, rest[0]));
    try {
      symlinkSync(primaryNodeModules, linkPath, "junction");
    } catch {
      fail(`the worktree exists, but its node_modules link must be created by hand:\n  ${primaryNodeModules}\n  ${linkPath}`);
    }
  } else {
    const force = rest.includes("--force");
    const deleteBranch = rest.includes("--delete-branch");
    const found = lstatOrAbsent(linkPath);
    const kind = classifyNodeModules(found === undefined ? "absent" : found.isSymbolicLink() ? "symlink" : found.isDirectory() ? "directory" : undefined);
    if (found !== undefined && kind === "absent") fail(`${linkPath} is neither a link nor a directory — inspect it by hand`);
    if (kind === "real-directory") fail(`${linkPath} is a real directory, not the shared node_modules link — inspect it and remove it by hand if it is truly unwanted`);
    if (kind === "link") {
      try {
        unlinkSync(linkPath);
      } catch {
        // A Windows junction is dropped by a non-recursive rmdir; if that also fails the re-check below refuses.
        try {
          rmdirSync(linkPath);
        } catch {
          // Decided by the lstat below, not by this error.
        }
      }
      // Prove, never assume: the link must be gone (ENOENT, not just "an error") and the primary survive.
      if (lstatOrAbsent(linkPath) !== undefined) fail(`the link at ${linkPath} is still present — not running git worktree remove; inspect by hand`);
      if (lstatOrAbsent(primaryNodeModules) === undefined) fail(`the primary node_modules at ${primaryNodeModules} is missing — not running git worktree remove`);
    }
    git(removeArgv(join("worktrees", name), force));
    if (deleteBranch) git(deleteBranchArgv(name));
  }
}
