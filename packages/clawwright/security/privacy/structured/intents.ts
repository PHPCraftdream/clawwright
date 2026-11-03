// Intent/result journal helpers: thin, sanitized record shapes over appendPrivateJournal,
// plus crash-gap detection — intents without a matching result are the pending set an
// idempotent retry decides over. All locking, atomic writes, rotation and secret refusal
// stay in journal.ts; nothing is duplicated here.

import type { Context } from "../../../core/context.ts";
import { appendPrivateJournal, readPrivateJournal, type PrivateJournalOptions } from "./journal.ts";
import { PrivateDataError, safeOperation, type JsonValue } from "./internal.ts";

export interface PrivateIntentRecord {
  readonly id: string;
  readonly kind: string;
  readonly detail?: { readonly [key: string]: JsonValue };
}

export interface PrivateResultRecord {
  readonly id: string;
  readonly kind: string;
  readonly outcome: "done" | "failed";
  readonly detail?: { readonly [key: string]: JsonValue };
}

function fields(record: PrivateIntentRecord | PrivateResultRecord): { id: string; kind: string; detail?: { [key: string]: JsonValue } } {
  const id = record.id;
  const kind = record.kind;
  const detail = record.detail === undefined ? undefined : { ...record.detail };
  return { id, kind, detail };
}

/** Appends `{ intent: { id, kind, detail? } }`; secret refusal and sanitization come from
 *  appendPrivateJournal itself. */
export async function appendPrivateIntent(
  ctx: Context,
  path: string,
  record: PrivateIntentRecord,
  options: PrivateJournalOptions = {},
): Promise<void> {
  const { id, kind, detail } = fields(record);
  return appendPrivateJournal(ctx, path, detail === undefined ? { intent: { id, kind } } : { intent: { id, kind, detail } }, options);
}

/** Appends `{ result: { id, kind, outcome, detail? } }` for `"done"` or `"failed"`. */
export async function appendPrivateResult(
  ctx: Context,
  path: string,
  record: PrivateResultRecord,
  options: PrivateJournalOptions = {},
): Promise<void> {
  const { id, kind, detail } = fields(record);
  if (record.outcome !== "done" && record.outcome !== "failed") throw new PrivateDataError("invalid");
  return appendPrivateJournal(
    ctx,
    path,
    detail === undefined ? { result: { id, kind, outcome: record.outcome } } : { result: { id, kind, outcome: record.outcome, detail } },
    options,
  );
}

/** Intents without any matching result, correlated by id across the newest-first journal
 *  (the crash gap). Duplicate intents count once; an intent with multiple results — of any
 *  outcome — is not pending. Malformed intent/result shapes are skipped silently. */
export async function readPendingPrivateIntents(
  ctx: Context,
  path: string,
  options: { readonly limit: number },
): Promise<{ ids: readonly string[]; truncated: boolean; corrupt: number }> {
  return safeOperation(async () => {
    const journal = await readPrivateJournal(ctx, path, options);
    const intents: string[] = [];
    const seen = new Set<string>();
    const resolved = new Set<string>();
    for (const record of journal.records) {
      const intent = record.intent;
      if (intent !== undefined && intent !== null && typeof intent === "object" && !Array.isArray(intent)) {
        const id = (intent as { id?: unknown }).id;
        if (typeof id === "string" && !seen.has(id)) {
          seen.add(id);
          intents.push(id);
        }
      }
      const result = record.result;
      if (result !== undefined && result !== null && typeof result === "object" && !Array.isArray(result)) {
        const id = (result as { id?: unknown }).id;
        if (typeof id === "string") resolved.add(id);
      }
    }
    return { ids: intents.filter((id) => !resolved.has(id)), truncated: journal.truncated, corrupt: journal.corrupt };
  });
}
