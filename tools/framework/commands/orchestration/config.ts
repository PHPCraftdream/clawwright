// `clawwright apply-config` — reconciles config/desired-state.json with the live instance.

import { access, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { log, info, warn, die } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit } from "#src/core/io/output.ts";
import { desiredStateFile } from "#src/runtime/deployment.ts";
import type { Context } from "#src/core/context.ts";
import { guardedWith } from "#src/runtime/lock/instance-lock.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import { readLiveConfigOrThrow, valueAt } from "./inspect/helpers.ts";
import { desiredStateShapeError } from "#src/set/ownership/validate.ts";
import { configPathParts } from "#src/core/values/config/config-selectors.ts";
import { desiredConfig } from "#src/core/values/config/desired-config.ts";
import { refuseUnenrolledSSJackReferences } from "#src/core/values/ssjack-secret-refs.ts";
import { readDeclaredConfig, readDeclaredConfigStrict, writeDeclaredConfig } from "#src/set/ownership/declared-config.ts";
import { conflictingDeclaredPath, declaredOwnershipConflictDetail, filterOwnedDeclarations, recipePathOwners, refuseDeclaredOwnedPaths } from "#src/set/ownership/recipe-paths.ts";
import type { RecipePathOwner } from "#src/set/ownership/recipe-paths.ts";
import type { ArgumentSpec, ParsedCall } from "#src/core/command/spec.ts";
import { commandBody, parseCall, specShape } from "#src/core/command/index.ts";
import { BREAK_FOREIGN_LOCK_ARGUMENT } from "#src/commands/interface/groups/shared-arguments.ts";

