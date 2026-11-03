// Config-path ownership: the `owns` manifest field and the joined catalog over
// `consumerEndpoints` + `owns` (U1). Paths are the same safe dot grammar as
// consumerEndpoints; prefixes match whole segments only (for example, `a.b` does not
// cover `a.bc`). A declaration touching an owned path, its descendants, or its ancestor
// conflicts because applying an ancestor replaces the owned subtree.

import { readName } from "#src/core/values/names.ts";
import {
  loadRecipe, recipeNames, recipesConfigured, recipesDirectory,
} from "#src/service/recipe.ts";
import { configPathParts } from "#src/core/values/config/config-selectors.ts";

const unsafeSegments = new Set(["__proto__", "prototype", "constructor"]);

/** The one validator for dot configuration paths, shared by consumerEndpoints and owns. */
export function safeConfigPath(prefix: string, value: unknown): string {
  if (typeof value !== "string"
    || !/^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/.test(value)
    || value.split(".").some((part) => unsafeSegments.has(part))) {
    throw new Error(`${prefix} must be a safe non-empty dot configuration path`);
  }
  return value;
}

export interface RecipeOwnsEntry {
  readonly path: string;
  readonly mode: "value" | "list-member";
  readonly prefix?: boolean;
}

/** Parses the optional `owns` declaration with the same strictness as its neighbours. */
export function parseOwns(recipe: string, value: unknown): RecipeOwnsEntry[] | undefined {
  if (value === undefined) return undefined;
  const prefix = `recipes/${recipe}/recipe.json: owns`;
  if (!Array.isArray(value)) throw new Error(`${prefix} must be an array`);
  const paths = new Set<string>();
  return value.map((entry, index) => {
    const at = `${prefix}[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${at} must contain only path, mode and prefix`);
    }
    const keys = Object.keys(entry);
    if (keys.length !== (keys.includes("prefix") ? 3 : 2) || !keys.includes("path") || !keys.includes("mode")) {
      throw new Error(`${at} must contain only path, mode and prefix`);
    }
    const owned = entry as Record<string, unknown>;
    const path = safeConfigPath(`${at}.path`, owned.path);
    if (owned.mode !== "value" && owned.mode !== "list-member") {
      throw new Error(`${at}.mode must be "value" or "list-member"`);
    }
    let ownPrefix = false;
    if (owned.prefix !== undefined) {
      if (typeof owned.prefix !== "boolean") throw new Error(`${at}.prefix must be a boolean`);
      ownPrefix = owned.prefix;
    }
    if (ownPrefix && owned.mode === "list-member") {
      throw new Error(`${at}: list-member ownership cannot be a prefix`);
    }
    if (paths.has(path)) throw new Error(`${at}: duplicate path ${path}`);
    paths.add(path);
    return { path, mode: owned.mode, prefix: ownPrefix };
  });
}

export interface RecipePathOwner {
  readonly recipe: string;
  readonly path: string;
  readonly mode: "value" | "list-member";
  readonly prefix: boolean;
}

/** Catalog entry plus the service binding and provenance the endpoint view needs. */
interface OwnershipEntry extends RecipePathOwner {
  readonly service?: string;
  readonly endpoint: boolean;
}

/** One walk of every recipe directory (disabled included, no-recipe directories skipped
 *  via the loader's ENOENT, loader failures thrown) collecting both ownership sources. */
