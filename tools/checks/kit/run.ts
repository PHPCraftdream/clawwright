// Runs every *.check.ts under tools/checks, or a filtered subset of it — each as its own
// child process (kit/spawn.ts), with bounded parallelism. These need no instance, no target
// and no network: they cover the parts of the framework where a mistake is silent — path
// translation, archive safety, the argument contract, the composition of a deployment.
// `./clawwright smoke` covers a live instance instead.

import { availableParallelism } from "node:os";
import { createHash } from "node:crypto";
import { open, readdir, readlink, lstat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { monorepoRoot } from "#framework/core/env.ts";
import { reportError } from "#framework/core/io/log.ts";
import { emit } from "#framework/core/io/output.ts";
import { printStoredTimings, recordRunTimings, renderRunBlock, runCheckFile, runProcess, type CheckResult, type RecordedSample } from "./spawn.ts";
import { CAPABILITIES, CapabilityProbe, isCapability, type Capability } from "./capabilities/capabilities.ts";
import { gateFor, parseCaseSkips, parseRequireList, skipLine, summaryLine } from "./capabilities/gate.ts";
import { alwaysChecks } from "./selection/always.ts";
import { buildImportGraph, selectRelatedChecks } from "./selection/import-graph.ts";
import { checksFromRules } from "./selection/rules.ts";

export interface RunChecksOptions {
  /** Substrings a check's relative path must contain at least one of. Every check when empty. */
  readonly filters?: readonly string[];
  /** Print the matching paths instead of running them. */
  readonly list?: boolean;
  /** Concurrent check-file processes. Defaults to OC_CHECK_JOBS, else min(4, cores/2), at least 1. */
  readonly jobs?: number;
  /** Capabilities (docker, wsl, posix-sh, rsync, linux-host, windows-host, ssh-loopback, gnu-userland, bash, pwsh) whose
   *  absence must fail a file that requires them, instead of skipping it — merged with
   *  OC_CHECK_REQUIRE. */
  readonly require?: readonly string[];
  /** Select the checks the changes between --base and the working tree touch, plus the fast tier. */
  readonly related?: boolean;
  /** The revision --related diffs against; default is the merge-base with the upstream branch, else HEAD~1. */
  readonly base?: string;
  readonly checkoutRoot?: string;
  readonly entries?: readonly LabeledCheck[];
  readonly probe?: Pick<CapabilityProbe, "missing">;
  readonly runFile?: typeof runCheckFile;
  /** With a number: print the stored check-timing ranking (top n by median) and run nothing. */
  readonly timingsOnly?: number;
  /** Directory holding .check-timings.json. Defaults to the monorepo root; tests point this at a temp dir. */
  readonly timingsDir?: string;
  /** Injectable clock for a run's wall time. */
  readonly now?: () => number;
}

function defaultJobs(): number {
  const fromEnv = Number(process.env.OC_CHECK_JOBS ?? "");
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
}

// --- discovering the check files (merged from kit/discover.ts) ---------------------------------

/** tools/checks — one level up from this file, so moving kit/ does not move the root. */
export const checksRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface LabeledCheck {
  readonly file: string;
  readonly label: string;
  /** Mutates state other checks read (e.g. rebuilds dist/): runs alone, after the parallel pool. */
  readonly exclusive: boolean;
  /** Host capabilities (capabilities.ts) this file cannot run at all without — run.ts skips
   *  (or, under --require/OC_CHECK_REQUIRE, fails) the file rather than starting it. */
  readonly requires: readonly Capability[];
}

/** A file opts out of parallel runs with a `// check:exclusive — <reason>` line in its header. */
const EXCLUSIVE_MARKER = /^\/\/ check:exclusive(?![A-Za-z-])/m;

/** A file that cannot run at all without one or more host capabilities names them with a
 *  `// check:requires <cap>[, <cap>...]` line in its header — same 2KB budget as the
 *  exclusive marker, since both describe the file rather than its content. */
const REQUIRES_MARKER = /^\/\/ check:requires\s+(.+)$/m;

/** Exported for discover.check.ts: pure header-text parsing, no filesystem needed to test it. */
export function parseRequires(header: string, file: string): Capability[] {
  const match = REQUIRES_MARKER.exec(header);
  if (match === null) return [];
  return match[1].split(",").map((entry) => {
    const capability = entry.trim();
    if (!isCapability(capability)) {
      throw new Error(`${file}: unknown capability "${capability}" in a check:requires header (known: ${CAPABILITIES.join(", ")})`);
    }
    return capability;
  });
}

interface Header {
  readonly exclusive: boolean;
  readonly requires: readonly Capability[];
}

async function readHeader(file: string): Promise<Header> {
  const handle = await open(file, "r");
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(2048), 0, 2048, 0);
    const text = buffer.toString("utf8", 0, bytesRead);
    return { exclusive: EXCLUSIVE_MARKER.test(text), requires: parseRequires(text, file) };
  } finally {
    await handle.close();
  }
}

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else if (entry.name.endsWith(".check.ts")) found.push(full);
  }
  return found.sort();
}

