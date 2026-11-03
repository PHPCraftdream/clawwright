#!/usr/bin/env node
// Runs the negative controls (stage 7, S0.3): copies the repository ONCE into the OS temp
// dir (tracked + untracked-not-ignored files, NUL-delimited git output, modes preserved;
// node_modules linked, never copied), then for each control applies its edit to the copy,
// runs the declared check, and demands that the UNEDITED copy passes while the EDITED copy
// fails ON A FAILING ASSERTION whose name carries the declared fragment — the harness prints
// assertion names on success lines too, so only "  FAIL <name>" lines count. A timeout, a
// signal or a spawn error is never a held control. Edits are reverted byte-exactly (SHA-256
// of the original Buffer, mode re-applied) and the first restore drift aborts the run —
// later controls must not run on a possibly corrupted copy.
//
// A control whose edit no longer matches the product (it was refactored) is a FAILURE of
// check:controls — a stale control, never a skip. Every declared path must resolve inside
// the temp copy itself, never through the node_modules junction or any symlink.
//
// A control whose target check declares `check:requires` (or whose own `requires` list names)
// a capability this host lacks is reported as `skipped (needs <cap>)` — counted separately,
// never held, never failing.

import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runProcess } from "#checks/kit/spawn.ts";
import { CAPABILITIES, CapabilityProbe, isCapability, type Capability } from "../kit/capabilities/capabilities.ts";
import { parseRequires } from "../kit/run.ts";
import { CONTROLS, type ControlDecl } from "./controls.ts";

export const FAIL_MARKER = "  FAIL ";

export type ControlKind =
  | "held"
  | "stale"
  | "invalid-baseline"
  | "not-failing"
  | "fragment-missing"
  | "check-crashed"
  | "restore-failed"
  | "escaped-path"
  | "skipped";

export interface ControlResult {
  readonly id: string;
  readonly kind: ControlKind;
  readonly ok: boolean;
  /** Human-readable why, beyond kind. */
  readonly reason?: string;
  /** The failing assertion line that carried the fragment, when held. */
  readonly matchedFailLine?: string;
  /** The edited run's FAIL lines (capped) — the evidence a fragment verdict is judged on. */
  readonly failLines?: readonly string[];
  /** Diagnostics captured from an invalid baseline, separate from assertion evidence. */
  readonly diagnostics?: readonly string[];
  /** SHA-256 of the product file inside the copy, before the edit and after the restore. */
  readonly productHashBefore?: string;
  readonly productHashAfter?: string;
  /** Nonzero exit of the edited assertion run, recorded only for held controls. */
  readonly editedExit?: number;
  /** Capabilities the host lacks, when kind is "skipped". */
  readonly missing?: readonly Capability[];
  readonly durationMs: number;
}

export interface ControlsRun {
  readonly results: readonly ControlResult[];
  /** Set when the run stopped early (restore drift): remaining controls did not run. */
  readonly aborted?: string;
  readonly copyMs: number;
  readonly baselineMs: number;
  readonly totalMs: number;
}

/** Roots of the checkout that are never copied, and never valid control paths. */
const COPY_EXCLUDES = [".git", "apps", "worktrees", ".rush", "node_modules"];

function excluded(path: string): boolean {
  return COPY_EXCLUDES.some((root) => path === root || path.startsWith(`${root}/`));
}

/** Tracked files plus untracked-but-not-ignored ones — the repository as git would ship it
 *  (a tracked path deleted from the working tree is not part of it and is skipped).
 *  NUL-delimited output, so names git would quote survive verbatim. */
