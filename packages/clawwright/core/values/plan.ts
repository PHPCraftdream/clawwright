// Branded plan values and the local-fact refusal texts they are minted under (stage 7
// S2.5). The brand symbols are not exported, so the only way to obtain one of these types
// is the mint below — called by a value kind's `resolve`, never by a run phase. The refusal
// texts live here (not spec.ts) so core/values can raise them without a runtime import of
// core/command; spec.ts's localFactRefusal delegates to these, byte-identical.

import { commandLine } from "#src/core/io/invocation/render.ts";
import { resolve } from "node:path";

const ARTIFACT = Symbol("clawwright.local-artifact");
const RECIPE_SOURCE = Symbol("clawwright.local-recipe-source");
const RECIPE_REF = Symbol("clawwright.recipe-ref");
const CHECKSUM = Symbol("clawwright.checksum");
const OPERATION_ID = Symbol("clawwright.operation-id");

/** A local file proven to exist as a regular file by `localFile`'s resolve. */
export interface LocalArtifact {
  readonly path: string;
  readonly [ARTIFACT]: true;
}

/** A local directory proven to contain a recipe.json by `localDirectory`'s resolve. */
export interface LocalRecipeSource {
  readonly path: string;
  readonly [RECIPE_SOURCE]: true;
}

/** A recipe proven to exist in the current source by `recipeRef`'s resolve. */
export type RecipeRef = string & { readonly [RECIPE_REF]: true };
/** A 64-hex-digit declaration checksum (`checksum("hex64")`). */
export type Checksum = string & { readonly [CHECKSUM]: true };
/** A recorded operation id (`id("operation")`). */
export type OperationId = string & { readonly [OPERATION_ID]: true };

// Mints for the resolve implementations in kinds.ts.
export function localArtifact(path: string): LocalArtifact {
  return { path, [ARTIFACT]: true };
}
export function localRecipeSource(path: string): LocalRecipeSource {
  return { path, [RECIPE_SOURCE]: true };
}
export function recipeRef(name: string): RecipeRef {
  return name as RecipeRef;
}
export function checksum(value: string): Checksum {
  return value as Checksum;
}
export function operationId(value: string): OperationId {
  return value as OperationId;
}

// --- the local-fact refusal texts, byte-identical to spec.ts's former own ones ------------------

export function missingArtifactRefusal(path: string): string {
  return `${path} not found — build one with ${commandLine("set build")}, or pass the path to an existing set artifact`;
}

export function missingRecipeRefusal(name: string): string {
  return `recipe "${name}" not found — expected recipes/${name}/recipe.json`;
}

export function missingRecipeSourceRefusal(source: string): string {
  return `recipe source has no recipe.json: ${resolve(source)}`;
}
