// `recipe trial` — build and run a recipe against a COPY of its declared privatePaths
// data, in its own throwaway compose project with port publications stripped. The live
// stack is never addressed, no hooks run (the trial never imports hook-runtime), and the
// project plus its scratch home are torn down on every exit path, signals included. Trial
// identity (project name, scratch home, build tags) lives in ./identity.ts, the file
// inventory and compose argv shapes in ./targets.ts, and the teardown scope in
// ./teardown.ts.

import { access } from "node:fs/promises";
import { posix } from "node:path";
import type { Context } from "#src/core/context.ts";
import { die, info, log, maskSecrets, warn } from "#src/core/io/log.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import type { RecipeRef } from "#src/core/values/plan.ts";
import { loadRecipe } from "#src/service/recipe.ts";
import { serializeComposeEnv } from "#src/runtime/docker/compose-operations.ts";
import { existsVia, privateWriteCommand } from "#src/runtime/transport/quoting.ts";
import { createIO, escapeComposeDocument, type StackIO } from "#src/runtime/docker/side-stack/io.ts";
import { waitForRecipeReadiness, DEFAULT_READINESS_GRACE_MS, DEFAULT_DECLARED_READINESS_TIMEOUT_MS } from "#src/commands/management/recipe/recovery/readiness.ts";
import { buildTagOf, trialIdentity } from "./identity.ts";
import { composeArgs, baseComposeArgs, pinnedComposeArgs, CONFIG_ARGS, type TrialTargets } from "./targets.ts";
import { abortGuard, withTeardown, TRIAL_TEARDOWN_TIMEOUT_MS } from "./teardown.ts";
import { assertNoPublications, analyzeEffectiveConfig, buildOverride, parseComposeVersion, refuseRawInclude, supportsPortOverride, type EffectiveService, parseConfigDocument } from "./ports.ts";

/** Total privatePaths size a trial is willing to copy — a duplicate of the data directory,
 *  so an operator asking to trial a 40 GiB tree must be stopped, not silently obeyed. */
export const TRIAL_PRIVATE_PATHS_BOUND_BYTES = 256 * 1024 * 1024;

const TRIAL_LOG_TAIL_LINES = 20;

/** One `cp -a` of up to the 256 MiB privatePaths bound (plus the size/symlink probes and
 *  the scratch-home mkdir) across the transport. */
const TRIAL_COPY_TIMEOUT_MS = 300_000;

/** One read-only compose evaluation: `config --format json` and `version --short`. */
const TRIAL_CONFIG_TIMEOUT_MS = 120_000;

/** One from-source `compose build`: recipe images compile from source and compose has no
 *  internal build bound, so the trial supplies an explicit one. */
const TRIAL_BUILD_TIMEOUT_MS = 1_800_000; // 30 minutes

/** One `compose up`: `--wait` is already bounded by the declared readiness timeout; this
 *  is the outer cap (and the only bound when the recipe declares no readiness). */
const TRIAL_UP_TIMEOUT_MS = 600_000;

/** `buildImages` maps the base build inventory to exact per-run trial tags. */

/** The trial's overrides need Compose's `!override` merge tag: v2.24+. BOTH the real run
 *  and the dry-run refuse older or unreadable versions — stricter and simpler than
 *  probing differently per mode, and there is no older-version strategy to fall back to. */
