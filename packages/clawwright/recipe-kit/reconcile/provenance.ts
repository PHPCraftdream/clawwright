// Durable provenance and intent/result journaling for reconcile. Member keys are stored
// pseudonymized when the namespace is identifying; journal details carry pseudonyms and
// counts only. Every journal failure surfaces as a content-free RecipeKitRefusal.

import { randomUUID } from "node:crypto";
import type { Context } from "../../core/context.ts";
import type { JsonValue } from "../../security/privacy/structured/internal.ts";
import { appendPrivateIntent, appendPrivateResult, readPendingPrivateIntents, type PrivateIntentRecord, type PrivateResultRecord } from "../../security/privacy/structured/intents.ts";
import { readPrivateState, writePrivateState } from "../../security/privacy/structured/state.ts";
import { privatePseudonym } from "../../security/privacy/structured/pseudonym.ts";
import { RecipeKitRefusal } from "../types.ts";
import { RECONCILE_INTENT_KIND, RECONCILE_STATE_VERSION } from "./types.ts";
import type { ReconcileJournal, ReconcileSummary } from "./types.ts";

type JournalDetail = { readonly [key: string]: JsonValue };

function refuse(error: unknown): never {
  if (error instanceof RecipeKitRefusal) throw error;
  throw new RecipeKitRefusal("transport");
}

interface PendingMember { readonly token: string; readonly fingerprint: string }
interface KeyState { keys: string[]; pending: PendingMember[] }
function isPendingMember(value: unknown): value is PendingMember {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && typeof record.token === "string" && record.token.length > 0
    && typeof record.fingerprint === "string" && record.fingerprint.length > 0;
}
function isKeyState(value: unknown): value is KeyState {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 2) return false;
  const record = value as { keys?: unknown; pending?: unknown };
  return isStringArray(record.keys) && Array.isArray(record.pending) && record.pending.every(isPendingMember);
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((key) => typeof key === "string");
}

/** Pseudonymizes identifying keys; a non-identifying namespace stores plain keys. */
export async function reconcilePseudonyms(journal: ReconcileJournal, keys: readonly string[]): Promise<readonly string[]> {
  if (journal.identifying === false) return [...keys];
  try {
    return await Promise.all(keys.map((key) => privatePseudonym(journal.ctx, journal.pseudonymDir, {
      recipe: journal.recipe, namespace: journal.namespace, value: key,
    })));
  } catch (error) { return refuse(error); }
}

/** Confirmed member tokens plus the pending two-phase record: keys whose write was in
 *  flight (recorded BEFORE the patch, promoted after verify — or by the next run's crash
 *  recovery). Fingerprints are keyed digests of the intended value; promotion requires the
 *  exact digest to match, so an operator-diverged value is never adopted. */
export async function readReconcileProvenance(journal: ReconcileJournal): Promise<KeyState> {
  try {
    const value = await readPrivateState<KeyState>(journal.ctx, journal.statePath, {
      version: RECONCILE_STATE_VERSION, validate: isKeyState,
    });
    return value ?? { keys: [], pending: [] };
  } catch (error) { return refuse(error); }
}

export async function writeReconcileProvenance(
  journal: ReconcileJournal, keys: readonly string[], pending: readonly PendingMember[] = [],
): Promise<void> {
  try {
    await writePrivateState<KeyState>(journal.ctx, journal.statePath, { keys: [...keys], pending: [...pending] }, {
      version: RECONCILE_STATE_VERSION, validate: isKeyState,
    });
  } catch (error) { return refuse(error); }
}

/** Pending intents are the crash gap: callers recompute the plan from current state, never
 *  replay an old one. Exposed so a hook can report the gap before deciding to apply. */
export async function reconcilePendingIntents(journal: ReconcileJournal): Promise<{ ids: readonly string[]; truncated: boolean; corrupt: number }> {
  try {
    return await readPendingPrivateIntents(journal.ctx, journal.journalPath, { limit: 100 });
  } catch (error) { return refuse(error); }
}

export async function recordReconcileIntent(
  ctx: Context, journalPath: string, detail: JournalDetail,
): Promise<string> {
  const record: PrivateIntentRecord = { id: randomUUID(), kind: RECONCILE_INTENT_KIND, detail };
  try {
    await appendPrivateIntent(ctx, journalPath, record);
  } catch (error) { return refuse(error); }
  return record.id;
}

export async function recordReconcileResult(
  ctx: Context, journalPath: string, id: string, outcome: "done" | "failed", detail: JournalDetail,
): Promise<void> {
  const record: PrivateResultRecord = { id, kind: RECONCILE_INTENT_KIND, outcome, detail };
  try {
    await appendPrivateResult(ctx, journalPath, record);
  } catch (error) { return refuse(error); }
}

/** Journal-facing rendering: pseudonymized member keys and counts, never raw values. */
export function reconcileDetail(summary: ReconcileSummary, keys: readonly string[], reason?: string): JournalDetail {
  return {
    added: summary.added, changed: summary.changed, removed: summary.removed,
    unchanged: summary.unchanged, overlap: summary.overlap,
    keys: [...keys], ...(reason === undefined ? {} : { reason }),
  };
}
