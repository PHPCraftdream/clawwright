// Everything about a set that can be decided without a running instance.
//
// A coherence mistake caught here costs an edit; the same mistake caught during `apply`
// costs a half-changed instance and a rollback. Every question answerable from files alone
// is answered from files alone; what genuinely needs the instance is named as such.
//
// Deliberately NOT attempted: whether the pinned image's OpenClaw supports what the
// recipes use (needs the image; `apply` compares versions against the live instance); full
// cron semantics (rejects what is clearly not a schedule — "not rejected" is not "valid").
//
// S3.2: validation runs over the portable content model (set/content.ts) — pure, no global paths.

import { collectSecretRefs } from "#src/service/secrets.ts";
import { imagePinAdvice, recipeIncomplete, recipeMissingDir, recipeInvalidName } from "#src/set/advice.ts";
import { problem } from "#src/service/inspection.ts";
import type { Problem } from "#src/service/inspection.ts";
import type { SetManifest } from "#src/set/artifacts/model.ts";
import type { PortableContent } from "#src/set/content.ts";
import type { DeploymentLock } from "#src/commands/management/lock.ts";
import { hasDigest, invalidImageReference, tryParse } from "#src/runtime/docker/image-ref.ts";
import { safeName } from "#src/core/values/names.ts";
import { validateConfigDeclaration } from "#src/core/values/config/config-selectors.ts";


/** Deliberately shallow: `*`, `*\/N`, a number, a range, a list of those — rejects what is
 *  plainly not a schedule, passes everything that looks like one. Ranges aren't checked
 *  against each field's own bounds: the gateway is the real parser, and a second one here
 *  would eventually disagree with it. */
function cronFieldLooksValid(field: string): boolean {
  return field.split(",").every((part) => /^(\*|\d+)(-\d+)?(\/\d+)?$/.test(part));
}

/** The reason a cron expression is refused, or undefined when it is accepted. */

/** Fixed parts of the set-finding details, exported so checks assert the same text the
 *  product prints instead of restating it. */
export const INVALID_JSON_NOTE = "is not valid JSON";
export function addingFix(what: string, recipe: string): string {
  return `adding ${what} to recipes/${recipe}`;
}

export function cronProblem(expression: string): string | undefined {
  const fields = expression.trim().split(/\s+/).filter((field) => field !== "");
  if (fields.length !== 5) {
    return `expected five fields, got ${fields.length} (${JSON.stringify(expression)})`;
  }
  const bad = fields.filter((field) => !cronFieldLooksValid(field));
  return bad.length === 0 ? undefined : `field(s) ${bad.map((field) => JSON.stringify(field)).join(", ")} are not schedule terms`;
}

/** Why `value` is not a valid desired-state declaration, or undefined when it is — a list
 *  of { path, value } declarations that the framework resolves into an OpenClaw config patch.
 *  Exported so `set build` can refuse the same malformed declaration early, rather than
 *  only here or inside the container during an actual apply. */
export function desiredStateShapeError(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return "must be an array of { path, value } operations — got a single object instead of a list";
  }
  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return `entry ${index} is not an object`;
    }
    if (typeof (entry as { path?: unknown }).path !== "string" || (entry as { path: string }).path === "") {
      return `entry ${index} has no non-empty string "path"`;
    }
    if (!Object.hasOwn(entry, "value")) return `entry ${index} has no "value"`;
    try {
      validateConfigDeclaration((entry as { path: string }).path, (entry as { value: unknown }).value);
    } catch (error) {
      return `entry ${index} has an invalid declaration: ${(error as Error).message}`;
    }
  }
  return undefined;
}

/** The declaration as the model read it, for the secret references inside it. A missing or
 *  empty declaration is a finding, not a legitimate empty one: the tree validator must give
 *  the same answer an artifact carrying no declaration would (parity), and a deployment with
 *  no declaration at all must not read as coherent. Everything else unreadable is a finding
 *  too — checksum verification only proves an artifact's bytes match the manifest, never
 *  that they parse. The builder read the bytes; this only judges them. */