/** Every check file under tools/checks, labeled by its path relative to it (POSIX form). */
export async function discoverChecks(): Promise<LabeledCheck[]> {
  const files = await walk(checksRoot);
  return Promise.all(files.map(async (file) => {
    const header = await readHeader(file);
    return { file, label: relative(checksRoot, file).replaceAll("\\", "/"), ...header };
  }));
}

/** The parallel pool and the files that must run alone after it, each in the given order. */
export function splitExclusive(entries: readonly LabeledCheck[]): { pooled: LabeledCheck[]; alone: LabeledCheck[] } {
  return { pooled: entries.filter((entry) => !entry.exclusive), alone: entries.filter((entry) => entry.exclusive) };
}

/** The labels containing at least one filter substring; all of them when there are none. */
export function selectChecks(labels: readonly string[], filters: readonly string[]): string[] {
  if (filters.length === 0) return [...labels];
  return labels.filter((label) => filters.some((filter) => label.includes(filter)));
}

// --- the checkout is left as the run found it (R33-02) ----------------------------------------

/** One path below apps/: a fully hashed file, link target, or directory marker. */
export interface AppsEntry {
  /** Path relative to apps/, forward slashes, "" for the root itself (never recorded). */
  readonly path: string;
  readonly directory?: true;
  readonly size?: number;
  /** SHA256 of the entire file, streamed with bounded memory. */
  readonly hash?: string;
  /** Target string of a symlink or Windows junction entry, read without following the link. */
  readonly link?: string;
  readonly mode?: number;
  readonly unreadable?: string;
}

function kindOf(entry: AppsEntry): string {
  if (entry.link !== undefined) return `link ${entry.link}`;
  return entry.directory === true ? "dir" : `${entry.size}B${entry.hash === undefined ? "" : ` ${entry.hash.slice(0, 8)}`}`;
}

export interface CheckoutSnapshot {
  readonly apps: readonly AppsEntry[];
  /** `git status --porcelain`, empty when git is unavailable (then it is not compared). */
  readonly gitStatus: string | undefined;
  /** The ignored (`!!`) entries of `git status --porcelain --ignored=matching`, generated
   *  roots pruned; undefined when git is unavailable (not compared either). --porcelain
   *  cannot see ignored space — .claude/, secrets/, data/, *.token — exactly where a check
   *  that dies mid-write would leave its fixture behind, unnoticed. */
  readonly ignoredStatus: string | undefined;
  /** Content and link targets in existing ignored space; same exclusions as ignoredStatus. */
  readonly ignored?: readonly AppsEntry[];
  readonly tree?: readonly AppsEntry[];
}

// Ignored space the guard does not chase: node_modules is installed dependency space, apps/ is
// the deployment tree the walk above already covers, worktrees/ holds whole sibling checkouts on
// hosts that have one, and .rush/ is the orchestration harness state (locks, sessions) that
// concurrent rush runs rewrite. packages/clawwright/dist is observed like any other ignored space: no
// check writes it (build-output and the release pack checks build into OS temp). The excludes
// prune before git walks — the .check-timings.json entry keeps the git-status excludes consistent —
// so the ignored pass stays as cheap as the tracked one. .check-timings.json is the runner's own
// telemetry file, written by nested `clawwright check` children during a run, so it must not read as
// a checkout change.
const IGNORED_STATUS_EXCLUDES = ["node_modules", "apps", "worktrees", ".rush", ".check-timings.json"];

function diffStatusLines(before: string, after: string, prefix: string): readonly string[] {
  const beforeLines = new Set(before.split("\n"));
  const afterLines = new Set(after.split("\n"));
  const gained = [...afterLines].filter((line) => line !== "" && !beforeLines.has(line)).sort();
  const lost = [...beforeLines].filter((line) => line !== "" && !afterLines.has(line)).sort();
  return [...gained.map((line) => `${prefix}gained: ${line}`), ...lost.map((line) => `${prefix}lost: ${line}`)];
}

