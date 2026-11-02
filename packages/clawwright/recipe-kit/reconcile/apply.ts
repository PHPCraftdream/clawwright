// The apply half: one batch patch, a re-read to confirm, durable intent before and result
// after. The plan is always recomputed against the current projection — a pending intent
// from a crash gap leads to a fresh plan, never a replay.

import { RecipeKitRefusal, type RecipeContext } from "../types.ts";
import { appCli, appConfigPatch } from "../app.ts";
import { privatePseudonym, privatePseudonymKeyIfPresent } from "../../security/privacy/structured/pseudonym.ts";
import {
  canonical, isReconcileValue, reconcileIntendedFingerprint, reconcilePlan, reconcilePlanView,
  validatePlanShape,
} from "./plan.ts";
import { checkOwnership, checkProtectedPath, checkProtectedPlan, checkRemovalBounds } from "./guard.ts";
import {
  readReconcileProvenance, reconcileDetail, reconcilePseudonyms,
  recordReconcileIntent, recordReconcileResult, reconcilePendingIntents, writeReconcileProvenance,
} from "./provenance.ts";
import { GUARD_VERIFY_MISMATCH } from "./types.ts";
import type {
  ReconcileAccessor, ReconcileApplyOptions, ReconcileApplyResult, ReconcileApplySource,
  ReconcileApplyStatus, ReconcileEntry, ReconcileJournal, ReconcilePlan, ReconcilePlanView,
  ReconcilePlanViewOptions, ReconcileSummary, ReconcileValue,
} from "./types.ts";

/** Default accessor: the projection read goes through `config get <path> --json` and the
 *  batch write through appConfigPatch (`config patch --stdin`), both on the journal
 *  context's runtime; ctx.dryRun turns the patch into a CLI dry-run. A projection whose
 *  read was redacted is refused before anything is written. */
export function appConfigAccessor(ctx: RecipeContext, path: string): ReconcileAccessor {
  return {
    async read() {
      const result = await appCli(ctx, ["config", "get", path, "--json"], {
        json: true,
        guard: (value: unknown): value is ReconcileValue | undefined => value === undefined || isReconcileValue(value),
      });
      // A masked projection would be patched back with the mask over the operator's value.
      if (result.redacted) throw new RecipeKitRefusal("guard", "projection contains a registered secret");
      return result.data;
    },
    async patch(projection) {
      await appConfigPatch(ctx, { [path]: projection });
    },
  };
}

function isPlan(source: ReconcileApplySource): source is ReconcilePlan {
  return !Array.isArray(source);
}

/** Foreign exceptions from adversarial plan sources (hostile getters, Proxy traps, an
 *  overridden `map`) become a content-free refusal — the underlying message never leaks. */
function contentFree(error: unknown): never {
  if (error instanceof RecipeKitRefusal) throw error;
  throw new RecipeKitRefusal("invalid-request");
}

async function readCurrent(accessor: ReconcileAccessor): Promise<Record<string, ReconcileValue>> {
  let current: ReconcileValue | undefined;
  try {
    current = await accessor.read();
  } catch (error) {
    if (error instanceof RecipeKitRefusal) throw error;
    throw new RecipeKitRefusal("transport");
  }
  if (current !== undefined && (typeof current !== "object" || current === null || Array.isArray(current))) {
    throw new RecipeKitRefusal("guard", "projection is not an object");
  }
  try {
    if (current !== undefined && !isReconcileValue(current)) {
      throw new RecipeKitRefusal("guard", "projection is not an object");
    }
  } catch (error) { contentFree(error); }
  return (current ?? {}) as Record<string, ReconcileValue>;
}

/** Stored provenance is pseudonymized on identifying namespaces while the current
 *  projection carries raw keys. Translate each raw current key into the stored namespace
 *  (its pseudonym token) and keep the raw key for every token that provenance recorded, so
 *  the pure planner always compares provenance and current keys in the SAME namespace.
 *  Tokens never match raw keys directly; unrecorded keys stay unprovenanced. */
async function provenanceInCurrentNamespace(
  journal: ReconcileJournal, stored: readonly string[], currentKeys: readonly string[], readOnlyKey = false,
): Promise<readonly string[]> {
  if (journal.identifying === false || stored.length === 0) return stored;
  if (readOnlyKey) {
    // Resolve with the existing deployment key only. Missing key cannot safely map raw
    // current keys to stored tokens, so fail closed before applying a potentially unsafe plan.
    const key = await privatePseudonymKeyIfPresent(journal.ctx, journal.pseudonymDir);
    if (key === undefined) throw new RecipeKitRefusal("invalid-request");
  }
  const tokens = await reconcilePseudonyms(journal, currentKeys);
  const recorded = new Set(stored);
  return currentKeys.filter((_key, index) => recorded.has(tokens[index]));
}

