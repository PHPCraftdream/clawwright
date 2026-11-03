// Fail-closed guards: protected paths, ownership and removal bounds. Refusals name counts
// and codes only — never member keys, values or transport causes.

import { RecipeKitRefusal } from "../types.ts";
import { MAX_DEPTH } from "./plan.ts";
import { safeReconcilePath, underReconcilePrefix } from "./paths.ts";
import {
  GUARD_NO_OWNERSHIP_SOURCE, GUARD_PATH_FOREIGN_OWNER, GUARD_PATH_PROTECTED, GUARD_PATH_UNOWNED,
  RECONCILE_LARGE_REMOVAL_CONSENT,
  RECONCILE_MAX_REMOVED_COUNT,
  RECONCILE_MAX_REMOVED_FRACTION,
  RECONCILE_PROTECTED_SEGMENTS,
} from "./types.ts";
import type { ReconcileApplyOptions, ReconcilePathOwner, ReconcilePlan, ReconcileValue } from "./types.ts";

/** The effective extension: a frozen copy, so later caller mutation can neither change
 *  enforcement nor shrink the built-ins. */
function protectedSet(extra?: readonly string[]): { segments: ReadonlySet<string>; sequences: readonly string[][] } {
  const frozen = Object.freeze([...(extra ?? [])]);
  return {
    segments: new Set([...RECONCILE_PROTECTED_SEGMENTS, ...frozen]),
    sequences: frozen.filter((path) => path.includes(".")).map((path) => path.split(".")),
  };
}

function refuseProtected(): never {
  throw new RecipeKitRefusal("guard", GUARD_PATH_PROTECTED);
}

/** True when a protected dotted extension matches the joined path as a segment sequence
 *  (segment-wise prefix or equal — the underReconcilePrefix rule, equality included). */
function sequenceProtected(parts: readonly string[], sequences: readonly string[][]): boolean {
  return sequences.some((head) => head.length <= parts.length && head.every((segment, index) => segment === parts[index]));
}

/** Refuses when any segment of the path is protected. The effective list is the built-in
 *  segments plus the caller's extensions; options can never remove a built-in. */
export function checkProtectedPath(path: unknown, extra?: readonly string[]): string {
  const safe = safeReconcilePath(path);
  const { segments, sequences } = protectedSet(extra);
  const parts = safe.split(".");
  if (parts.some((segment) => segments.has(segment)) || sequenceProtected(parts, sequences)) {
    refuseProtected();
  }
  return safe;
}

/** Walks a value's nested object/array keys (bounded by plan.ts's MAX_DEPTH) and collects
 *  the FULL accumulated segment paths under the target path — intermediate paths included,
 *  so a multi-segment dotted extension can match a deeply nested key. */
function joinedKeyPaths(base: readonly string[], value: ReconcileValue): string[][] {
  const out: string[][] = [];
  const walk = (node: ReconcileValue, prefix: readonly string[], depth: number): void => {
    if (depth >= MAX_DEPTH || node === null || typeof node !== "object") return;
    for (const key of Object.keys(node)) {
      const parts = [...prefix, ...key.split(".")];
      out.push(parts);
      walk((node as Record<string, ReconcileValue>)[key], parts, depth + 1);
    }
  };
  walk(value, base, 0);
  return out;
}

/** Refuses when any plan key, or any nested key of an added/changed value, sits on a
 *  protected segment — including a protected key nested under an owned ancestor path whose
 *  own target path is clean. Dotted extensions match as segment sequences. Removed and
 *  changed members carry no (old) value in the plan, so their CURRENT value is inspected
 *  too: a protected segment present in the old OR the new shape refuses. */
export function checkProtectedPlan(path: string, plan: ReconcilePlan, current: Readonly<Record<string, ReconcileValue>>, extra?: readonly string[]): void {
  const base = safeReconcilePath(path).split(".");
  const { segments, sequences } = protectedSet(extra);
  const pathsFor = (entry: { readonly key: string }, ...values: readonly (ReconcileValue | undefined)[]): string[][] => {
    const parts = [...base, ...entry.key.split(".")];
    const out = [parts];
    for (const value of values) {
      if (value !== undefined) out.push(...joinedKeyPaths(parts, value));
    }
    return out;
  };
  const paths = [
    ...plan.added.flatMap((entry) => pathsFor(entry, entry.value)),
    ...plan.changed.flatMap((entry) => pathsFor(entry, entry.value, current[entry.key])),
    ...plan.removed.flatMap((entry) => pathsFor(entry, current[entry.key])),
    ...plan.unchanged.flatMap((entry) => pathsFor(entry, current[entry.key])),
    ...plan.overlap.flatMap((entry) => pathsFor(entry, current[entry.key])),
  ];
  for (const parts of paths) {
    if (parts.some((segment) => segments.has(segment)) || sequenceProtected(parts, sequences)) refuseProtected();
  }
}

/** Exact match wins, else the deepest covering prefix — same rule as the owns catalog. */
function deepestOwner(owners: readonly ReconcilePathOwner[], path: string): ReconcilePathOwner | undefined {
  for (const owner of owners) {
    if (owner.path === path) return owner;
  }
  let best: ReconcilePathOwner | undefined;
  for (const owner of owners) {
    if (!owner.prefix || !underReconcilePrefix(owner.path, path)) continue;
    if (best === undefined || owner.path.split(".").length > best.path.split(".").length) best = owner;
  }
  return best;
}

/** Resolves the owner of the target path and requires it to be the calling recipe. */
export function checkOwnership(options: Pick<ReconcileApplyOptions, "path" | "recipe" | "owners" | "ownerOf">): ReconcilePathOwner {
  if (options.owners === undefined && options.ownerOf === undefined) {
    throw new RecipeKitRefusal("guard", GUARD_NO_OWNERSHIP_SOURCE);
  }
  const path = safeReconcilePath(options.path);
  const owner = options.ownerOf !== undefined ? options.ownerOf(path) : deepestOwner(options.owners ?? [], path);
  if (owner === undefined) throw new RecipeKitRefusal("guard", GUARD_PATH_UNOWNED);
  if (owner.recipe !== options.recipe) throw new RecipeKitRefusal("guard", GUARD_PATH_FOREIGN_OWNER);
  return owner;
}

/** Refuses removal beyond either bound unless the dedicated consent token is passed — the
 *  MCP mutation confirmation never lifts these bounds. The bounds are not caller-raisable:
 *  caller values only TIGHTEN (effective = min(default, caller)); exceeding the DEFAULT
 *  bounds always requires the token. Counts only, never values. */
export function checkRemovalBounds(removed: number, currentCount: number, options: Pick<ReconcileApplyOptions, "maxRemovedCount" | "maxRemovedFraction" | "largeRemovalConsent">): void {
  if (removed === 0) return;
  const countBound = Math.min(RECONCILE_MAX_REMOVED_COUNT, options.maxRemovedCount ?? RECONCILE_MAX_REMOVED_COUNT);
  const fractionBound = Math.min(RECONCILE_MAX_REMOVED_FRACTION, options.maxRemovedFraction ?? RECONCILE_MAX_REMOVED_FRACTION);
  const fraction = currentCount === 0 ? 0 : removed / currentCount;
  if (removed <= countBound && fraction <= fractionBound) return;
  if (options.largeRemovalConsent === RECONCILE_LARGE_REMOVAL_CONSENT) return;
  throw new RecipeKitRefusal("guard", `would remove ${removed} of ${currentCount}`, { removed, current: currentCount });
}
