// Trial identity: the deterministic-but-colliding-proof compose project name, the scratch
// home derived from it, and the per-service build image tags. Same identity inputs as
// `recipeProjectName` hashes (service/recipe.ts), re-derived here (service/recipe.ts is
// not modified) so the trial namespace is deterministic per recipe but can never collide
// with a live project — the `trial` infix plus a fresh random suffix see to that.

import { createHash, randomBytes } from "node:crypto";
import type { Context } from "#src/core/context.ts";
import { locksDir } from "#src/core/env.ts";
import { die } from "#src/core/io/log.ts";
import { safeName } from "#src/core/values/names.ts";
import { composeProjectName } from "#src/runtime/deployment.ts";

const COMPOSE_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export interface TrialIdentity {
  readonly project: string;
  readonly home: string;
  readonly hash: string;
  readonly random: string;
}

export function trialIdentity(ctx: Context, name: string): TrialIdentity {
  const hash = createHash("sha256")
    .update(JSON.stringify([composeProjectName(), safeName("recipe", name)]))
    .digest("hex")
    .slice(0, 12);
  const random = randomBytes(4).toString("hex");
  const project = `clawwright-recipe-trial-${hash}-${random}`;
  if (!COMPOSE_PROJECT_PATTERN.test(project)) die(`derived trial compose project "${project}" is not a valid project name`);
  return { project, home: `${locksDir(ctx.settings.dataDir)}/.clawwright-recipe-trial-${hash}-${random}`, hash, random };
}

/** Docker image-name grammar, lowercased: path segments of [a-z0-9] with . _ - inner
 *  separators, an optional tag. The trial's build services carry this tag so the base
 *  compose file's live image tag is never built over. */
const IMAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\/[a-z0-9][a-z0-9._-]*[a-z0-9])*(?::[a-zA-Z0-9_.-]+)?$/;

export function buildTagOf(identity: TrialIdentity, service: string): string {
  const tag = `clawwright-recipe-trial-build-${identity.hash}-${identity.random}--${service.toLowerCase()}`;
  if (!IMAGE_NAME_PATTERN.test(tag)) die(`recipe trial refuses ${service}.build: the derived trial image tag "${tag}" is not a valid image name`);
  return tag;
}