async function repoFiles(repoRoot: string): Promise<string[]> {
  const files = new Set<string>();
  for (const args of [["ls-files", "-z"], ["ls-files", "-o", "--exclude-standard", "-z"]]) {
    const git = await runProcess("git", args, { cwd: repoRoot, timeoutMs: 60_000 });
    if (git.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${git.output}`);
    for (const path of git.stdout.split("\0")) {
      if (path !== "" && !excluded(path)) files.add(path);
    }
  }
  return [...files];
}

export async function copyRepo(repoRoot: string, tempRoot: string): Promise<void> {
  for (const path of await repoFiles(repoRoot)) {
    const source = join(repoRoot, path);
    // A tracked-but-deleted path is listed by git ls-files yet absent from the working tree.
    const stats = await lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stats === undefined) continue;
    const destination = join(tempRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(source));
    await chmod(destination, stats.mode);
  }
  const nodeModules = join(repoRoot, "node_modules");
  try {
    if (!(await stat(nodeModules)).isDirectory()) throw new Error(`${nodeModules} is not a directory`);
    await symlink(nodeModules, join(tempRoot, "node_modules"), "junction"); // type is used on Windows only, ignored elsewhere
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOENT") throw error; // no node_modules here is fine
  }
}

/** Git metadata for the temp copy, when a control's check vets against tracked files.
 *  `git ls-files` needs only the index, but the sensitive-name vetting also hashes committed
 *  blobs (`git ls-tree -r HEAD`) and treats staged paths as dirty — so one throwaway commit. */
async function initGitIndex(tempRoot: string): Promise<void> {
  const steps: readonly (readonly string[])[] = [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.email=check@invalid", "-c", "user.name=check", "commit", "-qm", "init"],
  ];
  for (const args of steps) {
    const git = await runProcess("git", [...args], { cwd: tempRoot, timeoutMs: 60_000 });
    if (git.code !== 0) throw new Error(`git ${args.join(" ")} failed in the temp copy: ${git.output}`);
  }
}

/** A declared path is only usable when it names a real file inside the copy, reached through
 *  real directories: not absolute, not outside, not an excluded root, never across the
 *  node_modules junction or any other symlink. */
async function escapeProblem(tempRoot: string, rel: string): Promise<string | undefined> {
  if (rel === "" || rel.includes("\0")) return "empty or NUL-carrying path";
  rel = rel.replaceAll("\\", "/"); // Windows separators must not hide a junction segment
  const full = resolve(tempRoot, rel);
  if (full !== tempRoot && !full.startsWith(tempRoot + sep)) return `resolves outside the copy: ${rel}`;
  const parts = rel.split("/");
  if (parts.some((part) => part === "..")) return `climbs out of the copy: ${rel}`;
  if (excluded(rel)) return `names an excluded root: ${rel}`;
  let current = tempRoot;
  for (const part of parts) {
    current = join(current, part);
    const entry = await lstat(current).catch(() => undefined);
    if (entry === undefined) return `does not exist in the copy: ${rel}`;
    if (entry.isSymbolicLink()) return `reached through a symlink or junction: ${rel}`;
  }
  return undefined;
}

/** The control's own capability demands, validated against the known set. */
function declaredRequires(control: ControlDecl): readonly Capability[] {
  return (control.requires ?? []).map((capability) => {
    if (!isCapability(capability)) {
      throw new Error(`${control.id}: unknown capability "${capability}" in a control's requires list (known: ${CAPABILITIES.join(", ")})`);
    }
    return capability;
  });
}

/** The target check file's own `check:requires` demands, read the way run.ts reads headers. */
async function checkRequires(repoRoot: string, check: string): Promise<readonly Capability[]> {
  const handle = await open(join(repoRoot, check), "r");
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(2048), 0, 2048, 0);
    return parseRequires(buffer.toString("utf8", 0, bytesRead), check);
  } finally {
    await handle.close();
  }
}

interface CheckRun {
  readonly code: number | null;
  readonly output: string;
  readonly timedOut: boolean;
  readonly spawnError?: string;
}

function runCheckFile(tempRoot: string, check: string, timeoutMs: number): Promise<CheckRun> {
  return runProcess(process.execPath, ["--experimental-strip-types", join(tempRoot, check)], { cwd: tempRoot, timeoutMs })
    .then((run) => ({ code: run.code, output: run.output, timedOut: run.timedOut, ...(run.error === undefined ? {} : { spawnError: run.error.message }) }));
}

/** The harness prints assertion names on success lines too — only failing ones count. */
function failLines(output: string): readonly string[] {
  return output.split("\n").filter((line) => line.startsWith(FAIL_MARKER));
}

/** Non-verdict diagnostics emitted by the write-isolation baseline ratchet. */
function baselineDiagnostics(output: string): readonly string[] {
  const prefix = "write-isolation: ";
  return output.split("\n").filter((line) => line.startsWith(prefix) && line.includes("unresolved approximation targets:"));
}

/** Applies, tests and reverts one control against the shared copy. The check file's
 *  repo-relative path selects the baseline outcome recorded by the caller. */
