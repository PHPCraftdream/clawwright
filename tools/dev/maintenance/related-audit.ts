// Retrospective audit of `check --related` (chunk D): replays the last N commits' diffs
// through the CURRENT selection logic — graph, rules, always tier — without running any
// check suite. The point is hindsight: does today's selection logic catch what yesterday's
// commits actually touched? Read-only git throughout; the import graph is built once and
// reused across all commits. Run via `node --experimental-strip-types tools/dev/maintenance/related-audit.ts [N]`,
// or `... --accept` for the retrospective acceptance assertions only.

import { runProcess } from "#checks/kit/spawn.ts";
import { discoverChecks } from "#checks/kit/run.ts";
import { alwaysChecks } from "#checks/kit/selection/always.ts";
import { buildImportGraph, selectRelatedChecks, type ImportGraph } from "#checks/kit/selection/import-graph.ts";
import { checksFromRules } from "#checks/kit/selection/rules.ts";
import { monorepoRoot } from "#framework/core/env.ts";

// --- git (read-only) ----------------------------------------------------------------------------

/** Runs one read-only git command from the repo root; throws with stderr on any failure. */
async function git(args: readonly string[]): Promise<string> {
  const result = await runProcess("git", [...args], { cwd: monorepoRoot, timeoutMs: 60_000 });
  if (result.error !== undefined || result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || "non-zero exit"}`);
  }
  return result.stdout;
}

/** One audited commit: hash, subject, parent hashes (more than one = merge), changed files. */
interface Commit {
  readonly hash: string;
  readonly subject: string;
  readonly parents: readonly string[];
  /** Repo-relative POSIX paths; empty for merges (skipped) and rootless diffs that failed. */
  readonly files: readonly string[];
  /** Set when the commit produced no diff to audit (merge, or a git failure worth naming). */
  readonly skipped?: string;
}

/** The last `count` commits of the current branch, newest first, with per-commit diffs
 *  against the first parent (root commits via diff-tree --root). */
async function recentCommits(count: number): Promise<readonly Commit[]> {
  const log = await git(["log", `-n`, String(count), `--format=%H%x00%P%x00%s`]);
  const commits: Commit[] = [];
  for (const line of log.split("\n")) {
    if (line === "") continue;
    const [hash, parentField, subject] = line.split("\x00");
    const parents = parentField.split(" ").filter((entry) => entry !== "");
    if (parents.length > 1) {
      commits.push({ hash, subject, parents, files: [], skipped: "merge commit — diffed against no single parent" });
      continue;
    }
    const diff = parents.length === 1
      ? await git(["diff", "--name-only", "-z", `${parents[0]}..${hash}`])
      : await git(["diff-tree", "--root", "-r", "--no-commit-id", "--name-only", "-z", hash]);
    const files = diff.split("\x00").filter((path) => path !== "").map((path) => path.replaceAll("\\", "/"));
    commits.push({ hash, subject, parents, files });
  }
  return commits;
}

/** The full hash of the newest commit whose subject contains `needle`, or null. */
async function findCommitBySubject(needle: string): Promise<string | null> {
  const out = await git(["log", `--grep=${needle}`, "--format=%H", "-n", "1"]);
  const hash = out.trim();
  return hash === "" ? null : hash;
}

/** Resolves a known short hash (fallback when --grep finds nothing), or null. */
async function resolveCommit(hashish: string): Promise<string | null> {
  const out = await runProcess("git", ["rev-parse", "--verify", "--quiet", `${hashish}^{commit}`], { cwd: monorepoRoot, timeoutMs: 60_000 });
  return out.error === undefined && out.code === 0 ? out.stdout.trim() : null;
}

// --- the selection, per commit -------------------------------------------------------------------

/** One selected check label plus the tier that picked it (0 graph, 1 rules, 2 always). */
interface Selected {
  readonly label: string;
  readonly tier: number;
}

/** Labels in tools/checks-relative form. */
const CHECK_PREFIX = "tools/checks/";

let cachedLabels: readonly string[] | undefined;
let cachedGraph: ImportGraph | undefined;

/** The check labels and the import graph, each computed once for the whole audit. */
async function auditContext(): Promise<{ labels: readonly string[]; graph: ImportGraph }> {
  if (cachedLabels === undefined) cachedLabels = (await discoverChecks()).map((entry) => entry.label);
  cachedGraph ??= buildImportGraph();
  return { labels: cachedLabels, graph: cachedGraph };
}

/** What today's selection logic picks for `changed`: graph tier, then rules, then always —
 *  first tier wins, exactly like the runner's relatedReasons. */
function selectionFor(changed: readonly string[], labels: readonly string[], graph: ImportGraph): readonly Selected[] {
  const picked = new Map<string, Selected>();
  const put = (label: string, tier: number): void => {
    if (!picked.has(label)) picked.set(label, { label, tier });
  };
  for (const found of selectRelatedChecks(graph, changed).checks) put(found.file.slice(CHECK_PREFIX.length), 0);
  for (const label of checksFromRules(changed, labels).labels) put(label, 1);
  for (const label of alwaysChecks(labels)) put(label, 2);
  return [...picked.values()].sort((a, b) => a.tier - b.tier || (a.label < b.label ? -1 : 1));
}

const TIER_NAMES = ["graph", "rules", "fast"] as const;

/** One compact line per commit: hash, subject, file count, tier counts, and the labels when
 *  the non-fast selection is small — empty selections beyond the fast tier are called out. */
function printCommit(commit: Commit, selected: readonly Selected[]): void {
  const byTier = [0, 1, 2].map((tier) => selected.filter((entry) => entry.tier === tier).length);
  const beyondFast = byTier[0] + byTier[1];
  const head = `${commit.hash.slice(0, 9)} ${commit.subject}`;
  if (commit.skipped !== undefined) {
    process.stdout.write(`${head}\n  skipped: ${commit.skipped}\n`);
    return;
  }
  const tierNote = `files ${commit.files.length}, selected ${selected.length} (graph ${byTier[0]}, rules ${byTier[1]}, fast ${byTier[2]})`;
  process.stdout.write(`${head}\n  ${tierNote}${beyondFast === 0 ? "  — EMPTY beyond the fast tier" : ""}\n`);
  if (beyondFast === 0 || selected.length > 14) return;
  for (const entry of selected) {
    const marker = entry.tier === 2 ? "fast" : TIER_NAMES[entry.tier];
    process.stdout.write(`    [${marker}] ${entry.label}\n`);
  }
}

// --- audit mode ----------------------------------------------------------------------------------

/** Audits the last `count` commits and prints the summary line. */
async function audit(count: number): Promise<void> {
  const { labels, graph } = await auditContext();
  const commits = await recentCommits(count);
  let merges = 0;
  let emptyBeyondFast = 0;
  let audited = 0;
  for (const commit of commits) {
    if (commit.skipped !== undefined) {
      merges += 1;
      printCommit(commit, []);
      continue;
    }
    audited += 1;
    const selected = selectionFor(commit.files, labels, graph);
    if (selected.every((entry) => entry.tier === 2)) emptyBeyondFast += 1;
    printCommit(commit, selected);
  }
  process.stdout.write(`\n--- summary: ${audited} commits audited, ${merges} merges skipped, ` +
    `${emptyBeyondFast}/${audited} commits selected nothing beyond the fast tier\n`);
}

// --- retrospective acceptance --------------------------------------------------------------------

/** One acceptance expectation: how to find the commit, and the check labels (or label
 *  prefixes, for the architecture family) it must select. */
interface Expectation {
  readonly name: string;
  /** Subject substrings tried in order via `git log --grep`, then hardcoded fallback hashes. */
  readonly needles: readonly string[];
  readonly fallbackHash: string;
  /** Labels that must appear in the FULL selection (what the runner would run). */
  readonly requiresLabels: readonly string[];
}

const EXPECTATIONS: readonly Expectation[] = [
  {
    name: "recipe check commit selects the needs and write-isolation checks",
    needles: ["add `recipe check` to run a recipe's own checks"],
    fallbackHash: "ceebea2",
    requiresLabels: [
      "foundation/core/command/needs.check.ts",
      "foundation/hygiene/static/write-isolation.check.ts",
    ],
  },
  {
    name: "mcp tools/list wording commit selects the spec view and cli host checks",
    needles: ["shorten tools/list wording, keep the facts"],
    fallbackHash: "ce3be78",
    requiresLabels: [
      "foundation/core/command/spec/view.check.ts",
      "foundation/cli/host.check.ts",
    ],
  },
  {
    name: "build-input lint commit selects at least one architecture check",
    needles: ["lint build inputs for unpinned remote artifacts"],
    fallbackHash: "3e3e772",
    requiresLabels: [],
  },
];

/** Runs every expectation; returns the number of failures, writing a FAIL line per miss. */
async function accept(): Promise<number> {
  const { labels, graph } = await auditContext();
  let failures = 0;
  const fail = (message: string): void => {
    failures += 1;
    process.stdout.write(`FAIL ${message}\n`);
  };
  for (const expectation of EXPECTATIONS) {
    let hash: string | null = null;
    for (const needle of expectation.needles) hash = await findCommitBySubject(needle);
    if (hash === null) hash = await resolveCommit(expectation.fallbackHash);
    if (hash === null) {
      fail(`${expectation.name}: commit not found (needles: ${expectation.needles.join("; ")})`);
      continue;
    }
    const diff = await git(["diff", "--name-only", "-z", `${hash}~..${hash}`]);
    const changed = diff.split("\x00").filter((path) => path !== "");
    const selected = selectionFor(changed, labels, graph);
    const selectedLabels = new Set(selected.map((entry) => entry.label));
    const archSelected = selected.filter((entry) => entry.label.startsWith("architecture/"));
    const tierName = (tier: number): string => TIER_NAMES[tier] ?? "?";
    process.stdout.write(`expect ${hash.slice(0, 9)} — ${expectation.name}\n`);
    for (const required of expectation.requiresLabels) {
      const hit = selected.find((entry) => entry.label === required);
      if (hit === undefined) fail(`  missing ${required}`);
      else process.stdout.write(`  ok: ${required} [${tierName(hit.tier)}]\n`);
    }
    if (expectation.requiresLabels.some((label) => !selectedLabels.has(label))) continue;
    if (archSelected.length > 0) {
      const tiers = [...new Set(archSelected.map((entry) => tierName(entry.tier)))].join(", ");
      process.stdout.write(`  ok: ${archSelected.length} architecture check(s) [${tiers}]\n`);
    } else if (expectation.name.startsWith("build-input")) {
      fail("  no tools/checks/architecture/** check selected");
    }
  }
  if (failures === 0) process.stdout.write("ACCEPT: all retrospective assertions passed\n");
  else process.stdout.write(`ACCEPT: ${failures} failure(s)\n`);
  return failures;
}

// --- entry ----------------------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes("--accept")) {
  process.exitCode = (await accept()) === 0 ? 0 : 1;
} else {
  const countArg = args.find((arg) => /^\d+$/.test(arg));
  const count = countArg === undefined ? 25 : Number(countArg);
  if (!Number.isInteger(count) || count < 1) {
    process.stderr.write("usage: node --experimental-strip-types tools/dev/maintenance/related-audit.ts [N | --accept]\n");
    process.exitCode = 1;
  } else {
    await audit(count);
  }
}
