// Implementations of the individual `clawwright recipe <action>` actions. index.ts's
// recipe() picks the action, gates it through the instance lock, then calls runRecipeAction
// here to dispatch to one of these.

import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { log, info, warn, die } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { docsUrl } from "#src/core/io/docs-url.ts";
import type { Context } from "#src/core/context.ts";
import {
  loadRecipe,
  recipeStack,
  recipesDirectory,
  type Recipe,
} from "#src/service/recipe.ts";
import { collectPortableRecipeFiles } from "#src/security/privacy/recipe-portable-content.ts";
import type { RecipeName } from "#src/core/values/names.ts";
import type { LocalRecipeSource, RecipeRef } from "#src/core/values/plan.ts";

/** A recipe proven to exist: the reader grammar's name for actions that mint one (`new`),
 *  the pipeline-resolved RecipeRef for every action that addresses an existing recipe
 *  (S2.5). Both are string brands, so the runs need no cast. */
type ExistingRecipe = RecipeName | RecipeRef;
import { waitForRecipeReadiness, DEFAULT_READINESS_GRACE_MS, DEFAULT_DECLARED_READINESS_TIMEOUT_MS } from "./recovery/readiness.ts";
import { isCaptured, shouldFollow, emit, emitRaw, withOutputSink } from "#src/core/io/output.ts";
import { ansiStripSink } from "#src/commands/lifecycle/instance/logs.ts";
import { jsonLogLines } from "#src/runtime/runtime.ts";
import { stripAnsi } from "#src/runtime/docker/compose-operations.ts";
import { importHookModule } from "./hook-runtime.ts";

/** The readiness actions read and print; everything else is a lifecycle change. Kept beside
 *  the runs so the gate (the body's per-action effects) and the runs cannot drift apart.
 *  verify is deliberately not among them: it runs with the same Context prepare.ts gets,
 *  which may mutate the target, so the framework can't know a given hook is read-only. */

async function stackFor(ctx: Context, name: ExistingRecipe) {
  const recipe = await loadRecipe(name);
  return { recipe, stack: recipeStack(ctx, name, recipe.definitionPath) };
}

/** Loads app-owned hooks without teaching the framework what the recipe means. */
async function loadRecipeHooks(spec: Recipe): Promise<Record<string, unknown>> {
  if (spec.preparePath === undefined) return {};
  return importHookModule(spec.preparePath);
}

async function prepareRecipe(ctx: Context, spec: Recipe): Promise<Record<string, unknown>> {
  const loaded = await loadRecipeHooks(spec);
  const prepare = loaded.prepare ?? loaded.default;
  if (spec.preparePath !== undefined && typeof prepare !== "function") {
    die(`recipe "${spec.name}" prepare.ts must export prepare(ctx, recipe)`);
  }
  if (typeof prepare === "function") await prepare(ctx, spec);
  return loaded;
}

/** Loads and runs one of the recipe's own hooks, returning its JSON payload rather than
 *  printing it — what runRecipeHook and diagnose's verify probe both need, without
 *  diagnose inheriting runRecipeHook's die()-on-failure. */
async function loadHookResult(ctx: Context, spec: Recipe, kind: "verify" | "onboard"): Promise<unknown> {
  const path = kind === "verify" ? spec.verifyPath : spec.onboardPath;
  if (path === undefined) throw new Error(`recipe "${spec.name}" has no ${kind}.ts hook`);
  const loaded = await importHookModule(path);
  const hook = loaded[kind] ?? loaded.default;
  if (typeof hook !== "function") throw new Error(`recipe "${spec.name}" ${kind}.ts must export ${kind}(ctx, recipe)`);
  const result = await hook(ctx, spec);
  return result === undefined ? { ok: true } : result;
}