function diffEntries(before: readonly AppsEntry[], after: readonly AppsEntry[], prefix = "apps/"): readonly string[] {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry]));
  const gained: string[] = [];
  const lost: string[] = [];
  const changed: string[] = [];
  for (const [path, entry] of afterByPath) {
    const was = beforeByPath.get(path);
    if (was === undefined) {
      gained.push(path);
      continue;
    }
    const beforeKind = kindOf(was);
    const afterKind = kindOf(entry);
    if (was.directory !== entry.directory || was.size !== entry.size || was.hash !== entry.hash || was.link !== entry.link || was.mode !== entry.mode || was.unreadable !== entry.unreadable) {
      const detail = was.mode !== entry.mode ? ` mode ${was.mode?.toString(8)} → ${entry.mode?.toString(8)}` : "";
      changed.push(`${path} (${beforeKind} → ${afterKind}${detail}${was.unreadable !== entry.unreadable ? ` readability ${was.unreadable ?? "readable"} → ${entry.unreadable ?? "readable"}` : ""})`);
    }
  }
  for (const path of beforeByPath.keys()) if (!afterByPath.has(path)) lost.push(path);
  const changes: string[] = [];
  if (gained.length > 0) changes.push(`${prefix} gained: ${gained.sort().join(", ")}`);
  if (lost.length > 0) changes.push(`${prefix} lost: ${lost.sort().join(", ")}`);
  if (changed.length > 0) changes.push(`${prefix} changed: ${changed.sort().join(", ")}`);
  return changes;
}

export function diffSnapshots(before: CheckoutSnapshot, after: CheckoutSnapshot): readonly string[] {
  const changes = [...diffEntries(before.apps, after.apps)];
  if (before.tree !== undefined && after.tree !== undefined) changes.push(...diffEntries(before.tree, after.tree, "checkout content"));
  if (before.ignored !== undefined && after.ignored !== undefined) {
    changes.push(...diffEntries(before.ignored, after.ignored, "git ignored content"));
  }
  if (before.gitStatus !== undefined && after.gitStatus !== undefined && before.gitStatus !== after.gitStatus) {
    changes.push(...diffStatusLines(before.gitStatus, after.gitStatus, "git status "));
  }
  if (before.ignoredStatus !== undefined && after.ignoredStatus !== undefined && before.ignoredStatus !== after.ignoredStatus) {
    changes.push(...diffStatusLines(before.ignoredStatus, after.ignoredStatus, "git ignored "));
  }
  return changes;
}

/** Hash every byte using a fixed-size buffer, independent of file size. */
async function hashFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

/** lstat before recursion: symlinks (including directory links) record targets only. */
export interface SnapshotOptions {
  readonly beforeRead?: (path: string) => void;
}

interface WalkOptions extends SnapshotOptions {
  readonly prune?: boolean;
  readonly ignoredRoots?: readonly string[];
}

async function snapshotPath(absolute: string, display: string, entries: AppsEntry[], options: WalkOptions = {}): Promise<void> {
  let mode: number | undefined;
  try {
    const info = await lstat(absolute);
    mode = info.mode;
    if (info.isSymbolicLink()) entries.push({ path: display, mode, link: await readlink(absolute) });
    else if (info.isDirectory()) {
      entries.push({ path: display, mode, directory: true });
      for (const name of (await readdir(absolute)).sort()) {
        const path = display === "" ? name : display + "/" + name;
        if (options.prune && (path === ".git" || [...IGNORED_STATUS_EXCLUDES, ...(options.ignoredRoots ?? [])].some((root) => path === root || path.startsWith(root + "/")))) continue;
        await snapshotPath(join(absolute, name), path, entries, options);
      }
    } else if (info.isFile()) {
      options.beforeRead?.(absolute);
      entries.push({ path: display, mode, size: info.size, hash: await hashFile(absolute) });
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
      entries.push({ path: display, mode, unreadable: code });
      return;
    }
    throw error;
  }
}

export function porcelainRecords(text: string): { status: string; path: string; source?: string }[] {
  const fields = text.split("\0");
  const records: { status: string; path: string; source?: string }[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    const source = /[RC]/.test(status) ? fields[++i] : undefined;
    records.push({ status, path, ...(source === undefined ? {} : { source }) });
  }
  return records;
}