export const APPLY_CONFIG_ARGUMENTS = [
  { name: "dry-run", summary: "Validate without writing", description: "Validate the apply without writing; refused together with --dump", kind: "flag", effect: "read" },
  { name: "dump", summary: "Rebuild from the live config", description: "Reconstruct desired-state.json from the live instance's config", kind: "flag" },
  { name: "force", summary: "Overwrite; refused without it", description: "Overwrite an existing desired-state.json (with --dump); refused without it", kind: "flag", effect: "destroy" },
  { name: "break-lock", summary: "Take over the lock", description: "Take over the instance lock held by another operation (real apply only)", kind: "flag" },
  BREAK_FOREIGN_LOCK_ARGUMENT,
  { name: "json", description: "Outcome as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];



/** Name of the copy staged inside the data directory. The CLI runs in the container and
 *  only sees the mounted data directory, so the payload has to travel there.
 *
 *  A real run stages under this shared name, only while holding the instance lock. A dry
 *  run gets its own name: it deliberately takes no lock, and the shared file without one
 *  could replace the payload a concurrent real apply was about to read. */
const stagedName = "clawwright-declared-config-patch.json";

export function stagedFileName(dryRun: boolean): string {
  return dryRun ? `clawwright-declared-config-patch.dry-${randomBytes(4).toString("hex")}.json` : stagedName;
}

export function declarationExistsRefusal(path: string): string {
  return `${path} already exists — pass --force to overwrite it with recovered values`;
}

export function missingLiveConfigRefusal(dataDir: string): string {
  return `${dataDir}/config/openclaw.json not found on the target — nothing to recover from`;
}

export const RECOVERED_VALUES_NOTE =
  "recovered values are what the live config holds now, not the original declaration — a value OpenClaw defaults to is indistinguishable from a declared one once the declaration is gone";

// The headline for a real apply. Callers that restart immediately suppress restart advice.
/** The advice a headline carries when the caller does not restart the gateway itself. */
export const RESTART_ADVICE = "restart to pick it up";

export function appliedHeadline(restartAdvice: boolean): string {
  return restartAdvice
    // Not `clawwright up`: a healthy container already converges on `up`, reporting success
    // while leaving the old settings live.
    ? `desired state applied — ${RESTART_ADVICE}: ${commandLine("restart")}`
    : "desired state applied";
}

/** Which flags mean anything is decided from the mode here, not branch order: order alone
 *  would let --dry-run --dump --force reach the dump branch. The cross-flag refusals are the
 *  declaration's rules now — the parser refuses them before any phase runs, on every host. */
const DUMP_LOCK_REASON = "a dump takes no instance lock, so there is no lock to break";
const DRY_RUN_LOCK_REASON = "a dry run takes no instance lock, so there is no lock to break";

function applyConfigPlan(call: ParsedCall<Record<string, unknown>>): ConfigPlan {
  const values = call.values as {
    "dry-run"?: boolean; dump?: boolean; force?: boolean;
    "break-lock"?: boolean; "break-foreign-lock"?: string; json?: boolean;
  };
  return {
    dryRun: values["dry-run"] === true,
    dump: values.dump === true,
    force: values.force === true,
    jsonOnly: values.json === true,
    takeover: { breakLock: values["break-lock"] === true, breakForeignLockHost: values["break-foreign-lock"] },
  };
}

interface ConfigPlan {
  readonly dryRun: boolean;
  readonly dump: boolean;
  readonly force: boolean;
  readonly jsonOnly: boolean;
  readonly takeover: { readonly breakLock: boolean; readonly breakForeignLockHost?: string };
}

export const APPLY_CONFIG = commandBody({
  effect: "change",
  arguments: APPLY_CONFIG_ARGUMENTS,
  rules: [
    { rule: "conflicts", name: "dry-run", with: ["dump"], reason: "a dump has no dry-run form: it writes the recovered declaration or it does nothing" },
    { rule: "conflicts", name: "dry-run", with: ["force"], reason: "--force only matters with --dump, which overwrites the recovered declaration; a dry run writes nothing" },
    { rule: "conflicts", name: "break-lock", with: ["dump"], reason: DUMP_LOCK_REASON },
    { rule: "conflicts", name: "break-foreign-lock", with: ["dump"], reason: DUMP_LOCK_REASON },
    { rule: "conflicts", name: "break-lock", with: ["dry-run"], reason: DRY_RUN_LOCK_REASON },
    { rule: "conflicts", name: "break-foreign-lock", with: ["dry-run"], reason: DRY_RUN_LOCK_REASON },
    { rule: "requires", name: "force", with: ["dump"], reason: "only applies to --dump — a real apply overwrites the instance config regardless, and its preview is --dry-run" },
  ],
  prepare: (call) => applyConfigPlan(call),
  run: (ctx, plan) => runApplyConfig(ctx, plan, true),
});

/** The full-context entry for callers inside other groups (bootstrap, smoke, set try, the
 *  apply step): the same declaration, parsed and run on a context they already hold. */
export async function applyConfig(
  ctx: Context,
  args: string[],
  options: { restartAdvice?: boolean } = {},
): Promise<void> {
  const call = parseCall(specShape(APPLY_CONFIG), args, "apply-config");
  return runApplyConfig(ctx, applyConfigPlan(call), options.restartAdvice ?? true);
}

async function runApplyConfig(ctx: Context, plan: ConfigPlan, restartAdvice: boolean): Promise<void> {
  const { dryRun, dump, force, jsonOnly, takeover } = plan;

  await requireBootstrapped(ctx);

  if (dump) {
    // Read-only against the target and the running container — the only write is the local
    // declaration file, so there is nothing for the instance lock to serialize.
    await dumpDesiredState(ctx, force, jsonOnly);
    return;
  }

  // A dry run changes no applied config, so it needs no lock. Its isolated staging file
  // is removed after the container reads it.
  if (dryRun) {
    const changed = await writeDesiredState(ctx, true, restartAdvice, false);
    if (jsonOnly) emit(`${JSON.stringify({ ok: true, changed, dryRun: true, source: desiredStateFile() }, null, 2)}\n`);
    return;
  }
  if (jsonOnly) {
    let caught: unknown;
    let outcome = false;
    try {
      outcome = await guardedWith(ctx, "apply-config", takeover, async () => {
        return await writeDesiredState(ctx, false, restartAdvice, false);
      });
    } catch (error) {
      caught = error;
    }
    if (caught !== undefined) {
      const message = caught instanceof Error ? caught.message : String(caught);
      emit(`${JSON.stringify({ ok: false, changed: false, source: desiredStateFile(), problems: [message] }, null, 2)}\n`);
      throw caught;
    }
    emit(`${JSON.stringify({ ok: true, changed: outcome, source: desiredStateFile() }, null, 2)}\n`);
    return;
  }
  return guardedWith(ctx, "apply-config", takeover, () => writeDesiredState(ctx, false, restartAdvice, false)).then(() => undefined);
}

async function writeDesiredState(ctx: Context, dryRun: boolean, restartAdvice = true, jsonOnly = false): Promise<boolean> {
  let payload: string;
  try { payload = await readFile(desiredStateFile(), "utf8"); }
  catch { die(`${desiredStateFile()} not found`); }

  let entries: { path: string; value: unknown }[];
  try { entries = JSON.parse(payload) as { path: string; value: unknown }[]; }
  catch (error) { die(`${desiredStateFile()} is not valid JSON: ${(error as Error).message}`); }
  const shapeError = desiredStateShapeError(entries);
  if (shapeError !== undefined) die(`${desiredStateFile()}: ${shapeError}`);
  refuseUnenrolledSSJackReferences(entries);
  for (const entry of entries) configPathParts(entry.path);

  let owners: readonly RecipePathOwner[];
  try { owners = await recipePathOwners(); }
  catch (error) { die(`recipe config ownership could not be read: ${(error as Error).message}`); }
  for (const entry of entries) {
    const owner = conflictingDeclaredPath(owners, entry.path);
    if (owner !== undefined) die(declaredOwnershipConflictDetail(entry.path, owner));
  }
  const filtered = filterOwnedDeclarations(entries, owners);
  if (filtered.dropped > 0) {
    if (filtered.kept.length === 0) die("every declared config path is owned by a recipe — nothing to apply");
    log(`skipping ${filtered.dropped} path(s) owned by recipes`);
  }

  // A real writer must establish that the record is safe to replace before any staged file
  // or OpenClaw run. Dry runs intentionally treat damaged records as empty.
  const previousRecord = dryRun ? await readDeclaredConfig(ctx) : await readDeclaredConfigStrict(ctx);
  const liveValue = await readLiveConfigOrThrow(ctx);
  let live: Record<string, unknown>;
  if (liveValue === undefined) live = {};
  else if (liveValue === null || typeof liveValue !== "object" || Array.isArray(liveValue)) die("live OpenClaw config is present but is not an object");
  else live = structuredClone(liveValue) as Record<string, unknown>;

  const declaredPaths = new Set(filtered.kept.map((entry) => entry.path));
  for (const old of previousRecord.entries.filter((entry) => !declaredPaths.has(entry.path))) {
    const owner = conflictingDeclaredPath(owners, old.path);
    if (owner !== undefined) die(declaredOwnershipConflictDetail(old.path, owner));
  }
  const resolved = desiredConfig(live, filtered.kept, previousRecord.entries);
  const patch = resolved.patch;
  if (patch === undefined) {
    if (!dryRun) await writeDeclaredConfig(ctx, filtered.kept);
    if (jsonOnly) emit(`${JSON.stringify({ ok: true, changed: false, dryRun, source: desiredStateFile(), message: "already matches" }, null, 2)}\n`);
    else log("already matches");
    return false;
  }

  const fileName = stagedFileName(dryRun);
  const stagedOnTarget = `${ctx.settings.dataDir}/config/${fileName}`;
  const stagedInContainer = ctx.paths.toContainer(stagedOnTarget);
  const runArgs = ["config", "patch", "--file", stagedInContainer];
  if (dryRun) runArgs.push("--dry-run");
  try {
    log(`staging ${fileName} on the target`);
    await ctx.transport.writeFile(stagedOnTarget, JSON.stringify(patch));
    log(dryRun ? "applying desired state (dry run)" : "applying desired state");
    const result = await ctx.runtime.runOneOff("gateway", ["dist/index.js", ...runArgs], { noDeps: true, entrypoint: "node" });
    if (result.code !== 0) throw new Error(`OpenClaw config patch failed: ${(result.stderr || result.stdout).trim()}`);
  } finally {
    await ctx.transport.remove(stagedOnTarget);
  }
  if (!dryRun) await writeDeclaredConfig(ctx, filtered.kept);
  if (jsonOnly) {
    return !dryRun;
  }
  if (dryRun) log("dry run only — nothing was written");
  else { log(appliedHeadline(restartAdvice)); info(`source: ${desiredStateFile()}`); }
  return !dryRun;
}


/** The paths a dump attempts to recover: a fixed, small set this framework treats as
 *  commonly declared. The live config can't say which values were declared vs. OpenClaw's
 *  own defaults, so anything outside this list is not attempted. First two are what a
 *  fresh deployment's scaffold seeds; the third is the model default a declaration usually
 *  carries. */
const RECOVERABLE_PATHS = [
  "gateway.mode",
  "gateway.bind",
  "agents.defaults.model.primary",
];

/** The reverse of the real apply: reconstructs config/desired-state.json from a live
 *  instance's own openclaw.json, for when the operator's copy was lost while the instance
 *  kept running.
 *
 *  Explicit limit, reported not hidden: the live config shows the OUTCOME of applying the
 *  declaration, not the declaration itself, so only RECOVERABLE_PATHS is attempted; a path
 *  the live config never set is omitted rather than guessed, and recipes aren't attempted
 *  since desired-state.json has no way to declare a recipe list.
 *
 *  readLiveConfigOrThrow(), not a degrade-to-undefined read: this is about to WRITE the
 *  recovered declaration, so a failed-but-existing live config must abort rather than
 *  silently produce an empty one — same reasoning secrets --apply uses through this helper. */
async function dumpDesiredState(ctx: Context, force: boolean, jsonOnly = false): Promise<void> {
  const path = desiredStateFile();

  const exists = await access(path).then(
    () => true,
    () => false,
  );
  if (exists && !force) {
    die(declarationExistsRefusal(path));
  }

  const live = await readLiveConfigOrThrow(ctx);
  if (live === undefined) {
    die(missingLiveConfigRefusal(ctx.settings.dataDir));
  }

  const recovered: { path: string; value: unknown }[] = [];
  const omitted: string[] = [];
  for (const declaredPath of RECOVERABLE_PATHS) {
    const value = valueAt(live, declaredPath);
    if (value === undefined) omitted.push(declaredPath);
    else recovered.push({ path: declaredPath, value });
  }

  // RECOVERABLE_PATHS are ordinary config paths, so a recipe's owns COULD name one — the
  // "none of which a recipe can own" assumption is not structural. Refuse rather than write
  // a declaration the next apply would refuse back.
  try {
    await refuseDeclaredOwnedPaths(recovered);
  } catch (error) {
    die(`recovered declaration conflicts with recipe ownership: ${(error as Error).message}`);
  }

  await writeFile(path, `${JSON.stringify(recovered, null, 2)}\n`, "utf8");

  if (jsonOnly) {
    emit(`${JSON.stringify({ ok: true, changed: true, path, recovered: recovered.map((entry) => entry.path), omitted }, null, 2)}\n`);
    return;
  }
  log(`recovered ${recovered.length} of ${RECOVERABLE_PATHS.length} known path(s) into ${path}`);
  for (const declaredPath of omitted) info(`${declaredPath} has no value in the live config — omitted, not guessed`);
  if (recovered.length === 0) warn("nothing was recoverable — the file was written as an empty declaration");
  info(RECOVERED_VALUES_NOTE);
  info("recipes are not part of desired-state.json, so there is nothing to recover them into");
}
