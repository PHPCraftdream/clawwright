// One owner per piece of advice decided from a set's state (refactor plan stage 1 item 3):
// the image pin, and the recipe-completeness remedy per gap. `set validate`, `set build` and
// the checks call these; nothing formulates its own wording.

import { command } from "#src/core/io/invocation/advice.ts";
import type { Advice, CommandAdvice } from "#src/core/io/invocation/advice.ts";
import { problem } from "#src/service/inspection.ts";
import type { Problem } from "#src/service/inspection.ts";
import type { DeploymentLock } from "#src/commands/management/lock.ts";

/** One source of image-pin advice for `set validate` and `set build`, decided from the
 *  lock's CONTENT, never from the file's existence: a lock is meant to be committed, so
 *  "a lock exists" says nothing about whether an instance was ever deployed on this machine.
 *  `lock` records {reference: OPENCLAW_IMAGE, digest: RepoDigests[0] of the local image that
 *  reference names} — never the running container's image — so the advice describes what each
 *  command does instead of claiming a state it cannot see. Returns the main command as Advice;
 *  the alternatives live in its note. */
export function imagePinAdvice(requiredImage: string, lock: DeploymentLock | undefined): { detail: string; next: Advice } {
  if (lock === undefined) {
    return {
      detail: `the set requires image ${requiredImage}, which is a tag — a set that names a tag installs whatever that tag means on the day it is installed; no lock was ever recorded here, and \`lock\` records the digest of the local image that OPENCLAW_IMAGE names, so the tag must exist locally first`,
      next: command("bootstrap"),
    };
  }
  if (lock.image.digest === undefined) {
    return {
      detail: `the set requires image ${requiredImage}, which is a tag, and the recorded lock (for ${lock.image.reference}) carries no digest — \`lock\` records the digest of the local image that OPENCLAW_IMAGE names, so the tag must be pulled before it can pin`,
      next: command(["upgrade", "--image", requiredImage], { note: "before the first deployment, `bootstrap` instead; `lock` after to pin" }),
    };
  }
  return {
    detail: `the set requires image ${requiredImage}, which is a tag — a set that names a tag installs whatever that tag means on the day it is installed; the recorded lock was taken for ${lock.image.reference}, so the deployment was last pinned to a different image`,
    next: command(["upgrade", "--image", requiredImage], { note: "moves the deployment to the image now declared; `lock` afterwards only if the gateway then runs it (lock records the local image's digest, not the running container's)" }),
  };
}

/** The recipe-completeness finding, with the remedy naming the exact edit for THIS gap, as a
 *  runnable command with the reason in parentheses (R33-08). An artifact's content is fixed
 *  in the tree it was built from and rebuilt. */
/** The remedy note of a recipe-completeness finding: the reason in front of the edit. */
export function afterNote(fix: string): string {
  return `after ${fix}`;
}

export function recipeIncomplete(recipe: string, detail: string, fix: string, cmd = "set validate"): Problem {
  return problem("SET_RECIPE_INCOMPLETE", detail, command(cmd, { note: afterNote(fix) }));
}

/** A recipe directory that is absent, or neither an MCP recipe nor a service: the remedy
 *  points at the tree and a rebuild, the only place the gap can be closed. */
export function recipeMissingDir(recipe: string, detail: string): Problem {
  return recipeIncomplete(
    recipe,
    detail,
    `adding recipe.json or server.ts to recipes/${recipe}, or removing the directory`,
    "set build",
  );
}

/** A recipe file (recipe.json by default) that does not parse the way its reader reads it: the
 *  loader's own message is the detail, the file to fix is the remedy. */
export function recipeInvalidDefinition(recipe: string, message: string, file = "recipe.json"): Problem {
  return problem("SET_RECIPE_INVALID", message, command("set validate", { note: `after fixing recipes/${recipe}/${file}` }));
}

/** A recipe directory whose NAME the path-name grammar rejects (names.ts owns the rule, the
 *  message is its own): the folder is renamed, not its files. */
export function recipeInvalidName(recipe: string, message: string): Problem {
  return problem("SET_RECIPE_INVALID", message, command("set validate", { note: `after renaming recipes/${recipe}` }));
}

/** The remedy the instance-side recipe findings carry: re-provisioning one recipe. */
export function provisionRemedy(recipe: string): CommandAdvice {
  return command(["provision-agent", recipe]);
}

/** The remedy an orphaned object carries: forgetting it by kind and name. */
export function forgetRemedy(kind: string, name: string): CommandAdvice {
  return command(["set", "forget", "--kind", kind, "--name", name]);
}