export async function snapshotCheckout(checkoutRoot: string = monorepoRoot, options: SnapshotOptions = {}): Promise<CheckoutSnapshot> {
  const apps: AppsEntry[] = [];
  await snapshotPath(resolve(checkoutRoot, "apps"), "", apps, options);
  const excludes = ["--", ...IGNORED_STATUS_EXCLUDES.map((entry) => ":(exclude)" + entry), ":(exclude).git"];
  const git = await runProcess("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...excludes], { cwd: checkoutRoot, timeoutMs: 60_000 });
  const ignored = await runProcess("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", ...excludes], { cwd: checkoutRoot, timeoutMs: 60_000 });
  const available = git.error === undefined && git.code === 0 && !git.timedOut;
  const records = porcelainRecords(git.stdout);
  const ignoredEntries: AppsEntry[] = [];
  const ignoredAvailable = ignored.error === undefined && ignored.code === 0 && !ignored.timedOut;
  const ignoredRoots = porcelainRecords(ignored.stdout).filter((entry) => entry.status === "!!").map((entry) => entry.path.replace(/\/$/, ""));
  if (ignoredAvailable) {
    for (const path of ignoredRoots) {
      if (IGNORED_STATUS_EXCLUDES.some((root) => path === root || path.startsWith(root + "/"))) continue;
      await snapshotPath(resolve(checkoutRoot, path), path, ignoredEntries, options);
    }
  }
  const tree: AppsEntry[] = [];
  await snapshotPath(checkoutRoot, "", tree, { ...options, prune: true, ignoredRoots: ignoredAvailable ? ignoredRoots : [] });
  const ignoredFiles = ignoredEntries.filter((entry) => entry.directory !== true);
  return {
    apps: apps.filter((entry) => entry.path !== ""),
    gitStatus: available ? records.map((entry) => JSON.stringify(entry)).sort().join("\n") : undefined,
    ignoredStatus: ignoredAvailable ? ignoredFiles.map((entry) => "!! " + entry.path).sort().join("\n") : undefined,
    ignored: ignoredAvailable ? ignoredEntries : undefined,
    tree: tree.filter((entry) => entry.path !== ""),
  };
}

/** The outcome of deciding + (maybe) running one entry: `skipped` names why when the file was
 *  never started; its absence means the file ran (or was failed outright by --require). */
type Outcome = CheckResult & { readonly skipped?: readonly Capability[] };

/** Probes `entry.requires` once, then runs, skips or fails it — a file whose requirement is
 *  unmet is never spawned at all. */
async function runEntry(entry: LabeledCheck, probe: Pick<CapabilityProbe, "missing">, forced: ReadonlySet<Capability>, runFile: typeof runCheckFile): Promise<Outcome> {
  const missing = await probe.missing(entry.requires);
  const gate = gateFor(missing, forced);
  if (gate.kind === "run") return runFile(entry.file, entry.label);
  if (gate.kind === "skip") return { label: entry.label, ok: true, output: "", durationMs: 0, skipped: gate.missing };
  return { label: entry.label, ok: false, output: "", durationMs: 0, reason: `unmet requirement: ${gate.missing.join(", ")}` };
}

/** Runs `entries` with `jobs` concurrent workers. Results settle out of order but `onReady`
 *  fires in `entries` order — as soon as an entry's predecessors have all fired — so output
 *  stays deterministic across runs while work still overlaps. */