async function runOne(
  tempRoot: string,
  control: ControlDecl,
  baseline: CheckRun | undefined,
  options: { readonly timeoutMs: number; readonly breakRestore?: boolean },
): Promise<ControlResult> {
  const started = Date.now();
  const done = (kind: ControlKind, ok: boolean, extra: Partial<ControlResult> = {}): ControlResult => ({
    id: control.id,
    kind,
    ok,
    durationMs: Date.now() - started,
    ...extra,
  });
  for (const declared of [control.product, control.check]) {
    const problem = await escapeProblem(tempRoot, declared);
    if (problem !== undefined) return done("escaped-path", false, { reason: problem });
  }
  const productPath = join(tempRoot, control.product);
  const original = await readFile(productPath);
  const mode = (await stat(productPath)).mode;
  const beforeHash = createHash("sha256").update(original).digest("hex");
  const text = original.toString("utf8");
  const matches = text.split(control.search).length - 1;
  if (matches !== 1) return done("stale", false, { reason: `stale control: the edit no longer matches (${matches} matches)`, productHashBefore: beforeHash, productHashAfter: beforeHash });
  if (baseline === undefined) return done("invalid-baseline", false, { reason: "invalid control: no baseline run", productHashBefore: beforeHash, productHashAfter: beforeHash });
  if (baseline.code !== 0 || baseline.timedOut || baseline.spawnError !== undefined || failLines(baseline.output).length > 0) {
    // Say why: a load-induced timeout and a real failure need different fixes.
    const why = baseline.timedOut ? "timed out" : baseline.spawnError ?? `exit ${baseline.code}`;
    return done("invalid-baseline", false, { reason: `invalid control: the check does not pass cleanly on the unedited copy (${why})`, failLines: failLines(baseline.output).slice(0, 5), diagnostics: baselineDiagnostics(baseline.output), productHashBefore: beforeHash, productHashAfter: beforeHash });
  }
  await writeFile(productPath, text.replaceAll(control.search, control.replace));
  const run = await runCheckFile(tempRoot, control.check, options.timeoutMs);
  await writeFile(productPath, options.breakRestore === true ? Buffer.from(text.replaceAll(control.search, control.replace) + "\n// restore deliberately broken\n") : original);
  await chmod(productPath, mode);
  const afterBytes = await readFile(productPath);
  const afterHash = createHash("sha256").update(afterBytes).digest("hex");
  if (afterHash !== beforeHash) {
    return done("restore-failed", false, { reason: "restore verification failed: the copy's product file does not match the original bytes", productHashBefore: beforeHash, productHashAfter: afterHash });
  }
  if (run.timedOut) return done("check-crashed", false, { reason: "not held: the edited run timed out", productHashBefore: beforeHash, productHashAfter: afterHash });
  if (run.spawnError !== undefined || run.code === null) {
    return done("check-crashed", false, { reason: `not held: the edited run never finished: ${run.spawnError ?? "no exit code"}`, productHashBefore: beforeHash, productHashAfter: afterHash });
  }
  if (run.code === 0) return done("not-failing", false, { reason: "not failing: the check still passes with the edit applied", productHashBefore: beforeHash, productHashAfter: afterHash });
  const lines = failLines(run.output);
  const matched = lines.find((line) => line.slice(FAIL_MARKER.length).includes(control.fragment));
  if (lines.length === 0) return done("not-failing", false, { reason: "not failing: the edited run exited non-zero without a failing assertion", failLines: lines.slice(0, 5), productHashBefore: beforeHash, productHashAfter: afterHash });
  if (matched === undefined) {
    return done("fragment-missing", false, {
      reason: `the edited run failed on other assertions; none of the ${lines.length} FAIL lines names "${control.fragment}"`,
      failLines: lines.slice(0, 5),
      productHashBefore: beforeHash,
      productHashAfter: afterHash,
    });
  }
  return done("held", true, { editedExit: run.code, matchedFailLine: matched, failLines: [matched], productHashBefore: beforeHash, productHashAfter: afterHash });
}