function declaredConfig(content: PortableContent, problems: Problem[]): readonly unknown[] {
  const declared = content.declaration;
  if (declared.readError !== undefined) {
    problems.push(
      problem("SET_DECLARATION_INVALID", declared.readError.missing
        ? `${declared.label} is missing or empty — a set without its config declaration would install an unconfigured instance`
        : `${declared.label} could not be read: ${declared.readError.message}`),
    );
    return [];
  }
  if (declared.empty) {
    problems.push(
      problem("SET_DECLARATION_INVALID", `${declared.label} is missing or empty — a set without its config declaration would install an unconfigured instance`),
    );
    return [];
  }
  if (declared.parseError !== undefined) {
    problems.push(
      problem("SET_DECLARATION_INVALID", `${declared.label} ${INVALID_JSON_NOTE}: ${declared.parseError}`),
    );
    return [];
  }
  if (declared.shapeError !== undefined) {
    problems.push(
      problem("SET_DECLARATION_INVALID", `${declared.label}: ${declared.shapeError}`),
    );
    return [];
  }
  // collectSecretRefs walks a config OBJECT; the declaration is a list of path/value
  // pairs, so the values are what it has to be shown. The model carried the parse.
  return declared.values ?? [];
}

/** The ONE grammar rule for recipe folder names, run by both load paths (validateSet runs
 *  for the tree and the artifact alike): a folder name must be a valid recipe name
 *  (names.ts's safeName), and the rejection is a SET_RECIPE_INVALID content finding — the
 *  same sentence build refuses the tree with. Exported for that refusal. */
export function recipeNameProblem(name: string): Problem | undefined {
  try {
    safeName("recipe", name);
    return undefined;
  } catch (error) {
    return recipeInvalidName(name, (error as Error).message);
  }
}

async function checkImagePinned(manifest: SetManifest, lock: DeploymentLock | undefined, problems: Problem[]): Promise<void> {
  // Grammar before pinning: only the image module's own parser decides what a reference is.
  if (tryParse(manifest.requires.image) === undefined) {
    problems.push(problem("SET_IMAGE_INVALID", invalidImageReference(manifest.requires.image)));
    return;
  }
  if (hasDigest(manifest.requires.image)) return;
  // One advice, shared with set build (set/advice.ts's imagePinAdvice): decided from the lock's
  // content, never from the file's existence — a committed lock travels in git, so it does
  // not imply a deployed instance.
  const advice = imagePinAdvice(manifest.requires.image, lock);
  problems.push(problem("SET_IMAGE_UNPINNED", advice.detail, advice.next));
}

/** The file checks run over the model's parsed content, never the disk. A packed artifact
 *  carries files as checksums — looking for those paths on this machine would flag a valid artifact. */
async function checkRecipesComplete(content: PortableContent, checkFiles: boolean, problems: Problem[]): Promise<void> {
  const manifest = content.manifest;
  for (const [name, recipe] of Object.entries(manifest.recipes)) {
    const declaresAgent = recipe.agent !== undefined;
    // The remedies are the advice owners in set/advice.ts — one wording per gap, shared
    // with set build and the checks.

    // The folder name itself, before anything reads through it: grammar first, on both
    // paths (build refuses the tree with the same sentence instead of packing a set every
    // consumer would report).
    const invalidName = recipeNameProblem(name);
    if (invalidName !== undefined) problems.push(invalidName);

    if (checkFiles) {
      const parsed = content.parsed.recipes[name];
      if (parsed === undefined || !parsed.dirExists) {
        // An unpacked artifact has a directory only where the manifest lists files in it.
        // A recipe that carries no portable content unpacks to nothing — and the tree it
        // was built from answers for that (the dir-exists branch below), so the artifact
        // must give the same answer, not a weaker one (R32-05: the tree reported three
        // blocking recipes, its own artifact one).
        if (declaresAgent || Object.keys(recipe.files).length > 0) {
          problems.push(recipeMissingDir(name, `recipe "${name}" is declared but ${parsed?.dir ?? name} does not exist`));
        } else {
          problems.push(recipeMissingDir(name, `recipe "${name}" is neither an MCP recipe (server.ts) nor a service (recipe.json)`));
        }
        continue;
      }
      // Completeness is judged by the manifest's portable inventory, never by what the disk
      // holds: a file kept private (recipe.json privateFiles) is on the tree but never in the
      // artifact, so the disk would answer differently on the two paths.
      const carried = (rel: string): boolean => manifest.files[`recipes/${name}/${rel}`] !== undefined;
      // server.ts is required only of a recipe that declares an agent — that's what makes
      // it an MCP recipe. A recipe without one is a plain service (its own compose stack,
      // recipe.json); demanding server.ts of it was a false positive against a real deployment.
      if (declaresAgent && !carried("server.ts")) {
        problems.push(recipeIncomplete(name, `recipe "${name}" declares an agent but has no server.ts — that is the file the gateway is registered to spawn`, addingFix("server.ts", name)));
      }
      if (!declaresAgent && !carried("recipe.json") && !carried("server.ts")) {
        problems.push(recipeMissingDir(name, `recipe "${name}" is neither an MCP recipe (server.ts) nor a service (recipe.json)`));
      }
      if (declaresAgent && !carried("agent/config.json")) {
        problems.push(recipeIncomplete(name, `recipe "${name}" declares an agent but has no agent/config.json`, addingFix("agent/config.json", name)));
      }
    }

    // A recipe serving nothing isn't provably a mistake (a plain service recipe is
    // legitimate), so only an empty checksum map WITH an agent bundle is reported.
    if (declaresAgent && Object.keys(recipe.files).length === 0) {
      problems.push(
        recipeIncomplete(name, `recipe "${name}" declares an agent but serves no content — the agent would have nothing to read`, `adding content to recipes/${name} and rebuilding`, "set build"),
      );
    }
  }
}