/** Redacted view of the computed plan for the result: identifying namespaces pseudonymize
 *  entry keys, non-identifying ones fall back to the view's `#<index>` markers; the
 *  fingerprints are keyed by the deployment's pseudonym key. A dry run passes the read-only
 *  key flag: the key is only read, never created — an absent key yields `#<index>` markers,
 *  `"unavailable"` fingerprints and `keyed: false`. A view refusal surfaces content-free. */
async function viewFor(plan: ReconcilePlan, journal: ReconcileJournal, readOnlyKey: boolean): Promise<ReconcilePlanView> {
  const viewOptions: ReconcilePlanViewOptions = {
    pseudonym: { ctx: journal.ctx, pseudonymDir: journal.pseudonymDir },
    ...(readOnlyKey ? { readOnlyKey: true } : {}),
    ...(journal.identifying === false ? {} : {
      pseudonymize: (key: string) => privatePseudonym(journal.ctx, journal.pseudonymDir, {
        recipe: journal.recipe, namespace: journal.namespace, value: key,
      }),
    }),
  };
  try { return await reconcilePlanView(plan, viewOptions); }
  catch (error) { contentFree(error); }
}

const NO_SUMMARY: ReconcileSummary = { added: 0, changed: 0, removed: 0, unchanged: 0, overlap: 0 };

/** Derives the compatibility booleans from the stable status; fields carry the rest. */
function outcome(status: ReconcileApplyStatus, fields: Omit<ReconcileApplyResult, "status" | "ok" | "applied" | "dryRun">): ReconcileApplyResult {
  const applied = status === "applied";
  return {
    status,
    ok: applied || status === "no-op" || status === "dry-run",
    applied,
    ...(status === "dry-run" ? { dryRun: true as const } : {}),
    ...fields,
  };
}

/** Applies the desired set (or a precomputed plan) as ONE batch patch, verifies the
 *  projection afterwards and journals intent and result. Unknown or failed desired-set
 *  sources (including an undefined readDesired result) return a FAILED result and apply
 *  nothing — fail-closed. Guard refusals and verification mismatches return results too
 *  (status "refused"/"failed"); RecipeKitRefusal is thrown ONLY for programmer errors
 *  (invalid options, paths or journal). Order: load state, resolve crash-pending intents IN
 *  MEMORY, plan from the RECOVERED provenance, then guard/apply/publish — so a recovered
 *  member is classified by THIS run's plan (unchanged, or removable with consent), never as
 *  overlap. */