async function runRecipeHook(ctx: Context, spec: Recipe, kind: "verify" | "onboard"): Promise<void> {
  let payload: unknown;
  try {
    payload = await loadHookResult(ctx, spec, kind);
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
  if (isCaptured()) emit(`${JSON.stringify(payload)}\n`);
  else log(`${spec.name} ${kind}: ${JSON.stringify(payload)}`);
}

/** How many skipped entries the summary line names before falling back to "and N more" —
 *  enough to be useful, never so many the line drowns the rest of the output. */
const SKIPPED_SUMMARY_LIMIT = 8;

/** Hooks whose presence earns the operator-rights warning below. */
const RECIPE_HOOK_FILES = ["prepare.ts", "verify.ts", "onboard.ts"];

/** The name an import lands under: new-name when given, else the source's last segment. */
export function importNameOf(source: string, newName: string | undefined): string {
  return newName ?? basename(resolve(source));
}

export async function runImportAction(source: LocalRecipeSource, name: RecipeName): Promise<void> {
  // The source's recipe.json and the destination's absence are the prepare stage's own
  // facts (the kinds' resolve and the action's prepare) — run starts at the copy itself.
  const sourcePath = resolve(source.path);
  const importedName = name;
  const destination = resolve(recipesDirectory(), importedName);
  // Same symlink resolution and containment as set build and the provision-agent mirror
  // (security/recipe-portable-content.ts), so import can't copy a link the other two refuse.
  const { files, excluded } = await collectPortableRecipeFiles(sourcePath).catch((error: unknown) =>
    die(error instanceof Error ? error.message : String(error)),
  );
  for (const rel of files) {
    const target = resolve(destination, ...rel.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(sourcePath, ...rel.split("/")), target);
  }
  log(`imported recipe "${importedName}"`);
  info(`source: ${sourcePath}`);
  info(`destination: ${destination}`);
  if (excluded.length > 0) {
    const shown = excluded.slice(0, SKIPPED_SUMMARY_LIMIT).map((entry) => `${entry.path} (${entry.reason})`);
    const more = excluded.length > SKIPPED_SUMMARY_LIMIT ? `, and ${excluded.length - SKIPPED_SUMMARY_LIMIT} more` : "";
    info(`skipped: ${excluded.length} file(s) — ${shown.join(", ")}${more}`);
  }
  const hooks = RECIPE_HOOK_FILES.filter((hook) => files.includes(hook));
  if (hooks.length > 0) {
    warn(
      `${hooks.join(", ")} run on this machine with the operator's rights during bootstrap/up/recipe verify — read them before running.`,
    );
  }
}

/** compose.yml skeleton `recipe new` writes: one placeholder service, restart policy already
 *  right (docs/guide/recipes.md) — the operator fills in the real image/build. */
const NEW_RECIPE_COMPOSE = `# One compose project per recipe (${docsUrl("guide/recipes.md")}) — replace the placeholder
# image with a real service before \`recipe install\`.
services:
  app:
    image: replace-me
    restart: unless-stopped
`;

/** Note carried into both stub hooks — same wording as the warning \`recipe import\` prints
 *  when it finds a hook file, so the two say the same thing in the same words. */
const NEW_RECIPE_HOOK_NOTE = "Hooks run on this machine with the operator's rights during bootstrap/up/recipe verify.";

function newRecipePrepareStub(): string {
  return `// Runs before build and after start (afterStart). ${NEW_RECIPE_HOOK_NOTE}
//
// Uncomment to write private target files — see recipe.json's privatePaths and
// ${docsUrl("guide/recipes.md")} ("Private files: privatePaths and privateFiles").
//
// import { ensurePrivateTargetDirectory, replacePrivateTargetFile, generatePrivateSecret } from "@phpcraftdream/clawwright/private-config";
//
// export async function prepare(ctx, recipe) {
//   const dir = \`\${ctx.settings.dataDir}/\${recipe.name}-credentials\`;
//   await ensurePrivateTargetDirectory(ctx, dir);
//   await replacePrivateTargetFile(ctx, \`\${dir}/secret.env\`, \`SECRET=\${generatePrivateSecret()}\\n\`);
// }

export async function prepare(): Promise<void> {}
`;
}

function newRecipeVerifyStub(): string {
  return `// Runs on \`recipe verify\`/\`diagnose\`, gated like every mutation (confirm and the
// instance lock) — the framework cannot know what an app-owned hook touches.
// ${NEW_RECIPE_HOOK_NOTE}
//
// export async function verify(ctx, recipe) {
//   return { ok: true };
// }

export async function verify(): Promise<{ ok: boolean }> {
  return { ok: true };
}
`;
}

export async function runNewAction(name: RecipeName, withHooks: boolean): Promise<void> {
  // The name's grammar and the destination's absence are parse/prepare facts (S2.5).
  const destination = resolve(recipesDirectory(), name);
  await mkdir(destination, { recursive: true });
  await writeFile(resolve(destination, "recipe.json"), `${JSON.stringify({ description: `TODO: describe what ${name} deploys` }, null, 2)}\n`, "utf8");
  await writeFile(resolve(destination, "compose.yml"), NEW_RECIPE_COMPOSE, "utf8");
  if (withHooks) {
    await writeFile(resolve(destination, "prepare.ts"), newRecipePrepareStub(), "utf8");
    await writeFile(resolve(destination, "verify.ts"), newRecipeVerifyStub(), "utf8");
  }
  log(`created recipe "${name}"`);
  info(`directory: ${destination}`);
  info(`edit recipe.json and compose.yml, then: ${commandLine(["recipe", "install", name])}`);
  if (withHooks) info("prepare.ts and verify.ts are commented stubs — uncomment and edit before they run");
}

export async function runVerifyAction(ctx: Context, name: ExistingRecipe): Promise<void> {
  const { recipe: spec } = await stackFor(ctx, name);
  await runRecipeHook(ctx, spec, "verify");
}

export async function runOnboardAction(ctx: Context, name: ExistingRecipe): Promise<void> {
  const { recipe: spec } = await stackFor(ctx, name);
  await runRecipeHook(ctx, spec, "onboard");
}

export async function runDiagnoseAction(ctx: Context, name: ExistingRecipe, tail: number | undefined): Promise<void> {
  const { recipe: spec, stack } = await stackFor(ctx, name);
  const running = await stack.isRunning();
  // Every service in the recipe's compose project, not just one — a multi-container recipe
  // needs all of them in one place to correlate a failure that spans two.
  const logs = await stack.readLogs(tail === undefined ? "50" : String(tail));

  let verify: unknown;
  let verifyError: string | undefined;
  if (spec.verifyPath === undefined) {
    verifyError = "no verify.ts hook";
  } else {
    try {
      verify = await loadHookResult(ctx, spec, "verify");
    } catch (error) {
      verifyError = error instanceof Error ? error.message : String(error);
    }
  }

  const report = { recipe: name, enabled: spec.enabled, running, verify, verifyError, logs };
  if (isCaptured()) {
    emit(`${JSON.stringify(report)}\n`);
    return;
  }
  log(`${name} diagnose`);
  info(`enabled: ${spec.enabled}`);
  info(`running: ${running}`);
  if (verifyError !== undefined) warn(`verify: ${verifyError}`);
  else info(`verify: ${JSON.stringify(verify)}`);
  info("recent logs (every service in the recipe's own stack):");
  info(logs);
}

/** `--dry-run`: the same refusals a real install checks (disabled without --force-disabled,
 *  missing declared variables) plus whether the stack is already running — nothing is built,
 *  started or written. Does not cover: build output, compose's own readiness probing, or the
 *  prepare/afterStart hooks' side effects — those only run for a real install. */
export async function runInstallDryRun(ctx: Context, name: ExistingRecipe, forceDisabled: boolean): Promise<void> {
  const { recipe: spec, stack } = await stackFor(ctx, name);
  const refusals: string[] = [];

  if (!spec.enabled && !forceDisabled) {
    refusals.push(`recipe is disabled${spec.disabledReason === undefined ? "" : `: ${spec.disabledReason}`} — needs --force-disabled`);
  }
  const declared = Object.keys(spec.variables ?? {});
  const absent = declared.filter((variable) => (ctx.settings.env[variable] ?? "") === "");
  for (const variable of absent) refusals.push(`missing variable ${variable} — ${spec.variables?.[variable] ?? "required by the recipe"}`);

  const running = await stack.isRunning();
  const report = {
    ok: refusals.length === 0,
    changed: false,
    dryRun: true,
    recipe: spec.name,
    alreadyRunning: running,
    wouldBuild: true,
    ports: spec.ports ?? [],
    readiness: spec.readiness ?? null,
    refusals,
  };

  if (isCaptured()) {
    emit(`${JSON.stringify(report)}\n`);
    return;
  }
  log(`recipe install --dry-run: ${spec.name}`);
  info(`already running: ${running}`);
  info(spec.readiness === undefined
    ? "would build from source and start (implicit readiness check)"
    : `would build from source, start, and wait up to ${spec.readiness.timeoutMs ?? DEFAULT_DECLARED_READINESS_TIMEOUT_MS}ms for readiness`);
  for (const port of spec.ports ?? []) info(`port ${port.host} -> ${port.container}${port.description ? ` (${port.description})` : ""}`);
  if (refusals.length > 0) {
    for (const refusal of refusals) warn(refusal);
    die(`recipe install --dry-run found ${refusals.length} refusal(s) a real install would stop on`);
  }
  info("does not cover: build output, compose's own readiness probing, or the prepare/afterStart hooks' side effects");
}

/** `--dry-run`: whether the stack is running and what --volumes would additionally remove —
 *  nothing is stopped or removed. Does not cover whether the recipe's own containers hold
 *  state outside its declared compose volumes. */
export async function runRemoveDryRun(ctx: Context, name: ExistingRecipe, removeVolumes: boolean): Promise<void> {
  const { stack } = await stackFor(ctx, name);
  const running = await stack.isRunning();
  const report = { ok: true, changed: false, dryRun: true, recipe: name, running, wouldRemoveVolumes: removeVolumes };

  if (isCaptured()) {
    emit(`${JSON.stringify(report)}\n`);
    return;
  }
  log(`recipe remove --dry-run: ${name}`);
  info(`running: ${running}`);
  info(removeVolumes ? "would remove the stack and its volumes" : "would remove the stack (volumes kept — pass --volumes to include them)");
  info("does not cover: state the recipe's containers hold outside its declared compose volumes");
}

export async function runInstallAction(ctx: Context, name: ExistingRecipe, forceDisabled: boolean): Promise<void> {
  const { recipe: spec, stack } = await stackFor(ctx, name);

  // Kept in the repository but switched off: refuse rather than start an expensive
  // build nobody asked for. --force-disabled is the deliberate override.
  if (!spec.enabled && !forceDisabled) {
    warn(`recipe ${spec.name} is disabled`);
    if (spec.disabledReason !== undefined) info(spec.disabledReason);
    die(`install it anyway with: ${commandLine(["recipe", "install", spec.name, "--force-disabled"])}`);
  }

  // Declared variables must exist before the service starts: a container that starts and
  // then fails to configure itself is harder to diagnose than a refusal.
  const declared = Object.keys(spec.variables ?? {});
  const absent = declared.filter((variable) => (ctx.settings.env[variable] ?? "") === "");
  if (absent.length > 0) {
    for (const variable of absent) {
      warn(`${variable} is not set — ${spec.variables?.[variable] ?? "required by the recipe"}`);
    }
    die(`add the missing variable(s) to .env, then run this again`);
  }

  // Refuse ambiguous legacy or foreign stacks before app-owned prepare hooks can mutate.
  await stack.isRunning();

  const hooks = await prepareRecipe(ctx, spec);

  log(`building ${spec.name} (this compiles from source and can take minutes)`);
  await stack.build();
  log(`starting ${spec.name}`);
  const readinessTimeoutMs = spec.readiness === undefined
    ? DEFAULT_READINESS_GRACE_MS
    : spec.readiness.timeoutMs ?? DEFAULT_DECLARED_READINESS_TIMEOUT_MS;
  // --wait only when the recipe itself declared readiness: without a bound, a healthcheck
  // that never turns healthy would hang install on compose's own unbounded wait.
  await stack.up(
    spec.readiness !== undefined ? { wait: true, timeoutSeconds: Math.ceil(readinessTimeoutMs / 1000) } : undefined,
  );

  // Checked before afterStart, not the instant `up --detach` returns, which would report
  // "running" regardless of a container that crashes moments later.
  const readiness = await waitForRecipeReadiness(stack, spec.readiness, readinessTimeoutMs);
  const report = { recipe: spec.name, status: readiness.status, detail: readiness.detail, services: readiness.services };

  if (readiness.status !== "ready") {
    if (isCaptured()) emit(`${JSON.stringify(report)}\n`);
    warn(`${spec.name} started but is not ready (${readiness.status}): ${readiness.detail}`);
    info(`diagnose with: ${commandLine(["recipe", "diagnose", spec.name])}`);
    die(`recipe ${spec.name} did not reach a ready state — afterStart was skipped`);
  }

  if (typeof hooks.afterStart === "function") await hooks.afterStart(ctx, spec);

  if (isCaptured()) {
    emit(`${JSON.stringify(report)}\n`);
    return;
  }
  log(`${spec.name} is running`);
  for (const port of spec.ports ?? []) {
    info(`port ${port.host} -> ${port.container}${port.description ? ` (${port.description})` : ""}`);
  }
  info("it restarts automatically: restart policy unless-stopped");
}

export async function runRemoveAction(ctx: Context, name: ExistingRecipe, removeVolumes: boolean): Promise<void> {
  const { stack } = await stackFor(ctx, name);
  await stack.down(removeVolumes);
  log(`${name} removed${removeVolumes ? " (including volumes)" : ""}`);
}

export async function runStatusAction(ctx: Context, name: ExistingRecipe): Promise<void> {
  const { stack } = await stackFor(ctx, name);
  await stack.status();
  info((await stack.isRunning()) ? "running" : "not running");
}

export async function runLogsAction(ctx: Context, name: ExistingRecipe, tail: number | undefined, since?: string, noColor?: boolean, json?: boolean): Promise<void> {
  const { stack } = await stackFor(ctx, name);
  const rest = since === undefined ? [] : ["--since", since];
  if (noColor) rest.push("--no-color");
  // Following runs until interrupted, which only an attended terminal can do — and --json
  // needs one object per line, so it always forces a bounded read. Same choice as
  // instance/logs.ts's logs.
  if (!shouldFollow() || json) {
    const tailArg = tail === undefined ? "100" : String(tail);
    if (json) {
      const records = await stack.readLogRecords(tailArg, rest);
      const shaped = noColor ? records.map((record) => ({ ...record, text: stripAnsi(record.text) })) : records;
      // JSON.stringify drops undefined keys, so ts/service/stream appear only when known.
      emitRaw(jsonLogLines(shaped));
      return;
    }
    const output = await stack.readLogs(tailArg, rest);
    emitRaw(noColor ? stripAnsi(output) : output);
    return;
  }
  // --no-color on the followed stream also needs to strip codes the service embedded, which
  // compose's own --no-color cannot reach — same sink as instance/logs.ts's follow branch.
  if (noColor) {
    await withOutputSink(ansiStripSink(), () => stack.followLogs(rest));
    return;
  }
  await stack.followLogs(rest);
}
