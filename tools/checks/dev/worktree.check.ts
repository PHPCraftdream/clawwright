// Pure parts of the worktree helper (tools/dev/worktree.ts): the worktree-name grammar, the
// node_modules link classification, and the exact git argv it would run. The git and
// filesystem steps are deliberately NOT exercised here — this check must never touch git.

import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { addArgv, classifyNodeModules, deleteBranchArgv, invalidWorktreeName, removeArgv } from "#tools/dev/worktree.ts";

// --- name grammar: must mirror names.ts's portable rule, capped at 64 chars ----------------

checkTrue("accepts 'improve'", invalidWorktreeName("improve") === undefined);
checkTrue("accepts 'fix-egress-1'", invalidWorktreeName("fix-egress-1") === undefined);
checkTrue("refuses 'Improve'", invalidWorktreeName("Improve")?.includes('"Improve"') === true);
checkTrue("refuses '-lead'", invalidWorktreeName("-lead")?.includes('"-lead"') === true);
checkTrue("refuses 'a_b'", invalidWorktreeName("a_b")?.includes('"a_b"') === true);
checkTrue("refusal names the grammar", invalidWorktreeName("a_b")?.includes("dashes") === true);
checkTrue("refuses 'a/b'", invalidWorktreeName("a/b")?.includes('"a/b"') === true);
checkTrue("refuses empty", (invalidWorktreeName("") ?? "").length > 0);
checkTrue("refuses a 65-char name", invalidWorktreeName("a".repeat(65))?.includes("64") === true);

// --- link classification: exactly three answers, no fourth --------------------------------

check("symlink classifies as link", classifyNodeModules("symlink"), "link");
check("directory classifies as real-directory", classifyNodeModules("directory"), "real-directory");
check("absent classifies as absent", classifyNodeModules("absent"), "absent");
check("undefined classifies as absent", classifyNodeModules(undefined), "absent");

// --- add argv: fixed worktrees/<name> path keeps the layout convention ---------------------

check("add argv with default base", addArgv("my-feature", undefined), [
  "worktree",
  "add",
  "-b",
  "my-feature",
  "worktrees/my-feature",
  "origin/main",
]);
check("add argv with given base", addArgv("x", "release-1"), [
  "worktree",
  "add",
  "-b",
  "x",
  "worktrees/x",
  "release-1",
]);

// --- remove argv: --force sits between "remove" and the path; the link check runs before
// this argv is ever handed to git, regardless of --force ------------------------------------

check("remove argv without --force", removeArgv("worktrees/x", false), [
  "worktree",
  "remove",
  "worktrees/x",
]);
check("remove argv with --force", removeArgv("worktrees/x", true), [
  "worktree",
  "remove",
  "--force",
  "worktrees/x",
]);

// --- branch deletion: lowercase -d refuses unmerged branches, matching the tool's posture --

check("delete-branch argv", deleteBranchArgv("x"), [
  "branch",
  "-d",
  "x",
]);

finish("worktree");