async function runPooled(
  entries: readonly LabeledCheck[],
  jobs: number,
  run: (entry: LabeledCheck) => Promise<Outcome>,
  onReady: (result: Outcome) => void,
): Promise<void> {
  const results: Outcome[] = Array.from({ length: entries.length });
  const done: boolean[] = Array.from({ length: entries.length }, () => false);
  let printCursor = 0;

  function drain(): void {
    while (printCursor < entries.length && done[printCursor]) {
      onReady(results[printCursor]);
      printCursor += 1;
    }
  }

  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= entries.length) return;
      results[index] = await run(entries[index]);
      done[index] = true;
      drain();
    }
  }

  const workerCount = Math.max(1, Math.min(jobs, entries.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

// --- --related: the checks the current changes touch -------------------------------------------

/** Paths (repo-relative POSIX) changed between `base` and the working tree — committed diff plus
 *  everything `git status` sees (staged, unstaged, untracked, rename sources). Read-only through
 *  git; returns null (with a stderr note already written) when git is unusable or the base is bogus. */
async function relatedChangedFiles(base: string | undefined, cwd: string): Promise<readonly string[] | null> {
  const plain = await runProcess("git", ["rev-parse", "--git-dir"], { cwd, timeoutMs: 60_000 });
  if (plain.error !== undefined || plain.code !== 0) {
    process.stderr.write("check --related: git is not available here — cannot compute the changed set\n");
    return null;
  }
  let baseRef: string;
  if (base !== undefined) {
    const verify = await runProcess("git", ["rev-parse", "--verify", "--quiet", base], { cwd, timeoutMs: 60_000 });
    if (verify.error !== undefined || verify.code !== 0) {
      process.stderr.write(`check --related: --base "${base}" is not a resolvable revision\n`);
      return null;
    }
    baseRef = base;
  } else {
    const mergeBase = await runProcess("git", ["merge-base", "HEAD", "@{u}"], { cwd, timeoutMs: 60_000 });
    if (mergeBase.error === undefined && mergeBase.code === 0 && mergeBase.stdout.trim() !== "") {
      baseRef = mergeBase.stdout.trim();
    } else {
      const fallback = await runProcess("git", ["rev-parse", "--verify", "--quiet", "HEAD~1"], { cwd, timeoutMs: 60_000 });
      if (fallback.error !== undefined || fallback.code !== 0) {
        process.stderr.write("check --related: no upstream and no HEAD~1 to diff against — pass --base <rev>\n");
        return null;
      }
      baseRef = "HEAD~1";
    }
  }
  const committed = await runProcess("git", ["diff", "--name-only", "-z", baseRef], { cwd, timeoutMs: 60_000 });
  if (committed.error !== undefined || committed.code !== 0) {
    process.stderr.write(`check --related: git diff against "${baseRef}" failed\n`);
    return null;
  }
  const status = await runProcess("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd, timeoutMs: 60_000 });
  if (status.error !== undefined || status.code !== 0) {
    process.stderr.write("check --related: git status failed\n");
    return null;
  }
  const changed = new Set(committed.stdout.split("\0").filter((path) => path !== ""));
  for (const record of porcelainRecords(status.stdout)) {
    changed.add(record.path);
    if (record.source !== undefined) changed.add(record.source);
  }
  return [...changed].map((path) => path.replaceAll("\\", "/")).sort();
}

/** The related selection over the discovered checks: reasons per label (first tier wins:
 *  graph, then rule, then always) and the tier each label was picked by, for stable grouping. */
function relatedReasons(
  labeled: readonly LabeledCheck[],
  changed: readonly string[],
): { readonly reasons: ReadonlyMap<string, string>; readonly tiers: ReadonlyMap<string, number>; readonly relatedAndRules: ReadonlySet<string> } {
  const prefix = "tools/checks/";
  const labels = labeled.map((entry) => entry.label);
  const reasons = new Map<string, string>();
  const tiers = new Map<string, number>();
  const put = (label: string, reason: string, tier: number): void => {
    if (!reasons.has(label)) {
      reasons.set(label, reason);
      tiers.set(label, tier);
    }
  };
  for (const found of selectRelatedChecks(buildImportGraph(), changed).checks) {
    put(found.file.slice(prefix.length), `changed via ${found.via} (depth ${found.depth})`, 0);
  }
  for (const [label, reason] of checksFromRules(changed, labels).reasons) put(label, reason, 1);
  const relatedAndRules = new Set(reasons.keys());
  for (const label of alwaysChecks(labels)) put(label, "fast tier", 2);
  return { reasons, tiers, relatedAndRules };
}

export async function runChecks(options: RunChecksOptions = {}): Promise<number> {
  const filters = options.filters ?? [];
  const list = options.list ?? false;
  const jobs = options.jobs ?? defaultJobs();

  let forced: Set<Capability>;
  try {
    forced = new Set([
      ...parseRequireList(options.require?.join(","), isCapability),
      ...parseRequireList(process.env.OC_CHECK_REQUIRE, isCapability),
    ]);
  } catch (error) {
    reportError((error as Error).message);
    return 1;
  }

  const labeled = options.entries ?? await discoverChecks();
  const matching = new Set(selectChecks(labeled.map((entry) => entry.label), filters));
  let selected = labeled.filter((entry) => matching.has(entry.label));

  if (options.related === true) {
    // The related set (graph + rules), then the always tier, then filters narrow it down.
    const changed = await relatedChangedFiles(options.base, monorepoRoot);
    if (changed === null) return 1;
    const { reasons, tiers, relatedAndRules } = relatedReasons(labeled, changed);
    if (relatedAndRules.size === 0) process.stderr.write("no related checks — running the fast tier only\n");
    selected = labeled.filter((entry) => reasons.has(entry.label));
    if (filters.length > 0) selected = selected.filter((entry) => filters.some((filter) => entry.label.includes(filter)));
    if (selected.length === 0) {
      reportError(`no check matches: ${filters.join(", ")}`);
      return 1;
    }
    if (!list) {
      // One line per selected check, grouped by tier (graph, rules, always), label order within.
      for (const entry of [...selected].sort((a, b) => (tiers.get(a.label) ?? 9) - (tiers.get(b.label) ?? 9) || (a.label < b.label ? -1 : 1))) {
        process.stderr.write(`  ${entry.label} — ${reasons.get(entry.label)}\n`);
      }
    }
  }

  if (selected.length === 0 && filters.length > 0) {
    reportError(`no check matches: ${filters.join(", ")}`);
    return 1;
  }

  if (options.timingsOnly !== undefined) {
    await printStoredTimings({ dir: options.timingsDir ?? monorepoRoot, top: options.timingsOnly, current: labeled.map((entry) => entry.label) });
    return 0;
  }

  if (list) {
    for (const entry of selected) {
      emit(entry.requires.length === 0 ? `${entry.label}\n` : `${entry.label} (requires: ${entry.requires.join(", ")})\n`);
    }
    return 0;
  }

  const now = options.now ?? Date.now;
  const startedAt = now();
  const samples: RecordedSample[] = [];
  let failed = 0;
  let skippedFiles = 0;
  const skippedByCapability = new Map<Capability, number>();
  const report = (result: Outcome): void => {
    samples.push({ label: result.label, ms: result.durationMs });
    if (result.skipped !== undefined) {
      skippedFiles += 1;
      for (const capability of result.skipped) skippedByCapability.set(capability, (skippedByCapability.get(capability) ?? 0) + 1);
      process.stderr.write(skipLine(result.label, result.skipped));
      return;
    }
    process.stderr.write(`\n${result.label}\n`);
    process.stderr.write(result.output);
    // A ran file's own case-level skips count toward the same breakdown as file-level ones.
    for (const skip of parseCaseSkips(result.output)) {
      for (const capability of skip.capabilities) skippedByCapability.set(capability, (skippedByCapability.get(capability) ?? 0) + 1);
    }
    if (!result.ok) {
      failed += 1;
      process.stderr.write(`  FAIL ${result.label}${result.reason === undefined ? "" : ` — ${result.reason}`}\n`);
    }
  };
  // Exclusive files (see the discover half above) run alone once the parallel pool has drained. A file
  // whose requirement is unmet is never started, in either group.
  const probe = options.probe ?? new CapabilityProbe();
  const run = (entry: LabeledCheck): Promise<Outcome> => runEntry(entry, probe, forced, options.runFile ?? runCheckFile);
  const before = await snapshotCheckout(options.checkoutRoot);
  const { pooled, alone } = splitExclusive(selected);
  await runPooled(pooled, jobs, run, report);
  await runPooled(alone, 1, run, report);
  const after = await snapshotCheckout(options.checkoutRoot);
  const changed = diffSnapshots(before, after);
  if (before.gitStatus === undefined || after.gitStatus === undefined) {
    process.stderr.write("  note: git unavailable — the checkout was not compared against the pre-run snapshot\n");
  }
  if (changed.length > 0) {
    failed += 1;
    process.stderr.write(`  FAIL the run changed the checkout\n    ${changed.join("\n    ")}\n`);
  }

  const summary = summaryLine(selected.length - skippedFiles, failed, skippedByCapability);
  process.stderr.write(
    options.related === true ? summary.replace(/\n$/, ` — selected ${selected.length} of ${labeled.length} checks\n`) : summary,
  );
  process.stderr.write(renderRunBlock(now() - startedAt, jobs, samples));
  await recordRunTimings({ dir: options.timingsDir ?? monorepoRoot, samples, off: process.env.OC_CHECK_TIMINGS === "off" });
  return failed === 0 ? 0 : 1;
}