export async function runControls(
  repoRoot: string,
  controls: readonly ControlDecl[],
  options: { readonly timeoutMs?: number; /** Test hook (kit self-check): corrupt the restore to prove the abort. */ readonly breakRestore?: boolean; /** Injectable capability probe (kit self-check). */ readonly probe?: Pick<CapabilityProbe, "missing"> } = {},
): Promise<ControlsRun> {
  const probe = options.probe ?? new CapabilityProbe();
  const timeoutMs = options.timeoutMs ?? 600_000;
  const totalStart = Date.now();
  const copyStart = Date.now();
  const tempRoot = await mkdtemp(join(tmpdir(), "clawwright-controls-"));
  try {
    await copyRepo(repoRoot, tempRoot);
    if (controls.some((control) => control.needsGit === true)) await initGitIndex(tempRoot);
    const copyMs = Date.now() - copyStart;
    // A control is gated on the union of its check file's header requires and its own declared
    // requires: a control whose gate is unsatisfied is skipped without any baseline run.
    const missingByControl = new Map<string, readonly Capability[]>();
    const runnableChecks = new Set<string>();
    for (const control of controls) {
      // The check path is validated BEFORE its header is read: an escaping or missing path is
      // the control's own escaped-path result below, never a read outside the copy.
      if (await escapeProblem(tempRoot, control.check) !== undefined) continue;
      const required = [...new Set([...(await checkRequires(tempRoot, control.check)), ...declaredRequires(control)])];
      const missing = await probe.missing(required);
      missingByControl.set(control.id, missing);
      if (missing.length === 0) runnableChecks.add(control.check);
    }
    const baselineStart = Date.now();
    const baselines = new Map<string, CheckRun>();
    for (const check of new Set(controls.map((control) => control.check))) {
      if (!runnableChecks.has(check)) continue;
      // A check path is validated like a product path BEFORE anything runs.
      if (await escapeProblem(tempRoot, check) !== undefined) continue;
      baselines.set(check, await runCheckFile(tempRoot, check, timeoutMs));
    }
    const baselineMs = Date.now() - baselineStart;
    const results: ControlResult[] = [];
    let aborted: string | undefined;
    for (const control of controls) {
      const missing = missingByControl.get(control.id) ?? [];
      if (missing.length > 0) {
        results.push({ id: control.id, kind: "skipped", ok: false, reason: `skipped: needs ${missing.join(", ")}`, missing, durationMs: 0 });
        continue;
      }
      const result = await runOne(tempRoot, control, baselines.get(control.check), { timeoutMs, breakRestore: options.breakRestore });
      results.push(result);
      if (result.kind === "restore-failed") {
        aborted = `${control.id}: restore verification failed — the remaining controls did not run on a possibly corrupted copy`;
        break;
      }
    }
    return { results, ...(aborted === undefined ? {} : { aborted }), copyMs, baselineMs, totalMs: Date.now() - totalStart };
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch((error: unknown) => {
      process.stderr.write(`note: the temp copy could not be removed: ${(error as Error).message}\n`);
    });
  }
}

/** Per-control evidence; the aggregate held summary remains unchanged. */
export function controlVerdict(result: ControlResult): string {
  if (result.kind === "skipped") return `skipped (needs ${(result.missing ?? []).join(", ")})`;
  return result.ok ? `held (edited exit ${result.editedExit})` : `FAIL — ${result.kind}: ${result.reason}`;
}

/** `--shard <i>/<n>`: the i-th of n disjoint round-robin slices (1-based) of the declared
 *  order, so CI can run the controls in parallel jobs whose union is every control. */
export function parseShard(spec: string): { readonly index: number; readonly total: number } {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(spec);
  const index = match === null ? NaN : Number(match[1]);
  const total = match === null ? NaN : Number(match[2]);
  if (!(index >= 1 && index <= total)) throw new Error(`invalid --shard "${spec}": expected <i>/<n> with 1 <= i <= n`);
  return { index, total };
}

export function selectShard<T>(controls: readonly T[], shard: { readonly index: number; readonly total: number }): T[] {
  return controls.filter((_, position) => position % shard.total === shard.index - 1);
}

async function main(): Promise<number> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const args = process.argv.slice(2);
  const shardAt = args.indexOf("--shard");
  const shard = shardAt < 0 ? undefined : parseShard(args[shardAt + 1] ?? "");
  const selected = shardAt < 0 ? args : args.filter((_, position) => position !== shardAt && position !== shardAt + 1);
  const chosen = selected.length === 0
    ? CONTROLS
    : CONTROLS.filter((control) => selected.includes(control.id));
  const controls = shard === undefined ? chosen : selectShard(chosen, shard);
  if (controls.length === 0) {
    process.stderr.write(`no control matches: ${selected.join(", ")}\n`);
    return 1;
  }
  const run = await runControls(root, controls);
  for (const result of run.results) {
    const declaration = controls.find((control) => control.id === result.id)!;
    process.stdout.write(`${result.id} ${declaration.finding} ${controlVerdict(result)}\n`);
    for (const line of failLinesOf(result)) process.stdout.write(`    ${line}\n`);
    for (const line of result.diagnostics ?? []) process.stdout.write(`    diagnostic: ${line}\n`);
  }
  if (run.aborted !== undefined) process.stdout.write(`aborted: ${run.aborted}\n`);
  const held = run.results.filter((result) => result.ok).length;
  const skipped = run.results.filter((result) => result.kind === "skipped").length;
  const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
  process.stdout.write(
    `controls: ${held}/${run.results.length} held${skipped > 0 ? `, skipped ${skipped}` : ""} (copy ${seconds(run.copyMs)}, baseline ${seconds(run.baselineMs)}, total ${seconds(run.totalMs)})\n`,
  );
  return run.results.every((result) => result.ok || result.kind === "skipped") && run.aborted === undefined ? 0 : 1;
}

/** The edited run's failing assertions — the evidence each verdict is judged on. */
function failLinesOf(result: ControlResult): readonly string[] {
  return result.failLines ?? [];
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  try {
    process.exit(await main());
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}