export async function recipeOwnershipEntries(): Promise<readonly OwnershipEntry[]> {
  if (!recipesConfigured()) return [];
  const entries: OwnershipEntry[] = [];
  for (const name of await recipeNames(recipesDirectory())) {
    let recipe: Awaited<ReturnType<typeof loadRecipe>>;
    try {
      recipe = await loadRecipe(readName("recipe", name));
    } catch (error) {
      // Only the loader's actual manifest read ENOENT means this is not a recipe.
      if (error instanceof Error && (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT") continue;
      throw error;
    }
    for (const endpoint of recipe.consumerEndpoints ?? []) {
      entries.push({ recipe: name, path: endpoint.configPath, mode: "value", prefix: false, service: endpoint.service, endpoint: true });
    }
    for (const own of recipe.owns ?? []) {
      entries.push({ recipe: name, path: own.path, mode: own.mode, prefix: own.prefix === true, endpoint: false });
    }
  }
  return entries;
}

/** Segment-wise: `a.b` is under prefix `a`, never under prefix `a.bc`. */
function underPrefix(prefix: string, path: string): boolean {
  const head = prefix.split(".");
  const tail = path.split(".");
  return head.length < tail.length && head.every((segment, index) => segment === tail[index]);
}

/** The general catalog: equal paths (whatever their prefix flags) and prefix overlaps across recipes are refusals;
 *  an exact path inside its own recipe's prefix is fine. */
export async function recipePathOwners(): Promise<readonly RecipePathOwner[]> {
  const entries = await recipeOwnershipEntries();
  const exact = new Map<string, OwnershipEntry>();
  const prefixes: OwnershipEntry[] = [];
  for (const entry of entries) {
    if (entry.prefix) {
      prefixes.push(entry);
      continue;
    }
    const previous = exact.get(entry.path);
    if (previous !== undefined) {
      if (previous.endpoint && entry.endpoint) {
        throw new Error(`ambiguous consumerEndpoints configPath ${entry.path}: recipes ${previous.recipe} and ${entry.recipe}`);
      }
      throw new Error(`ambiguous config path ownership ${entry.path}: recipes ${previous.recipe} and ${entry.recipe}`);
    }
    exact.set(entry.path, entry);
  }
  for (const owned of exact.values()) {
    for (const prefixEntry of prefixes) {
      if (prefixEntry.recipe === owned.recipe) continue;
      if (prefixEntry.path === owned.path || underPrefix(prefixEntry.path, owned.path)) {
        throw new Error(`overlapping config path ownership ${owned.path}: recipes ${prefixEntry.recipe} and ${owned.recipe}`);
      }
    }
  }
  for (const wide of prefixes) {
    for (const narrow of prefixes) {
      if (wide.recipe === narrow.recipe || (wide.path !== narrow.path && !underPrefix(wide.path, narrow.path))) continue;
      throw new Error(`overlapping config path ownership ${narrow.path}: recipes ${wide.recipe} and ${narrow.recipe}`);
    }
  }
  return entries.map(({ recipe, path, mode, prefix }) => ({ recipe, path, mode, prefix }));
}

function pathSegments(path: string): { keys: string[]; selectorAt: number } {
  const parts = configPathParts(path);
  const selectorAt = parts.findIndex((part) => part.kind === "selector");
  return { keys: parts.slice(0, selectorAt < 0 ? parts.length : selectorAt).map((part) => part.kind === "key" ? part.key : part.value), selectorAt };
}
function overlaps(a: readonly string[], b: readonly string[], requireExact = false): boolean {
  const min = Math.min(a.length, b.length);
  return a.slice(0, min).every((segment, index) => segment === b[index]) && (!requireExact || a.length === b.length);
}
function ownerConflict(owners: readonly RecipePathOwner[], path: string): RecipePathOwner | undefined {
  let parsed: ReturnType<typeof pathSegments>;
  try { parsed = pathSegments(path); } catch { return undefined; }
  const selector = parsed.selectorAt >= 0;
  const conflicts = owners.filter((owner) => {
    const owned = owner.path.split(".");
    const listOverlap = overlaps(parsed.keys, owned);
    if (selector) return listOverlap;
    const exact = parsed.keys.length === owned.length && overlaps(parsed.keys, owned, true);
    const declarationAncestor = parsed.keys.length < owned.length && overlaps(parsed.keys, owned);
    const declarationDescendant = parsed.keys.length > owned.length && overlaps(owned, parsed.keys);
    return exact || declarationAncestor || declarationDescendant;
  });
  conflicts.sort((a, b) => b.path.split(".").length - a.path.split(".").length || Number(b.prefix) - Number(a.prefix));
  return conflicts[0];
}

/** Pure segment-aware lookup: exact match wins, else the deepest covering prefix. */
export function ownerOfConfigPath(owners: readonly RecipePathOwner[], path: string): RecipePathOwner | undefined {
  let direct: RecipePathOwner | undefined;
  let parsed: ReturnType<typeof pathSegments>;
  try { parsed = pathSegments(path); } catch { return undefined; }
  if (parsed.selectorAt >= 0) return ownerConflict(owners, path);
  const keys = parsed.keys;
  direct = owners.find((owner) => {
    const owned = owner.path.split(".");
    return overlaps(keys, owned, true);
  });
  if (direct !== undefined) return direct;
  let best: RecipePathOwner | undefined;
  let length = -1;
  for (const owner of owners) {
    const owned = owner.path.split(".");
    if (!overlaps(owned, keys) || owned.length >= keys.length) continue;
    if (owned.length > length) { best = owner; length = owned.length; }
  }
  return best;
}

/** Pure: the owner a declaration at `declaredPath` conflicts with, or undefined when the
 *  declaration may stand. Three conflict shapes: the path is owned exactly, it lies under an
 *  owned prefix, or it is an ANCESTOR of an owned path — applying an ancestor replaces the
 *  whole object, so the owned subtree is overwritten either way. Even a scalar value at the
 *  ancestor still clobbers the owned subpath (the parent object is replaced wholesale), so
 *  there is no non-conflicting ancestor value; only a disjoint sibling is fine. */
export function conflictingDeclaredPath(
  owners: readonly RecipePathOwner[],
  declaredPath: string,
): RecipePathOwner | undefined {
  return ownerConflict(owners, declaredPath);
}

/** The one refusal wording, shared by the async wrapper and inspect's problem detail. */
export function declaredOwnershipConflictDetail(declaredPath: string, owner: RecipePathOwner): string {
  return `config path ${declaredPath} is declared here but owned by recipe "${owner.recipe}" — remove it from the declaration or the recipe's owns`;
}

function refuseWith(owners: readonly RecipePathOwner[], declared: readonly { path: string }[]): void {
  for (const entry of declared) {
    const owner = conflictingDeclaredPath(owners, entry.path);
    if (owner !== undefined) throw new Error(declaredOwnershipConflictDetail(entry.path, owner));
  }
}

/** Refuses a whole desired-state declaration that touches any owned path. Throws the
 *  catalog's own error unchanged when the recipes themselves are ambiguous — a broken
 *  ownership catalog must surface, never read as "nothing is owned". */
export async function refuseDeclaredOwnedPaths(declared: readonly { path: string }[]): Promise<void> {
  refuseWith(await recipePathOwners(), declared);
}

/** Pure apply-config prefilter. Drops only entries owned exactly or under an owned prefix:
 *  a declared ANCESTOR of an owned path cannot be partially applied (a batch set of `a`
 *  would replace the object containing owned `a.b`), so that case is a whole-apply refusal
 *  handled by conflictingDeclaredPath/refuseDeclaredOwnedPaths before staging, never a drop. */
export function filterOwnedDeclarations<T extends { path: string }>(
  declared: readonly T[],
  owners: readonly RecipePathOwner[],
): { kept: T[]; dropped: number } {
  const kept = declared.filter((entry) => conflictingDeclaredPath(owners, entry.path) === undefined);
  return { kept, dropped: declared.length - kept.length };
}
