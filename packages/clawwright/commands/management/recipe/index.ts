// `clawwright recipe` — deploying third-party services next to the instance.
//
// Each recipe runs as its own compose project, so nothing here can disturb the gateway.
// Building happens on the target: a Rust or Go build from scratch takes minutes, and the
// output is streamed rather than swallowed — silent waiting looks like a hang.
//
// The body lives here; the action runs live in actions.ts. Actions are declared in
// RECIPE_ACTION_GRAMMAR's order (list first, the default), so the word's choices read the
// same order the usage message always named.

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import * as kinds from "#src/core/values/kinds.ts";
import {
  defineAction,
  multiActionBody,
  runOnContext,
} from "#src/core/command/index.ts";
import type { ArgumentSpec } from "#src/core/command/index.ts";
import type { Context } from "#src/core/context.ts";
import type { RecipeRef } from "#src/core/values/plan.ts";
import { log, info, warn } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import {
  listAgentBundleRecipes,
  listBrokenRecipes,
  listRecipeDirectories,
  listRecipes,
  loadRecipe,
  recipeStack,
  recipesDirectory,
  type Recipe,
} from "#src/service/recipe.ts";
import { guardedWith } from "#src/runtime/lock/instance-lock.ts";
import { JSON_ARGUMENT, NO_COLOR_ARGUMENT, SINCE_ARGUMENT } from "#src/commands/lifecycle/instance/logs.ts";
import { LOCK_TAKEOVER_ARGUMENTS, takeoverOf } from "#src/commands/interface/groups/shared-arguments.ts";
import { prepareRecipeCheck, runCheckAction } from "./recovery/checks/check.ts";
import {
  runDiagnoseAction,
  runImportAction,
  runInstallAction,
  runInstallDryRun,
  runLogsAction,
  runNewAction,
  runOnboardAction,
  runRemoveAction,
  runRemoveDryRun,
  runStatusAction,
  runVerifyAction,
} from "./actions.ts";
import { runInspectAction } from "./recovery/inspect.ts";
import { runTrialAction, runTrialDryRun } from "./recovery/trial/index.ts";
import { runRecoverAction } from "./recovery/recover.ts";
import { runMigrateAction } from "./recovery/migrate/index.ts";
import { resolveRetireLegacyEffectOf, runRetireLegacyAction } from "./recovery/retire.ts";
import { INVALID_MANIFEST } from "./run/lifecycle.ts";
import { prepareRecipeRun } from "./run/arguments.ts";
import { runRecipeActionCommand } from "./run/invocation.ts";
import { resolveRecipeActionEffectOf } from "./run/effect.ts";
import { resolveRecipePinEffectOf } from "./run/pin/effect.ts";
import { runRecipePin } from "./run/pin/invocation.ts";
import { readName } from "#src/core/values/names.ts";
import { importNameOf } from "./actions.ts";

function describe(recipe: Recipe): void {
  const state = recipe.enabled ? "" : "  [disabled]";
  info(`${recipe.name.padEnd(16)} ${recipe.description}${state}`);
  if (!recipe.enabled && recipe.disabledReason !== undefined) {
    info(`${"".padEnd(16)} ${recipe.disabledReason}`);
  }
  if (recipe.source !== undefined) info(`${"".padEnd(16)} source: ${recipe.source}`);
  for (const port of recipe.ports ?? []) {
    const suffix = port.description === undefined ? "" : ` (${port.description})`;
    info(`${"".padEnd(16)} port ${port.host} -> ${port.container}${suffix}`);
  }
}

/** `recipe list` (also the default action): the catalog of service recipes, agent/MCP
 *  bundles and broken manifests, as text or --json. */