async function requireComposeMergeTags(io: StackIO): Promise<void> {
  const requirement = "recipe trial requires Docker Compose v2.24.0 or newer (for the ports: !override merge tag)";
  let version: ReturnType<typeof parseComposeVersion>;
  try {
    version = parseComposeVersion((await io.run(["compose", "version", "--short"], undefined, TRIAL_CONFIG_TIMEOUT_MS)).stdout);
  } catch (error) {
    die(`${requirement}, and the target's Compose version could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (version === undefined) die(`${requirement}, but the target's Compose version output could not be parsed`);
  if (!supportsPortOverride(version)) die(`${requirement}; the target has v${version.major}.${version.minor}.${version.patch}`);
}

interface DeclaredPath {
  readonly entry: string;
  readonly resolved: string;
}

type PresenceState = "present" | "absent" | "unknown";

interface PathSize {
  readonly entry: string;
  readonly bytes: number | null;
  readonly state: "measured" | "absent" | "unknown";
}

/** Declarations nested under another declaration are dropped (segments, not string
 *  prefixes): the parent copy already carries them. */
function dropNested(entries: readonly string[]): { top: string[]; dropped: string[] } {
  const top = entries.filter((entry) =>
    !entries.some((other) => other !== entry && (entry === other || entry.startsWith(`${other}/`))));
  return { top, dropped: entries.filter((entry) => !top.includes(entry)) };
}

/** Target-side presence probe, reusing the repo's errno-aware walk (`existsVia`): a
 *  definitive boolean is present/absent; a throw is UNKNOWN — the caller refuses on
 *  unknown rather than copying a tree it could not measure. */
async function probePresence(ctx: Context, path: string): Promise<PresenceState> {
  try {
    return await existsVia((command, args, options) => ctx.transport.exec(command, args, { ...options, timeoutMs: options?.timeoutMs ?? TRIAL_CONFIG_TIMEOUT_MS }), path) ? "present" : "absent";
  } catch {
    return "unknown";
  }
}

/** One batched target-side `du -sb` over the present entries. A failing du or a path
 *  missing from its output is unknown — the caller refuses on unknown. */
async function measurePrivatePaths(ctx: Context, declared: readonly DeclaredPath[]): Promise<PathSize[]> {
  const states = await Promise.all(declared.map(async (path) => ({ ...path, presence: await probePresence(ctx, path.resolved) })));
  const present = states.filter((path) => path.presence === "present").map((path) => path.resolved);
  const sizes = new Map<string, number>();
  if (present.length > 0) {
    const result = await ctx.transport.exec("sh", ["-c", 'du -sb -- "$@"', "recipe-trial-size", ...present], { allowFailure: true, timeoutMs: TRIAL_COPY_TIMEOUT_MS });
    if (result.code === 0) {
      for (const line of result.stdout.split("\n")) {
        const tab = line.indexOf("\t");
        if (tab < 0) continue;
        // GNU du -sb prints `<bytes><TAB><path>`; preserve paths (including leading digits) as the right-hand field.
        const bytes = Number(line.slice(0, tab));
        if (Number.isFinite(bytes)) sizes.set(line.slice(tab + 1), bytes);
      }
    }
  }
  return states.map(({ resolved: entry, presence }) => {
    const bytes = sizes.get(entry);
    if (presence === "absent") return { entry, bytes: null, state: "absent" as const };
    if (presence === "unknown" || bytes === undefined) return { entry, bytes: null, state: "unknown" as const };
    return { entry, bytes, state: "measured" as const };
  });
}

function totalOf(sizes: readonly PathSize[]): number {
  return sizes.reduce((sum, size) => sum + (size.bytes ?? 0), 0);
}

/** Fail closed: an unmeasurable path refuses before any bound comparison, in dry-run and
 *  real run alike — a trial that cannot know the size might be copying gigabytes. */
function refuseUnmeasurable(sizes: readonly PathSize[]): void {
  const unknown = sizes.filter((size) => size.state === "unknown");
  if (unknown.length > 0) {
    die(`recipe trial refuses to run: the size of privatePath ${unknown.map((size) => size.entry).join(", ")} could not be measured (the probe failed or the path is unreadable) — refusing rather than copying a tree of unknown size`);
  }
}

function sizeLines(sizes: readonly PathSize[]): string[] {
  return sizes.map((size) =>
    size.state === "measured" ? `${size.entry}: ${size.bytes} bytes`
    : size.state === "absent" ? `${size.entry}: absent (not copied)`
    : `${size.entry}: unknown`);
}

function refuseOverBound(total: number, sizes: readonly PathSize[]): never {
  const detail = sizeLines(sizes).map((line) => `  ${line}`).join("\n");
  die(`recipe trial refuses to copy ${total} bytes of privatePaths — the bound is ${TRIAL_PRIVATE_PATHS_BOUND_BYTES} bytes (${Math.floor(TRIAL_PRIVATE_PATHS_BOUND_BYTES / (1024 * 1024))} MiB).\n${detail}`);
}

/** One target-side find over the resolved entries, listing every symlink. A failing find
 *  is a refusal (unknown link state could copy outside the tree). Absolute targets and
 *  relative targets climbing out of the declaring entry's subtree refuse; an in-tree
 *  relative link is allowed — `cp -a` preserves it and it stays inside. */
const SYMLINK_SCRIPT = `find "$@" -type l -printf '%p\\t%l\\n'`;

async function auditSymlinks(ctx: Context, declared: readonly DeclaredPath[]): Promise<void> {
  if (declared.length === 0) return;
  const result = await ctx.transport.exec("sh", ["-c", SYMLINK_SCRIPT, "recipe-trial-symlinks", ...declared.map((path) => path.resolved)], { allowFailure: true, timeoutMs: TRIAL_COPY_TIMEOUT_MS });
  if (result.code !== 0) die(`recipe trial refuses: the privatePaths symlink check failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  for (const line of result.stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const link = line.slice(0, tab);
    const text = line.slice(tab + 1);
    const top = declared.find((path) => link === path.resolved || link.startsWith(`${path.resolved}/`));
    if (top === undefined) continue;
    if (text.startsWith("/")) die(`recipe trial refuses: ${link} is a symlink to the absolute target ${text}`);
    const target = posix.normalize(posix.join(posix.dirname(link), text));
    if (target !== top.resolved && !target.startsWith(`${top.resolved}/`)) {
      die(`recipe trial refuses: ${link} is a symlink whose target ${text} escapes the declared path ${top.resolved}`);
    }
  }
}

/** One batched target-side `realpath` over the compose bind sources: a symlinked source
 *  would silently mount a path outside the allowed directories. A failing or short
 *  realpath refuses (die) — the scan fail-closes on unknown resolution. */
async function resolveOnTarget(ctx: Context, paths: readonly string[]): Promise<readonly string[]> {
  if (paths.length === 0) return [];
  const result = await ctx.transport.exec("sh", ["-c", 'realpath -- "$@"', "recipe-trial-mount-realpath", ...paths], { allowFailure: true, timeoutMs: TRIAL_CONFIG_TIMEOUT_MS });
  if (result.code !== 0) die(`recipe trial refuses: the real paths of the compose bind mounts could not be resolved: ${result.stderr.trim() || `exit ${result.code}`}`);
  const lines = result.stdout.split("\n").filter((line) => line !== "");
  if (lines.length < paths.length) die(`recipe trial refuses: the real paths of the compose bind mounts could not be read — refusing rather than mounting through an unknown symlink`);
  return lines.slice(0, paths.length);
}

/** Resolves each present entry's real path target-side: a symlinked ancestor would
 *  silently copy a foreign subtree. */
async function auditRealPaths(ctx: Context, declared: readonly DeclaredPath[]): Promise<void> {
  if (declared.length === 0) return;
  const result = await ctx.transport.exec("sh", ["-c", 'realpath -- "$@"', "recipe-trial-realpath", ...declared.map((path) => path.resolved)], { allowFailure: true, timeoutMs: TRIAL_CONFIG_TIMEOUT_MS });
  if (result.code !== 0) die(`recipe trial refuses: the real paths of privatePaths could not be resolved: ${result.stderr.trim() || `exit ${result.code}`}`);
  const lines = result.stdout.split("\n").filter((line) => line !== "");
  for (const [index, path] of declared.entries()) {
    const real = lines[index];
    if (real === undefined) die(`recipe trial refuses: the real path of privatePath ${path.resolved} could not be read — refusing rather than copying through an unknown symlink`);
    if (real !== path.resolved && !real.startsWith(`${path.resolved}/`)) {
      die(`recipe trial refuses: privatePath ${path.resolved} resolves to ${real}, outside the declared path — the entry or an ancestor is a symlink pointing elsewhere`);
    }
  }
}

/** Per-entry target-side copy, one `cp -a` per TOP-LEVEL entry. A declared entry missing
 *  on the target is treated as empty: the trial creates the directory in the scratch copy,
 *  matching how the migration tooling treats absent declared paths (skipped, not fatal). */
const COPY_SCRIPT = `set -eu
home=$1; data=$2; shift 2
mkdir -p -- "$home/data"
for entry do
  if [ -e "$data/$entry" ]; then
    mkdir -p -- "$home/data/$(dirname -- "$entry")"
    cp -a -- "$data/$entry" "$home/data/$entry"
  else
    mkdir -p -- "$home/data/$entry"
  fi
done
`;

async function lexicalResolver(paths: readonly string[]): Promise<readonly string[]> {
  // Base inventory is used only to derive the override. Do not canonicalize scratch binds
  // before the copy: their targets do not exist yet. The merged analysis after copy is
  // the only binding realpath proof in a real run.
  return paths;
}

async function resolveDryRunScratchBinds(ctx: Context, scratchData: string, liveData: string,
  paths: readonly string[]): Promise<readonly string[]> {
  const mapped = paths.map((path) => path === scratchData || path.startsWith(`${scratchData}/`)
    ? `${liveData}${path.slice(scratchData.length)}` : path);
  const result = await resolveOnTarget(ctx, mapped);
  return result.map((real, index) => {
    const original = paths[index] ?? "";
    const corresponding = original === scratchData || original.startsWith(`${scratchData}/`);
    if (!corresponding) return real;
    if (real !== liveData && !real.startsWith(`${liveData}/`)) return real;
    return `${scratchData}${real.slice(liveData.length)}`;
  });
}

/** Evaluates the BASE compose file's effective configuration on the target. Config
 *  evaluation is MANDATORY in dry-run too — every isolation refusal plus the override's
 *  own shape is a fact about the effective config; guessing them would fail open. The
 *  dry-run exports the trial environment around the docker call, since its env file does
 *  not exist yet; the real run reads it from the env file the teardown scope just wrote. */
async function evaluateBaseConfig(io: StackIO, ctx: Context, targets: TrialTargets, dryRun: boolean, abort?: AbortSignal): Promise<Record<string, unknown>> {
  if (dryRun) {
    let result;
    try {
      result = await io.run(["compose", "--project-name", targets.project, "--file", targets.definitionFile,
        "--project-directory", posix.dirname(targets.definitionFile), ...CONFIG_ARGS],
      { ...ctx.settings.env, OC_DATA_DIR: targets.dataDir }, TRIAL_CONFIG_TIMEOUT_MS);
    } catch (error) {
      die(`recipe trial could not evaluate the base compose configuration: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseConfigDocument(result.stdout);
  }
  let proven;
  try {
    proven = await io.run(baseComposeArgs(targets, [...CONFIG_ARGS]), undefined, TRIAL_CONFIG_TIMEOUT_MS, abort);
  } catch (error) {
    die(`recipe trial could not evaluate the base compose configuration (docker compose config --format json): ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfigDocument(proven.stdout);
}

/** Evaluates the MERGED (base + override) configuration — the binding analysis and the
 *  publication proof run against it while nothing has been built or started yet
 *  (`config` is read-only). */
async function evaluateMergedConfig(io: StackIO, targets: TrialTargets, abort?: AbortSignal): Promise<Record<string, unknown>> {
  let result;
  try {
    result = await io.run(composeArgs(targets, [...CONFIG_ARGS]), undefined, TRIAL_CONFIG_TIMEOUT_MS, abort);
  } catch (error) {
    die(`recipe trial could not prove the merged compose configuration (docker compose config --format json): ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfigDocument(result.stdout);
}

/** Best-effort docker call: teardown and log tails must report, not abort. The optional
 *  timeoutMs kills the child instead of letting a hung down hold the exit hostage. */
async function softDocker(ctx: Context, fileArgs: readonly string[], args: readonly string[], timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await ctx.transport.exec("docker", [...fileArgs, ...args], { allowFailure: true, stream: false, timeoutMs });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

async function serviceLogTail(ctx: Context, targets: TrialTargets, service: string): Promise<string> {
  const result = await softDocker(ctx, baseComposeArgs(targets, []), ["logs", "--no-color", "--tail", String(TRIAL_LOG_TAIL_LINES), service], TRIAL_CONFIG_TIMEOUT_MS);
  return result.stdout + (result.code === 0 || result.stderr === "" ? "" : `\n${result.stderr}`);
}

/** Best-effort per-service evidence after a build/start failure: whatever `ps --all`
 *  reports (base compose) plus sanitized log tails. Nothing here may throw — the original
 *  failure is the reason we are collecting. */
async function failureEvidence(ctx: Context, targets: TrialTargets, io: StackIO, services: readonly EffectiveService[]): Promise<string> {
  const lines: string[] = [];
  const collect = async (): Promise<void> => {
    const result = await ctx.transport.exec("docker", baseComposeArgs(targets, ["ps", "--all"]), { allowFailure: true, stream: false, timeoutMs: TRIAL_CONFIG_TIMEOUT_MS });
    const listing = io.sanitize(maskSecrets(result.stdout.split("\n").slice(0, FAILURE_EVIDENCE_PS_LINES).join("\n").trimEnd()));
    lines.push(`compose ps --all (exit ${result.code}):`, listing === "" ? "(no output)" : listing);
    const reported = result.code === 0
      ? result.stdout.split("\n").slice(1).map((line) => line.trim().split(/\s+/)[0]).filter((name): name is string => name !== undefined && name !== "")
      : [];
    const names = [...new Set([...services.map((service) => service.name), ...reported])];
    for (const service of names) {
      const tail = io.sanitize(maskSecrets(await serviceLogTail(ctx, targets, service)));
      lines.push(`${service} log tail:\n${tail}`);
    }
  };
  try { await collect(); }
  catch (error) {
    lines.push(`failure evidence itself could not be collected: ${io.sanitize(maskSecrets(error instanceof Error ? error.message : String(error)))}`);
  }
  return lines.join("\n");
}

/** Cap for failure evidence (`compose ps --all` output) so a pathological listing
 *  cannot flood the refusal message. */
const FAILURE_EVIDENCE_PS_LINES = 40;

async function runTrial(ctx: Context, name: RecipeRef, dryRun: boolean): Promise<void> {
  const recipe = await loadRecipe(name);
  // The definition's existence is the recipeRef kind's own resolve; access is kept because
  // the trial additionally reads compose.yml host-side for its raw-text `extends` refusal
  // scan — the one thing the effective config cannot reveal, having resolved it away.
  await access(recipe.definitionPath).catch(() => die(`recipe "${recipe.name}" has no compose.yml at ${recipe.definitionPath}`)); // the raw `include:` refusal scan reads the file host-side
  const identity = trialIdentity(ctx, recipe.name);
  const io: StackIO = createIO(ctx.transport, ctx.paths, () => ctx.settings, identity.project, recipe.definitionPath, []);
  const targets: TrialTargets = {
    project: identity.project,
    home: identity.home,
    envFile: `${identity.home}/compose.env`,
    overrideFile: `${identity.home}/override.yml`,
    pinnedFile: `${identity.home}/pinned-compose.json`,
    dataDir: `${identity.home}/data`,
    definitionFile: await io.file(),
  };

  const { top, dropped } = dropNested(recipe.privatePaths ?? []);
  const declared: DeclaredPath[] = top.map((entry) => ({ entry, resolved: `${ctx.settings.dataDir}/${entry}` }));
  const sizes = await measurePrivatePaths(ctx, declared);
  refuseUnmeasurable(sizes);
  const total = totalOf(sizes);
  const overBound = total > TRIAL_PRIVATE_PATHS_BOUND_BYTES;

  // The effective-config analysis is the fact base for both the plan and the real run:
  // the base compose file's effective configuration is evaluated on the target (read-only,
  // mandatory even in dry-run) and scanned for refusals, and the ports-stripping override
  // is derived from the analysis — never from a host-side line scan that valid compose
  // shapes could slip past. The BINDING analysis, including the tagged-build-image rule,
  // is the one on the MERGED document below; this base scan is kept as an early refusal
  // (harmless and stricter: it refuses before anything is written at all).
  const allowedBindPrefixes = [targets.dataDir, posix.dirname(targets.definitionFile)];
  if (dryRun) {
    const baseConfig = await evaluateBaseConfig(io, ctx, targets, true);
    await refuseRawInclude(recipe.definitionPath);
    // The dry-run can only resolve scratch-data bind paths by mapping them to the
    // corresponding live data paths; the scratch copy does not exist in read-only mode.
    // That is a useful refusal scan, not proof of actual scratch realpath; disclose the
    // skipped merged proof below.
    const analysis = await analyzeEffectiveConfig(baseConfig, allowedBindPrefixes, targets.project,
      (paths) => resolveDryRunScratchBinds(ctx, targets.dataDir, ctx.settings.dataDir, paths));
    const present = declared.filter((_, index) => sizes[index]?.state === "measured");
    // Dry-run derives the SAME build-image overrides a real run writes (buildTagOf per
    await auditSymlinks(ctx, present);
    await auditRealPaths(ctx, present);
    // Dry-run derives the SAME build-image overrides a real run writes (buildTagOf per
    // building service): the shape matches exactly, only the random suffix differs — the
    // same relationship the project name's suffix already documents.
    const buildImages = new Map<string, string>();
    for (const service of analysis.services) {
      if (service.builds) buildImages.set(service.name, buildTagOf(identity, service.name));
    }
    const override = buildOverride(analysis.services, buildImages);
    const report = {
      ok: !overBound,
      changed: false,
      dryRun: true,
      recipe: recipe.name,
      project: targets.project,
      projectNote: "the random suffix differs on every run",
      scratchHome: targets.home,
      privatePaths: sizes.map((size) => ({ entry: size.entry, bytes: size.bytes, state: size.state })),
      nestedDropped: dropped,
      totalBytes: total,
      boundBytes: TRIAL_PRIVATE_PATHS_BOUND_BYTES,
      overrideFile: override,
      // Honest disclosure: the merged-config proof needs the override ON DISK and a
      // dry-run writes nothing, so it cannot run here — the real run refuses on failure.
      configProof: "skipped (requires writing the override); scratch binds are checked via live-data path mapping, not the scratch copy; the real run refuses on failure",
    };
  if (isCaptured()) {
      emit(`${JSON.stringify(report)}\n`);
    } else {
      log(`recipe trial --dry-run: ${recipe.name}`);
      info(`compose project: ${targets.project} (the random suffix differs on every run)`);
      info(`scratch home: ${targets.home}`);
      for (const line of sizeLines(sizes)) info(`privatePath ${line}`);
      for (const entry of dropped) info(`privatePath ${entry}: nested under another declared entry — the parent copy covers it`);
      info(`total: ${total} bytes (bound ${TRIAL_PRIVATE_PATHS_BOUND_BYTES} bytes)`);
      info("override file that would be written:");
      info(override);
      // Not faked here: the merged-config proof needs the override file ON DISK (compose
      // evaluates files from disk) and dry-run writes nothing — the real run's proof
      // covers it.
      info('configProof: skipped (requires writing the override); scratch binds are checked via live-data path mapping, not the scratch copy; the real run refuses on failure');
    }
    if (overBound) refuseOverBound(total, sizes);
    // No older-version fallback exists: the dry-run refuses older or unreadable compose
    // versions too (stricter and simpler), only after the cheap local refusals above.
    await requireComposeMergeTags(io);
    return;
  }

  if (overBound) refuseOverBound(total, sizes);
  // versions before the first mutation.
  await requireComposeMergeTags(io);
  if (ctx.transport.cancellation !== "confirmed-local" && ctx.transport.cancellation !== "local-only")
    die(`recipe trial refuses transport ${ctx.transport.description}: cancellation cannot be confirmed safely`);

  // One AbortController per trial run: every scope exec below carries its signal, so a
  // signal kills the in-flight mutation (transport killTree) instead of outliving cleanup.
  const controller = new AbortController();
  // remoteUntil: a mutation whose call threw or timed out on a local-only-cancellation
  // transport (SSH) may still be running on the target until its own watchdog expires; the
  // teardown waits that out before any destructive cleanup, on every failure path.
  const mutationRecord = { active: false, startedAt: 0, waitMs: undefined as number | undefined, remoteUntil: 0 };
  const tracked = async <T extends { readonly timedOut?: boolean }>(timeoutMs: number, body: () => Promise<T>): Promise<T> => {
    mutationRecord.active = true;
    mutationRecord.startedAt = Date.now();
    mutationRecord.waitMs = Math.ceil(timeoutMs / 1000) * 1000 + 5_000;
    try {
      const result = await body();
      if (result.timedOut === true) mutationRecord.remoteUntil = mutationRecord.startedAt + mutationRecord.waitMs;
      return result;
    } catch (error) {
      mutationRecord.remoteUntil = mutationRecord.startedAt + mutationRecord.waitMs;
      throw error;
    } finally { mutationRecord.active = false; }
  };
  const runMutation = (args: string[], timeoutMs: number, abort: AbortSignal) =>
    tracked(timeoutMs, () => io.run(args, undefined, timeoutMs, abort));

  // Everything from the first scratch mutation onward lives inside the teardown scope:
  // each resource registers for removal at the moment it is created, so a refusal after
  // creation (a copy failure, say) still tears down what exists.
  await withTeardown(targets, async (register, isAborted) => {
    const abort = controller.signal;

    // Register-then-do: the scratch-home removal is registered BEFORE the mkdir that
    // creates it, so a signal during the pending mkdir still ends with the directory
    // registered — and removed LAST under LIFO, after down has used the files inside it.
    register({
      name: `scratch home ${targets.home}`,
      run: async () => {
        const removed = await ctx.transport.exec("rm", ["-rf", targets.home], { allowFailure: true, timeoutMs: TRIAL_COPY_TIMEOUT_MS });
        if (removed.code !== 0 || removed.timedOut) throw new Error(`scratch home removal failed or timed out (exit ${removed.code})`);
      },
    });
    abortGuard(isAborted, "the scratch-home creation");
    const timeoutMs = TRIAL_COPY_TIMEOUT_MS;
    const made = await tracked(timeoutMs, () => ctx.transport.exec("mkdir", ["-m", "700", targets.home], { allowFailure: true, timeoutMs, signal: abort }));
    if (made.code !== 0) die(`recipe trial could not create its private scratch home (exit ${made.code})`);
    // The trial's env file carries the deployment environment with OC_DATA_DIR overridden to
    // the scratch copy — the same shape withEnvFile gives live compose calls.
    abortGuard(isAborted, "the trial env file write");
    const writePrivate = async (path: string, content: string | Uint8Array): Promise<void> => {
      const [command, args] = privateWriteCommand(path);
      const result = await tracked(TRIAL_COPY_TIMEOUT_MS, () => ctx.transport.exec(command, args, {
        input: content, allowFailure: true, timeoutMs: TRIAL_COPY_TIMEOUT_MS, signal: abort,
      }));
      if (result.code !== 0 || result.timedOut) throw new Error(`private trial write failed or timed out (exit ${result.code})`);
    };
    const envContent = serializeComposeEnv({ ...ctx.settings.env, OC_DATA_DIR: targets.dataDir });
    await writePrivate(targets.envFile, envContent);

    // Refuse before anything is built or started: base config evaluated read-only and
    // scanned (early refusal), override derived and written, privatePaths copied, MERGED
    // config analyzed and proven to publish nothing — all before the first build.
    const baseConfig = await evaluateBaseConfig(io, ctx, targets, false, abort);
    await refuseRawInclude(recipe.definitionPath);
    const baseAnalysis = await analyzeEffectiveConfig(baseConfig, allowedBindPrefixes, targets.project,
      lexicalResolver);
    // Build tags derive from the BASE analysis's build flags: the override never removes
    // a `build` section, so the merged document's builders are the same set — and the
    // merged analysis below refuses any build service whose surviving `image` is not the
    // trial's own tag.
    const buildImages = new Map<string, string>();
    for (const service of baseAnalysis.services) {
      if (service.builds) buildImages.set(service.name, buildTagOf(identity, service.name));
    }
    const override = buildOverride(baseAnalysis.services, buildImages);
    abortGuard(isAborted, "the ports-override write");
    await writePrivate(targets.overrideFile, override);

    const present = declared.filter((_, index) => sizes[index]?.state === "measured");
    await auditSymlinks(ctx, present);
    await auditRealPaths(ctx, present);

    abortGuard(isAborted, "the privatePaths copy");
    if (top.length > 0) {
      const copied = await tracked(TRIAL_COPY_TIMEOUT_MS, () => ctx.transport.exec("sh", ["-c", COPY_SCRIPT, "recipe-trial-copy", targets.home, ctx.settings.dataDir, ...top], { allowFailure: true, timeoutMs: TRIAL_COPY_TIMEOUT_MS, signal: abort }));
      if (copied.code !== 0) die(`recipe trial could not copy privatePaths into the scratch home: ${copied.stderr.trim() || `exit ${copied.code}`}`);
    }

    // The MERGED analysis is the binding one — and it deliberately runs AFTER the copy
    // phase, so `<home>/data` and its copied subdirectories exist when `realpath`
    // canonicalizes `${OC_DATA_DIR}/...` bind sources (the env file points OC_DATA_DIR at
    // <home>/data). It carries the trial build-tag prefix: an un-renamed base image on a
    // build service refuses here.
    const mergedConfig = await evaluateMergedConfig(io, targets, abort);
    const analysis = await analyzeEffectiveConfig(mergedConfig, allowedBindPrefixes, targets.project,
      (paths) => resolveOnTarget(ctx, paths), buildImages);
    // The publication proof runs on the UNESCAPED merged config: ports are numeric keys,
    // so escaping could not hide anything — but the proof must see the document as the
    // analysis saw it, with no escaping step in between.
    assertNoPublications(mergedConfig);
    // Pin the document: the EXACT proven effective config is written as a JSON compose
    // file (JSON is valid compose), and build, up AND the teardown down all run against
    // THAT file — proven and executed documents are byte-identical. compose loads the
    // pinned file AGAIN, with the env file, and un-escapes once on load; escaping here
    // ($ → $$, recursively — the same helper the side-stack uses for its resolved
    // documents) means the executed values equal the proven values, with no second
    // interpolation pass on the way in. It lives inside the scratch home, so it needs no
    // separate teardown step.
    abortGuard(isAborted, "the pinned compose document write");
    await writePrivate(targets.pinnedFile, JSON.stringify(escapeComposeDocument(mergedConfig)));

    // The compose project comes into existence with the first build; everything here
    // registers BEFORE build/up starts. LIFO execution is the reverse of this order:
    // down FIRST, then the per-tag removals, then the labelled-image check, then the
    // scratch home LAST — the check must observe the project after down. These cleanup
    // execs deliberately carry NO abort signal: cleanup runs after the abort has already
    // settled the scope, and a killed cleanup would leave resources behind.
    register({
      name: `labelled-image check for trial project "${targets.project}"`,
      run: async () => {
        const images = await ctx.transport.exec("docker", ["images", "--filter", `label=com.docker.compose.project=${targets.project}`, "-q"], { allowFailure: true, timeoutMs: TRIAL_TEARDOWN_TIMEOUT_MS });
        if (images.timedOut === true || images.code !== 0) {
          throw new Error(`the labelled-image query failed: ${images.stderr.trim() || `exit ${images.code}`} — the image state is unknown`);
        }
        if (images.stdout.trim() !== "") {
          throw new Error(`images labelled for trial project "${targets.project}" remain: ${images.stdout.trim().split(/\s+/).join(", ")}`);
        }
      },
    });
    // One INDEPENDENTLY-GUARDED step PER TAG: a failure on one never skips the others.
    // Each tag is removed with --force, then absence is PROVEN with image inspect: exit 1
    // carrying the daemon's "No such image" evidence is success; ANY other outcome
    // (nonzero without that evidence, timeout, throw) is UNKNOWN — a leftover, never success.
    for (const [service, tag] of buildImages) {
      register({
        name: `trial build image removal for ${service} (${tag})`,
        run: async () => {
          const removed = await ctx.transport.exec("docker", ["image", "rm", "--force", tag], { allowFailure: true, stream: false, timeoutMs: TRIAL_TEARDOWN_TIMEOUT_MS });
          if (removed.timedOut === true) throw new Error(`image ${tag} removal timed out — its state is unknown`);
          const inspect = await ctx.transport.exec("docker", ["image", "inspect", tag], { allowFailure: true, stream: false, timeoutMs: TRIAL_TEARDOWN_TIMEOUT_MS });
          if (inspect.timedOut === true) throw new Error(`image ${tag} presence probe timed out — its state is unknown`);
          if (!(inspect.code === 1 && inspect.stderr.toLowerCase().includes("no such image"))) {
            const detail = (inspect.code !== 0 ? inspect.stderr : removed.stderr).trim() || `rm exit ${removed.code}, inspect exit ${inspect.code}`;
            throw new Error(`image ${tag} state is unknown after the removal attempt: ${detail}`);
          }
        },
      });
    }
    register({
      name: `docker compose down for trial project "${targets.project}"`,
      run: async () => {
        // The down runs against the PINNED document, so it works even though the
        // original --file inputs are irrelevant to what was actually built and started.
        const down = await softDocker(ctx, pinnedComposeArgs(targets, []), ["down", "--volumes", "--remove-orphans", "--rmi", "local"], TRIAL_TEARDOWN_TIMEOUT_MS);
        if (down.code !== 0) throw new Error(down.stderr.trim() || `exit ${down.code}`);
      },
    });

    log(`building ${recipe.name} trial (this compiles from source and can take minutes)`);
    const readinessTimeoutMs = recipe.readiness === undefined
      ? DEFAULT_READINESS_GRACE_MS
      : recipe.readiness.timeoutMs ?? DEFAULT_DECLARED_READINESS_TIMEOUT_MS;
    let startError: unknown;
    try {
      abortGuard(isAborted, "the trial build");
      await runMutation(pinnedComposeArgs(targets, ["build"]), TRIAL_BUILD_TIMEOUT_MS, abort);
      log(`starting ${recipe.name} trial`);
      // --wait only when the recipe declared readiness, exactly as install does: without a
      // bound, a healthcheck that never turns healthy would hang compose's own wait.
      abortGuard(isAborted, "the trial start");
      await runMutation(pinnedComposeArgs(targets, recipe.readiness === undefined
        ? ["up", "--detach"]
        : ["up", "--detach", "--wait", "--wait-timeout", String(Math.ceil(readinessTimeoutMs / 1000))]), TRIAL_UP_TIMEOUT_MS, abort);
    } catch (caught) {
      startError = caught;
    }
    if (startError !== undefined) {
      const originalFailure = startError;
      const startFailure = originalFailure instanceof Error ? originalFailure.message : String(originalFailure);
      const evidence = await failureEvidence(ctx, targets, io, analysis.services);
      die(`recipe ${recipe.name} trial build or start failed: ${startFailure}\n${evidence}`);
    }

    // Ownership checks are off: the trial carries none of the provenance labels the live
    // stack's guard keys on, and there is nothing here to own.
    const stack = ctx.runtime.stack(targets.project, recipe.definitionPath, { verifyOwnership: false });
    const readiness = await waitForRecipeReadiness(stack, recipe.readiness, readinessTimeoutMs);
    // One explicit line per DECLARED service (or every service compose reports when
    // nothing is declared): a service that never appeared in any state poll counts as
    // not-ready, it must never be silence-passed.
    const watched = recipe.readiness?.services ?? Object.keys(readiness.services);
    const verdicts: Record<string, string> = {};
    for (const service of watched) {
      const state = readiness.services[service];
      verdicts[service] = state === undefined ? "not ready (never reported)"
        : !state.running ? "not ready (not running)"
        : state.health === undefined || state.health === "healthy" ? "ready"
        : `not ready (${state.health})`;
    }
    const tails: Record<string, string> = {};
    for (const service of Object.keys(readiness.services)) {
      tails[service] = io.sanitize(maskSecrets(await serviceLogTail(ctx, targets, service)));
    }
    const report = { recipe: recipe.name, project: targets.project, status: readiness.status, detail: readiness.detail, services: readiness.services, serviceVerdicts: verdicts, logs: tails };

    for (const [service, verdict] of Object.entries(verdicts)) info(`${service}: ${verdict}`);

    if (readiness.status !== "ready") {
      if (isCaptured()) emit(`${JSON.stringify(report)}\n`);
      warn(`${recipe.name} trial started but is not ready (${readiness.status}): ${readiness.detail}`);
      for (const [service, tail] of Object.entries(tails)) info(`${service} log tail:\n${tail}`);
      die(`recipe ${recipe.name} trial did not reach a ready state`);
    }
    if (isCaptured()) {
      emit(`${JSON.stringify(report)}\n`);
      return;
    }
    log(`${recipe.name} trial is ready`);
    for (const [service, tail] of Object.entries(tails)) info(`${service} log tail:\n${tail}`);
    info(`the trial project "${targets.project}" and its scratch home are removed; nothing persists`);
  }, () => controller.abort(), TRIAL_COPY_TIMEOUT_MS, ctx.transport.cancellation, () => mutationRecord.active, () => mutationRecord.waitMs, () => warn(`SSH target mutation may still be running; waiting through watchdog rounding and kill grace. A second signal skips wait and cleanup; resources may remain for project "${targets.project}" at ${targets.home}.`),
    () => ctx.transport.cancellation === "local-only" ? Math.max(0, mutationRecord.remoteUntil - Date.now()) : 0);
}

/** `--dry-run`: the same refusals a real trial makes (compose version, compose.yml
 *  readable, unmeasurable and over-bound sizes), then the full plan — no lock, no writes,
 *  no build. */
export async function runTrialDryRun(ctx: Context, name: RecipeRef): Promise<void> {
  await runTrial(ctx, name, true);
}

export async function runTrialAction(ctx: Context, name: RecipeRef): Promise<void> {
  await runTrial(ctx, name, false);
}