export async function reconcileApply(source: ReconcileApplySource, options: ReconcileApplyOptions): Promise<ReconcileApplyResult> {
  // Freeze the caller's protected-path extension once; later mutation cannot shrink checks.
  const protectedPaths = Object.freeze([...(options.protectedPaths ?? [])]);
  try { checkOwnership(options); }
  catch (error) {
    if (!(error instanceof RecipeKitRefusal) || error.reason !== "guard") throw error;
    return outcome("refused", { reason: "guard", detail: error.detail, info: error.info, summary: NO_SUMMARY, pendingIntents: 0 });
  }
  try { checkProtectedPath(options.path, protectedPaths); }
  catch (error) {
    if (!(error instanceof RecipeKitRefusal) || error.reason !== "guard") throw error;
    return outcome("refused", { reason: "guard", detail: error.detail, info: error.info, summary: NO_SUMMARY, pendingIntents: 0 });
  }
  const journal: ReconcileJournal = options.journal;
  if (journal === undefined || typeof journal !== "object") throw new RecipeKitRefusal("guard", "journal is required for apply");
  const accessor = options.accessor ?? appConfigAccessor(journal.ctx, options.path);
  const dryRun = (journal.ctx as RecipeContext).dryRun === true;
  const pending = await reconcilePendingIntents(journal);
  if (isPlan(source) && pending.ids.length > 0) {
    // The stored plan predates the crash gap: only a fresh computation may proceed. No plan
    // was computed, so the refused result carries no view.
    return outcome("refused", {
      reason: "guard", detail: "pending intent; recompute the plan",
      summary: NO_SUMMARY, pendingIntents: pending.ids.length,
    });
  }
  let effective = source;
  if (!isPlan(effective) && options.readDesired !== undefined) {
    let raw: readonly ReconcileEntry[] | undefined;
    try { raw = await options.readDesired(); }
    catch { return outcome("failed", { reason: "guard", detail: "desired set source failed", summary: NO_SUMMARY, pendingIntents: pending.ids.length }); }
    if (raw === undefined) {
      return outcome("failed", { reason: "guard", detail: "desired set source failed", summary: NO_SUMMARY, pendingIntents: pending.ids.length });
    }
    effective = raw;
  }
  let current: Record<string, ReconcileValue>;
  try {
    current = await readCurrent(accessor);
  } catch (error) {
    if (!(error instanceof RecipeKitRefusal)) throw error;
    return outcome("failed", { reason: error.reason, summary: NO_SUMMARY, pendingIntents: pending.ids.length });
  }
  let desired: readonly ReconcileEntry[];
  if (isPlan(effective)) {
    // Structural, descriptor-only validation: hostile `map`s and getters are refused
    // content-free WITHOUT being executed or invoked.
    let shape: ReconcilePlan;
    try { shape = validatePlanShape(effective); } catch (error) { contentFree(error); }
    // Rebuild the desired set from the validated plan plus current values; adopted
    // overlaps keep their current value — adoption records provenance, it does not
    // overwrite operators.
    desired = [
      ...shape.added, ...shape.changed,
      ...shape.unchanged.map((entry) => ({ key: entry.key, value: current[entry.key] })),
      ...(options.adoptOverlaps === true
        ? shape.overlap.map((entry) => ({ key: entry.key, value: current[entry.key] }))
        : []),
    ];
  } else {
    if (options.validateDesired !== undefined) {
      let valid = false;
      try { valid = options.validateDesired(effective) === true; } catch { valid = false; }
      if (!valid) return outcome("failed", { reason: "guard", detail: "desired set failed validation", summary: NO_SUMMARY, pendingIntents: pending.ids.length });
    }
    desired = effective;
  }
  const stored = await readReconcileProvenance(journal);
  // Crash recovery BEFORE planning: pending keys from a PREVIOUS intent whose exact
  // intended value (matched by fingerprint) is present in the config are promoted in
  // memory; absent or diverged pending keys are dropped. Keys never pending are never
  // promoted, so operator-added entries stay overlap.
  const recovered: string[] = [];
  const recoveredTokens: string[] = [];
  if (stored.pending.length > 0) {
    const keys = Object.keys(current);
    // Dry runs must never create the key while resolving pending provenance either. If the
    // key is missing, do not guess at token ownership: refuse safely with no writes.
    if (dryRun && journal.identifying !== false) {
      const key = await privatePseudonymKeyIfPresent(journal.ctx, journal.pseudonymDir);
      if (key === undefined) {
        return outcome("failed", { reason: "guard", detail: "provenance key unavailable", summary: NO_SUMMARY, pendingIntents: pending.ids.length });
      }
    }
    const tokens = await reconcilePseudonyms(journal, keys);
    for (const entry of stored.pending) {
      const index = tokens.indexOf(entry.token);
      const value = index >= 0 ? current[keys[index]] : undefined;
      if (value === undefined) continue;
      try {
        if (reconcileIntendedFingerprint(value, entry.token) === entry.fingerprint) {
          recovered.push(keys[index]);
          recoveredTokens.push(entry.token);
        }
      } catch { /* diverged or unreadable value stays unpromoted */ }
    }
  }
  // Plan from the RECOVERED provenance: recovered tokens act as confirmed provenance keys,
  // so a recovered member is unchanged (matching desired value) or removable in this run.
  let confirmed: readonly string[];
  try { confirmed = await provenanceInCurrentNamespace(journal, stored.keys, Object.keys(current), dryRun); }
  catch (error) {
    if (!dryRun || !(error instanceof RecipeKitRefusal)) throw error;
    return outcome("failed", { reason: "guard", detail: "provenance key unavailable", summary: NO_SUMMARY, pendingIntents: pending.ids.length });
  }
  const provenance = [...new Set([...confirmed, ...recovered])];
  let plan: ReconcilePlan;
  try {
    plan = reconcilePlan({ desired, current, provenance });
  } catch (error) {
    if (!isPlan(effective) && options.readDesired !== undefined) {
      return outcome("failed", { reason: "guard", detail: "desired set source failed", summary: NO_SUMMARY, pendingIntents: pending.ids.length });
    }
    contentFree(error);
  }
  // Protected keys and nested value keys are enforced before bounds and before any patch
  // or journaled intent: a protected member under a clean target path refuses as a result.
  const adopting = options.adoptOverlaps === true && plan.summary.overlap > 0;
  const pendingIntents = pending.ids.length;
  // Recovery outcome as counts only, never keys: pending entries whose fingerprint matched
  // would be promoted, the rest dropped.
  const recovery = stored.pending.length > 0
    ? { promoted: recovered.length, dropped: stored.pending.length - recovered.length }
    : undefined;
  const recoveryField = recovery === undefined ? {} : { recovery };
  // The view is computed BEFORE the guard checks and BEFORE any write: a dry run uses the
  // read-only key path (nothing is created), and refused/failed outcomes still carry the
  // already-computed view of the plan they refused or failed to apply.
  let view: ReconcilePlanView;
  try { view = await viewFor(plan, journal, dryRun); }
  catch (error) { contentFree(error); }
  try {
    checkProtectedPlan(options.path, plan, current, protectedPaths);
    checkRemovalBounds(plan.removed.length, Object.keys(current).length, options);
  } catch (error) {
    if (!(error instanceof RecipeKitRefusal)) throw error;
    return outcome("refused", {
      reason: error.reason, detail: error.detail, info: error.info,
      summary: plan.summary, pendingIntents, view, ...recoveryField,
    });
  }
  // A dry run writes NOTHING — no key file or parents, no provenance write or pending
  // clear, no journal record, no patch — including the recovery promotion below; it is
  // only reported.
  if (dryRun) {
    return outcome("dry-run", { summary: plan.summary, pendingIntents, view, ...recoveryField });
  }
  if (plan.summary.added + plan.summary.changed + plan.summary.removed === 0 && !adopting) {
    if (stored.pending.length > 0) {
      // Persist the recovery decision even with nothing to apply — idempotent on re-runs.
      await writeReconcileProvenance(journal, [...new Set([...stored.keys, ...recoveredTokens])]);
    }
    return outcome("no-op", { summary: plan.summary, pendingIntents, view, ...recoveryField });
  }
  const touched = [...plan.added, ...plan.changed, ...(adopting ? plan.overlap : [])].map((entry) => entry.key);
  const pseudonyms = await reconcilePseudonyms(journal, touched);
  const intended: Record<string, ReconcileValue> = { ...current };
  for (const entry of [...plan.added, ...plan.changed]) intended[entry.key] = entry.value;
  for (const entry of plan.removed) delete intended[entry.key];
  const pendingRaw = [...plan.added, ...(adopting ? plan.overlap : [])].map((entry) => entry.key);
  const pendingTokens = await reconcilePseudonyms(journal, pendingRaw);
  const pendingEntries = pendingRaw.map((key, index) => ({
    token: pendingTokens[index],
    fingerprint: reconcileIntendedFingerprint(intended[key], pendingTokens[index]),
  }));
  const id = await recordReconcileIntent(journal.ctx, journal.journalPath, reconcileDetail(plan.summary, pseudonyms, options.reason));
  try {
    // Phase one: the pending record lands BEFORE the patch, so a crash between the patch
    // and provenance publication leaves the new members recoverable, not orphaned.
    await writeReconcileProvenance(journal, [...new Set([...stored.keys, ...recoveredTokens])], pendingEntries);
    await accessor.patch(intended);
  } catch (error) {
    await recordReconcileResult(journal.ctx, journal.journalPath, id, "failed", reconcileDetail(plan.summary, [], "patch"));
    return outcome("failed", {
      reason: error instanceof RecipeKitRefusal ? error.reason : "transport",
      summary: plan.summary, pendingIntents, view, ...recoveryField,
    });
  }
  let after: Record<string, ReconcileValue>;
  try {
    after = await readCurrent(accessor);
  } catch {
    // The verification re-read dying is the crash gap itself: journal the failed outcome
    // and return a failed result — the pending intent stays recoverable.
    await recordReconcileResult(journal.ctx, journal.journalPath, id, "failed", reconcileDetail(plan.summary, [], "verify"));
    return outcome("failed", {
      reason: "transport",
      summary: plan.summary, pendingIntents, view, ...recoveryField,
    });
  }
  let verified = false;
  try { verified = canonical(after) === canonical(intended); } catch (error) { contentFree(error); }
  if (!verified) {
    await recordReconcileResult(journal.ctx, journal.journalPath, id, "failed", reconcileDetail(plan.summary, [], "verify"));
    return outcome("failed", {
      reason: "guard", detail: GUARD_VERIFY_MISMATCH,
      summary: plan.summary, pendingIntents, view, ...recoveryField,
    });
  }
  // Phase two: promote — merge this run's members with any crash-recovered keys and drop
  // every pending entry. A key REMOVED in this same run is never provenanced, even when it
  // was recovered earlier in the run: final ownership is (confirmed + recovered + added/
  // changed/adopted) MINUS removed.
  const removedKeys = new Set(plan.removed.map((entry) => entry.key));
  const members = [...touched, ...plan.unchanged.map((entry) => entry.key), ...recovered]
    .filter((key) => !removedKeys.has(key));
  await writeReconcileProvenance(journal, await reconcilePseudonyms(journal, members));
  await recordReconcileResult(journal.ctx, journal.journalPath, id, "done", reconcileDetail(plan.summary, pseudonyms, options.reason));
  return outcome("applied", { summary: plan.summary, pendingIntents, view, ...recoveryField });
}