async function runRecipeList(ctx: Context, jsonOnly: boolean): Promise<void> {
  const recipes = await listRecipes();
  // A recipe directory can also be an agent/MCP bundle — no recipe.json, so listRecipes
  // drops it; shown here so "no recipes yet" doesn't contradict what inspect reports.
  const bundles = await listAgentBundleRecipes();
  // A recipe.json that exists but fails to load. listRecipes() drops these so one broken
  // manifest can't take the working recipes down; this gives it a visible catalog entry.
  const broken = await listBrokenRecipes();

  if (jsonOnly || isCaptured()) {
    emit(
      `${JSON.stringify(
        {
          recipes: recipes.map((entry) => ({
            name: entry.name,
            description: entry.description,
            enabled: entry.enabled,
            disabledReason: entry.disabledReason ?? null,
            source: entry.source ?? null,
            ports: (entry.ports ?? []).map((port) => ({
              host: port.host,
              container: port.container,
              description: port.description ?? null,
            })),
          })),
          bundles,
          broken: broken.map((entry) => ({ name: entry.name, error: entry.error })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (recipes.length === 0 && bundles.length === 0 && broken.length === 0) {
    info("no recipes yet — add one under recipes/<name>/");
    return;
  }
  if (recipes.length === 0 && broken.length === 0) {
    info("no service recipes yet — `recipe install` needs a recipes/<name>/recipe.json");
  } else if (recipes.length > 0) {
    log("available recipes");
    for (const entry of recipes) describe(entry);
    info("");
    info(`install with: ${commandLine(["recipe", "install", "<name>"])}`);
  }
  for (const name of bundles) {
    info(`${name.padEnd(16)} agent/MCP bundle — not installable; visible with ${commandLine("inspect")}, provisioned with ${commandLine("provision-agent")}`);
  }
  for (const entry of broken) {
    warn(`${entry.name.padEnd(16)} broken recipe.json: ${entry.error}`);
  }
}


export { importHookModule } from "./hook-runtime.ts";

/** The action a bare `recipe` runs. */
const RECIPE_DEFAULT_ACTION = "list";

const NAME_ARGUMENT = {
  summary: "recipe",
  name: "name",
  description: "Recipe name",
  kind: "positional",
  required: true,
  value: kinds.recipeRef(),
} as const satisfies ArgumentSpec;

/** The storage actions (recover, migrate, retire-legacy) keep their own lock wording: one wording
 *  across every recipe action would print the whole 11-action scope list after it in the MCP
 *  schema, past the 60-character bound view.check.ts holds every emitted text to. */
const STORAGE_LOCK_ARGUMENTS = LOCK_TAKEOVER_ARGUMENTS.map((argument) => ({ ...argument, summary: argument.name === "break-lock" ? "Take over the instance lock" : "Remote lock owner's host id" }));

/** new mints the name it will create: the creator grammar (Windows device names included),
 *  refused at parse. Every other action addresses an existing recipe — the reader grammar. */
const NEW_NAME_ARGUMENT = {
  ...NAME_ARGUMENT,
  value: kinds.name("recipe", "create"),
} as const satisfies ArgumentSpec;

/** import copies a source directory, not a recipe name: any path is the source, and only the
 * name it lands under (new-name, else the last segment of the source) is held to the grammar. */
const SOURCE_ARGUMENT = {
  summary: "Source directory",
  name: "name",
  description: "Directory to copy the recipe from",
  kind: "positional",
  required: true,
  value: kinds.localDirectory("Source directory", "recipes/local"),
} as const satisfies ArgumentSpec;


const TAIL_ARGUMENT = {
  name: "tail",
  summary: "Lines per service",
  description: "With logs/diagnose/inspect: lines to return per service",
  kind: "option",
  valueName: "n",
  value: kinds.count("a number of lines"),
} as const satisfies ArgumentSpec;

const DRY_RUN_ARGUMENT = {
  name: "dry-run",
  summary: "what would happen",
  description: "With install/remove: show what would happen",
  kind: "flag",
  effect: "read",
} as const satisfies ArgumentSpec;

/** The command body; recipe(ctx, args) stays for callers that already hold a Context. */
export const RECIPE = multiActionBody({
  effect: "destroy",
  action: { description: "Recipe action" },
  defaultAction: RECIPE_DEFAULT_ACTION,
  actions: {
    list: defineAction({
      summary: "List recipes, bundles and broken manifests",
      effect: "read",
      arguments: [
        {
          name: "json",
          summary: "Catalog as JSON",
          description: "With list: emit the catalog (recipes, agent/MCP bundles, broken manifests) as JSON",
          kind: "flag",
        },
      ],
      run: (ctx, values) => runRecipeList(ctx, values.json === true),
    }),
    import: defineAction({
      summary: "Copy a recipe directory into recipes/",
      // Q1: the action only adds files under recipes/ — `change`, so MCP asks no confirm —
      // and Q8/needs: "local": it runs with no Context, no .env parse and no transport.
      effect: "change",
      needs: "local",
      arguments: [SOURCE_ARGUMENT, {
        name: "new-name",
        summary: "Name to import under",
        description: "With import: import under this name instead of the source directory's own name",
        kind: "positional",
        value: kinds.name("recipe", "create"),
      }],
      // Repository-side only: no target, no lock — either works before bootstrap has
      // prepared the lock home. The name it lands under is minted here, refused before
      // any context is built, in the binder's own voice.
      prepare: async (call, local) => {
        // The source directory arrives resolved (the kind's own recipe.json proof, S2.5);
        // the name it lands under has no resolve — it is minted here, refused before any
        // context is built, in the binder's own voice.
        const source = call.values.name;
        const name = await call.derive("name", kinds.name("recipe", "create"), importNameOf(call.values.name.path, call.values["new-name"]));
        const destination = resolve(recipesDirectory(), name);
        if (await local.exists(destination)) {
          call.refuse("name", `recipe "${name}" already exists at ${destination}`);
        }
        return { source, name };
      },
      run: (_ctx, plan) => runImportAction(plan.source, plan.name),
    }),
    new: defineAction({
      summary: "Scaffold a recipes/<name>/ skeleton",
      // Q1 + Q8, as import: repository-side only, so `change` and `needs: "local"`.
      effect: "change",
      needs: "local",
      arguments: [NEW_NAME_ARGUMENT, {
        name: "with-hooks",
        summary: "Add hook stubs",
        description: "With new: add commented prepare.ts/verify.ts stubs",
        kind: "flag",
      }],
      // Repository-side only, like import: the name is minted at parse and the destination
      // existence is judged here, before any context is built.
      prepare: async (call, local) => {
        const name = call.values.name;
        const destination = resolve(recipesDirectory(), name);
        if (await local.exists(destination)) {
          call.refuse("name", `recipe "${name}" already exists at ${destination}`);
        }
        return { name, withHooks: call.values["with-hooks"] === true };
      },
      run: (_ctx, plan) => runNewAction(plan.name, plan.withHooks),
    }),
    check: defineAction({
      summary: "Run untrusted local checks; no instance/Docker/lock",
      effect: "destroy",
      needs: "local",
      arguments: [{
        ...NAME_ARGUMENT,
        summary: "recipe whose checks you trust",
        description: "Recipe whose *.check.ts files to run — they run with your rights, not sandboxed",
      }, {
        ...DRY_RUN_ARGUMENT,
        description: "With check: list files without executing recipe code",
      }],
      prepare: (call) => prepareRecipeCheck(call.values.name, call.values["dry-run"] === true),
      run: (_local, plan) => runCheckAction(plan),
    }),
    verify: defineAction({
      summary: "Run the recipe's verify.ts hook",
      arguments: [NAME_ARGUMENT, ...LOCK_TAKEOVER_ARGUMENTS],
      run: (ctx, values) => runLocked(ctx, "verify", values, () => runVerifyAction(ctx, values.name)),
    }),
    onboard: defineAction({
      summary: "Run the recipe's onboard.ts hook",
      arguments: [NAME_ARGUMENT, ...LOCK_TAKEOVER_ARGUMENTS],
      run: (ctx, values) => runLocked(ctx, "onboard", values, () => runOnboardAction(ctx, values.name)),
    }),
    diagnose: defineAction({
      summary: "Bundle stack, logs and verify hook into a report",
      arguments: [NAME_ARGUMENT, TAIL_ARGUMENT, ...LOCK_TAKEOVER_ARGUMENTS],
      run: (ctx, values) => runLocked(ctx, "diagnose", values, () => runDiagnoseAction(ctx, values.name, values.tail)),
    }),
    install: defineAction({
      summary: "Build a recipe from source and start it",
      arguments: [NAME_ARGUMENT, {
        name: "force-disabled",
        summary: "Build a disabled recipe",
        description: "With install: build a recipe marked disabled",
        kind: "flag",
      }, DRY_RUN_ARGUMENT, ...LOCK_TAKEOVER_ARGUMENTS,],
      run: (ctx, values) => runLocked(ctx, "install", values, () => {
        const name = values.name;
        return values["dry-run"] === true
          ? runInstallDryRun(ctx, name, values["force-disabled"] === true)
          : runInstallAction(ctx, name, values["force-disabled"] === true);
      }, values["dry-run"] !== true),
    }),
    trial: defineAction({
      summary: "Build and run a recipe against a copy of its data (no hooks run)",
      arguments: [NAME_ARGUMENT, {
        ...DRY_RUN_ARGUMENT,
        description: "With trial: show what would be copied, the project name and the override",
      }, ...LOCK_TAKEOVER_ARGUMENTS],
      run: (ctx, values) => runLocked(ctx, "trial", values, () => values["dry-run"] === true ? runTrialDryRun(ctx, values.name) : runTrialAction(ctx, values.name), values["dry-run"] !== true),
    }),
    remove: defineAction({
      summary: "Stop and remove a recipe's stack",
      arguments: [NAME_ARGUMENT, {
        name: "volumes",
        summary: "Delete volumes too",
        description: "With remove: delete its volumes too",
        kind: "flag",
      }, DRY_RUN_ARGUMENT, ...LOCK_TAKEOVER_ARGUMENTS,],
      run: (ctx, values) => runLocked(ctx, "remove", values, () => {
        const name = values.name;
        return values["dry-run"] === true
          ? runRemoveDryRun(ctx, name, values.volumes === true)
          : runRemoveAction(ctx, name, values.volumes === true);
      }, values["dry-run"] !== true),
    }),
    inspect: defineAction({
      summary: "Inspect recipe containers without locks or hooks",
      effect: "read",
      arguments: [NAME_ARGUMENT, TAIL_ARGUMENT, {
        name: "json",
        summary: "Inspect as JSON",
        description: "With inspect: emit inspection evidence as JSON",
        kind: "flag",
      }],
      run: (ctx, values) => runInspectAction(ctx, values.name, values.tail, values.json === true),
    }),
    recover: defineAction({
      summary: "Recreate exactly one recipe service",
      effect: "destroy",
      arguments: [NAME_ARGUMENT, {
        name: "service",
        summary: "Service to recover",
        description: "With recover: exact declared service (dependencies are not started)",
        kind: "option",
        valueName: "service",
        required: true,
        value: kinds.text("a service name"),
      }, {
        name: "build", summary: "Build the service", description: "With recover: build the selected service", kind: "flag",
      }, {
        name: "pull", summary: "Pull the image", description: "With recover: pull the selected service image", kind: "flag",
      }, {
        ...DRY_RUN_ARGUMENT, description: "With recover: preview without locks or hooks",
      }, {
        name: "reconcile-consumer",
        summary: "Run afterStart hooks",
        description: "May mutate consumer configuration and the gateway through afterStart",
        kind: "flag",
      }, ...STORAGE_LOCK_ARGUMENTS],
      prepare: async (call) => ({
        name: call.values.name,
        options: {
          service: call.values.service,
          build: call.values.build === true,
          pull: call.values.pull === true,
          dryRun: call.values["dry-run"] === true,
          reconcileConsumer: call.values["reconcile-consumer"] === true,
        },
        takeover: takeoverOf(call.values),
      }),
      run: (ctx, plan) => runRecoverAction(ctx, plan.name, plan.options, plan.takeover),
    }),
    migrate: defineAction({
      summary: "Migrate a proven owned legacy recipe stack with retained backups",
      effect: "destroy",
      arguments: [NAME_ARGUMENT, {
        ...DRY_RUN_ARGUMENT, description: "With migrate: preview without locks, hooks or target writes",
      }, {
        name: "helper-image", summary: "Local helper image ID", description: "Trusted local sha256 image ID for storage tools; never built or pulled",
        kind: "option", valueName: "sha256", value: kinds.text("an immutable local image ID"),
      }, {
        name: "shutdown-timeout", summary: "Shutdown grace (seconds)", description: "Finite 1..3600 seconds, default 180; never escalates to forced kill",
        kind: "option", valueName: "seconds", value: kinds.text("finite shutdown seconds"),
      }, ...STORAGE_LOCK_ARGUMENTS],
      prepare: async (call) => ({
        name: call.values.name,
        dryRun: call.values["dry-run"] === true,
        options: { helperImage: call.values["helper-image"],
          shutdownTimeoutSeconds: call.values["shutdown-timeout"] === undefined ? undefined : Number(call.values["shutdown-timeout"]) },
        takeover: takeoverOf(call.values),
      }),
      run: (ctx, plan) => runMigrateAction(ctx, plan.name, plan.dryRun, plan.takeover, plan.options),
    }),
    "retire-legacy": defineAction({
      summary: "Retire a proven owned legacy stack: cold backup, remove containers only",
      effect: "destroy",
      effectOf: resolveRetireLegacyEffectOf,
      arguments: [NAME_ARGUMENT, {
        name: "apply", summary: "Run the retirement", description: "With retire-legacy: stop, back up and remove the legacy containers; previews by default",
        kind: "flag",
      }, {
        name: "helper-image", summary: "Local helper image ID", description: "Trusted local sha256 image ID for storage tools; never built or pulled",
        kind: "option", valueName: "sha256", value: kinds.text("an immutable local image ID"),
      }, {
        name: "shutdown-timeout", summary: "Shutdown grace (seconds)", description: "Finite 1..3600 seconds, default 180; never escalates to forced kill",
        kind: "option", valueName: "seconds", value: kinds.text("finite shutdown seconds"),
      }, ...STORAGE_LOCK_ARGUMENTS],
      prepare: async (call) => ({
        name: call.values.name,
        apply: call.values.apply === true,
        options: { helperImage: call.values["helper-image"],
          shutdownTimeoutSeconds: call.values["shutdown-timeout"] === undefined ? undefined : Number(call.values["shutdown-timeout"]) },
        takeover: takeoverOf(call.values),
      }),
      run: (ctx, plan) => runRetireLegacyAction(ctx, plan.name, plan.apply, plan.takeover, plan.options),
    }),
    status: defineAction({
      summary: "Show the recipe stack's compose status",
      effect: "read",
      arguments: [NAME_ARGUMENT],
      run: (ctx, values) => runStatusAction(ctx, values.name),
    }),
    logs: defineAction({
      summary: "Read a recipe stack's logs",
      effect: "read",
      arguments: [NAME_ARGUMENT, TAIL_ARGUMENT, SINCE_ARGUMENT, NO_COLOR_ARGUMENT, JSON_ARGUMENT],
      run: (ctx, values) => runLogsAction(ctx, values.name, values.tail, values.since, values["no-color"] === true, values.json === true),
    }),
    pin: defineAction({
      summary: "Update a recipe Dockerfile artifact version and checksum",
      effect: "change",
      effectOf: resolveRecipePinEffectOf,
      arguments: [NAME_ARGUMENT, {
        name: "version", summary: "Artifact version", description: "With pin: new plain-token release version", kind: "option", valueName: "version", required: true, value: kinds.text("a plain version token"),
      }, {
        name: "artifact", summary: "Artifact basename", description: "With pin: select a declaration by its expanded asset basename (version placeholders use the current version)", kind: "option", valueName: "basename", value: kinds.text("an artifact basename"),
      }, {
        name: "apply", summary: "Write the pin", description: "With pin: confirm and atomically update the Dockerfile", kind: "flag",
      }, ...LOCK_TAKEOVER_ARGUMENTS],
      run: (ctx, values) => runRecipePin(ctx, { name: values.name, version: values.version!, artifact: values.artifact, apply: values.apply === true, takeover: takeoverOf(values) }),
    }),
    run: defineAction({
      summary: "Run a recipe-declared action from its manifest",
      // Static strongest; resolveRecipeActionEffectOf lowers per call (the declared action's
      // effect, read under --dry-run) and change/destroy owe an MCP confirmation.
      effect: "destroy",
      effectOf: resolveRecipeActionEffectOf,
      arguments: [NAME_ARGUMENT, {
        name: "recipe-action",
        summary: "Recipe action",
        description: "With run: the action declared in the recipe's manifest (recipe inspect lists them)",
        kind: "positional",
        required: true,
        value: kinds.text("a recipe action name"),
      }, {
        ...DRY_RUN_ARGUMENT,
        description: "With run: pass dryRun to the action; treated as read-only",
      }, ...LOCK_TAKEOVER_ARGUMENTS, {
        name: "json",
        summary: "Run result as JSON",
        description: "With run: emit the action's result as JSON",
        kind: "flag",
      }, {
        // Variadic must be declared last (checkArguments), though its tokens may appear
        // anywhere in the argv after the positionals.
        name: "arg",
        summary: "Action argument",
        description: "With run: action argument as key=value",
        kind: "variadic",
        value: kinds.text("a key=value argument"),
      }],
      prepare: prepareRecipeRun,
      run: (ctx, plan) => runRecipeActionCommand(ctx, plan),
    }),
  },
});

/** install/remove --dry-run touch nothing on the target, reading as read-only the same way
 *  restore/deploy's own --dry-run does — so they skip the instance lock, exactly as the
 *  old readOnlyWhen said. Every other lifecycle action takes it. */
async function runLocked(
  ctx: Context,
  action: string,
  values: { readonly name: RecipeRef } & Parameters<typeof takeoverOf>[0],
  body: () => Promise<void>,
  gate = true,
): Promise<void> {
  const name = values.name;
  // The recipe's existence is the recipeRef kind's own prepare-stage resolve (S2.5): a
  // typo dies there, before the lock or any transport call — no re-validation here.
  if (!gate) return body();
  await guardedWith(ctx, `recipe ${action} ${name}`, takeoverOf(values), body);
}

export async function recipe(ctx: Context, args: string[]): Promise<void> {
  await runOnContext(RECIPE, ctx, args);
}

/** Installed recipes whose Compose stacks are currently running. A failed runtime probe
 *  propagates, since backup/restore can't claim consistency without its answer. A broken
 *  manifest is tolerated only when its stack is proven stopped. */
export async function runningRecipeStacks(ctx: Context): Promise<Recipe[]> {
  const running: Recipe[] = [];
  const entries = (await listRecipeDirectories(recipesDirectory())).filter((candidate) => candidate.isDirectory());

  for (const entry of entries) {
    const directory = resolve(recipesDirectory(), entry.name);
    try {
      await access(resolve(directory, "recipe.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    let recipe: Recipe;
    try {
      recipe = await loadRecipe(readName("recipe", entry.name));
    } catch (error) {
      // A broken declaration can't supply hooks, but its directory still names the compose
      // project — fail closed before backup archives it unsafely if that project is live.
      const stack = recipeStack(ctx, entry.name, resolve(directory, "compose.yml"));
      if (await stack.isRunning()) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`running recipe "${entry.name}" ${INVALID_MANIFEST}; backup cannot confirm it is quiesced: ${detail}`);
      }
      continue;
    }

    const stack = recipeStack(ctx, recipe.name, recipe.definitionPath);
    if (await stack.isRunning()) running.push(recipe);
  }
  return running;
}