function checkReferencesResolve(manifest: SetManifest, problems: Problem[]): void {
  const declaredAgents = new Set(
    Object.values(manifest.recipes)
      .map((recipe) => recipe.agent?.agentId)
      .filter((id): id is string => id !== undefined),
  );
  const declaredServers = new Set(
    Object.values(manifest.recipes)
      .map((recipe) => recipe.agent?.mcpServerName)
      .filter((name): name is string => name !== undefined),
  );

  for (const [recipeName, checks] of Object.entries(manifest.acceptance)) {
    if (manifest.recipes[recipeName] === undefined) {
      problems.push(problem("SET_REFERENCE_BROKEN", `acceptance is declared for recipe "${recipeName}", which the set does not contain`));
      continue;
    }
    for (const check of checks) {
      const agent = typeof check.agent === "string" ? check.agent : undefined;
      if (agent !== undefined && !declaredAgents.has(agent)) {
        problems.push(
          problem("SET_REFERENCE_BROKEN", `recipe "${recipeName}": acceptance check ${JSON.stringify(check.name ?? check.kind)} names agent "${agent}", which no recipe in this set declares`),
        );
      }
      const server = typeof check.server === "string" ? check.server : undefined;
      if (server !== undefined && !declaredServers.has(server)) {
        problems.push(
          problem("SET_REFERENCE_BROKEN", `recipe "${recipeName}": acceptance check ${JSON.stringify(check.name ?? check.kind)} names MCP server "${server}", which no recipe in this set declares`),
        );
      }
    }
  }
}

function checkSchedulesValid(manifest: SetManifest, problems: Problem[]): void {
  for (const [name, recipe] of Object.entries(manifest.recipes)) {
    const schedule = recipe.agent?.cronSchedule;
    if (schedule === undefined) continue;
    const reason = cronProblem(schedule);
    if (reason !== undefined) {
      problems.push(problem("SET_SCHEDULE_INVALID", `recipe "${name}": ${reason}`));
    }
  }
}

/** The gateway resolves SecretRefs at startup and reports a missing one only in its log, as
 *  a crash loop. A set that references a variable it does not require is that failure,
 *  declared in advance. */
function checkSecretsDeclared(manifest: SetManifest, content: PortableContent, problems: Problem[]): void {
  const declaredSecrets = new Set(manifest.secrets);
  for (const ref of collectSecretRefs(declaredConfig(content, problems))) {
    if (!declaredSecrets.has(ref.name)) {
      problems.push(
        problem("SET_SECRET_UNDECLARED", `the declaration references ${ref.name} (${ref.usedBy}) but the set does not require it by name`),
      );
    }
  }
}

/** Every finding a set can produce without a gateway. Takes the portable content model
 *  built once per source (set/content.ts), rather than a directory: `set build` already
 *  collected the tree into one, and validating a built artifact must answer exactly as
 *  validating the tree it came from. Reads nothing from the filesystem and no global
 *  path — the load mode can never change which findings exist. The lock facts arrive as
 *  an explicit argument (read once at load); content problems travel as the model's
 *  diagnostics. */
export async function validateSet(content: PortableContent, options: { checkFiles?: boolean; lock?: DeploymentLock } = {}): Promise<Problem[]> {
  const manifest = content.manifest;
  const problems: Problem[] = [];
  await checkImagePinned(manifest, options.lock, problems);
  await checkRecipesComplete(content, options.checkFiles === true, problems);
  problems.push(...content.diagnostics.map((entry) => entry.problem));
  checkReferencesResolve(manifest, problems);
  checkSchedulesValid(manifest, problems);
  checkSecretsDeclared(manifest, content, problems);
  return problems;
}
