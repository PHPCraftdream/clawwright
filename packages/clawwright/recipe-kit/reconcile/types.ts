/** Reconcile primitive types and bounds (U3): a domain-agnostic library for recipe hooks.
 *  Keys are stable strings, values are JSON-safe, paths are safe dot config paths. */
import type { Context } from "../../core/context.ts";
import type { RecipeKitReason } from "../types.ts";

export type ReconcileValue = null | boolean | number | string | ReconcileValue[] | { readonly [key: string]: ReconcileValue };
/** One desired member: stable key plus its JSON-safe value. */
export interface ReconcileEntry { readonly key: string; readonly value: ReconcileValue }
/** Added and changed members carry the value; removed and unchanged carry the key only. */
export interface ReconcileKeyChange { readonly key: string; readonly value: ReconcileValue }
export interface ReconcileKeyRef { readonly key: string }
export interface ReconcileSummary {
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly unchanged: number;
  readonly overlap: number;
}
/** Overlap: keys in the config and the desired set without recorded provenance — adoptable,
 *  never silently taken. They are not counted in added/changed/removed/unchanged.
 *  INTERNAL full-fidelity plan: added/changed carry raw values. Not exported from the
 *  recipe-kit entry — callers see `ReconcilePlanView`; apply consumes this internally. */
export interface ReconcilePlan {
  readonly added: readonly ReconcileKeyChange[];
  readonly changed: readonly ReconcileKeyChange[];
  readonly removed: readonly ReconcileKeyRef[];
  readonly unchanged: readonly ReconcileKeyRef[];
  readonly overlap: readonly ReconcileKeyRef[];
  readonly summary: ReconcileSummary;
}
export interface ReconcilePlanInput {
  readonly desired: readonly ReconcileEntry[];
  /** Current projection of the owned path: a plain JSON object or undefined. */
  readonly current: unknown;
  /** Member keys recorded by earlier reconciles of this path, in the SAME namespace as the
   *  current keys: apply translates identifying pseudonym tokens back to the raw keys they
   *  cover; direct plan callers pass plain (non-identifying) provenance. */
  readonly provenance?: readonly string[];
}
/** Structural subset of the `owns` catalog; a RecipePathOwner satisfies it. */
/** PUBLIC redacted view of a plan: pseudonym-or-index keys and, when a key is available,
 *  short KEYED value fingerprints — never a raw key or value, and never an unkeyed digest.
 *  Entry keys are pseudonym tokens when a pseudonym context is supplied, else stable
 *  per-plan `#<index>` markers. Fingerprints exist only when derived from a key (an explicit
 *  `fingerprintKey` or the deployment's pseudonym key): `fingerprint` is absent when no key
 *  is available, and the literal string `"unavailable"` on a read-only view whose key file
 *  does not exist. */
export interface ReconcileViewEntry { readonly key: string; readonly fingerprint?: string }
export interface ReconcilePlanView {
  readonly added: readonly ReconcileViewEntry[];
  readonly changed: readonly ReconcileViewEntry[];
  readonly removed: readonly ReconcileViewEntry[];
  readonly unchanged: readonly ReconcileViewEntry[];
  readonly overlap: readonly ReconcileViewEntry[];
  readonly summary: ReconcileSummary;
  /** True when the view's fingerprints are keyed (HMAC); false when no key was available
   *  (fingerprints absent or the read-only `"unavailable"` marker). */
  readonly keyed: boolean;
}
export interface ReconcilePlanViewOptions {
  /** Async pseudonymizer for entry keys (e.g. a privatePseudonym wrapper). */
  readonly pseudonymize?: (key: string) => Promise<string>;
  /** Supplies a keyed (HMAC) fingerprint; omit for the plain sha256 prefix. When a
   *  `pseudonym` context is supplied WITHOUT a fingerprintKey, the deployment's pseudonym
   *  key is used (keyed); if the key is unavailable the view refuses rather than falling
   *  back to the unkeyed digest. */
  readonly fingerprintKey?: string;
  /** Deployment pseudonym context (mirrors the journal's ctx/pseudonymDir fields): enables
   *  the keyed-by-deployment-key fingerprint path described above. */
  readonly pseudonym?: { readonly ctx: Context; readonly pseudonymDir: string };
  /** Read-only key handling (dry runs): the deployment key is only READ, never created;
   *  when absent, entry keys fall back to `#<index>` markers, fingerprints become the
   *  literal `"unavailable"`, and the view reports `keyed: false`. */
  readonly readOnlyKey?: boolean;
}
export interface ReconcilePathOwner {
  readonly recipe: string;
  readonly path: string;
  readonly mode: "value" | "list-member";
  readonly prefix: boolean;
}
/** Current-projection reads and single-batch writes; fakes implement this for checks. */
export interface ReconcileAccessor {
  read(): Promise<ReconcileValue | undefined>;
  patch(projection: Readonly<Record<string, ReconcileValue>>): Promise<void>;
}
/** Durable journal + provenance + pseudonym bundle. Apply refuses without one: a patch
 *  without a durable intent leaves an unauditable crash gap. All paths sit under the
 *  recipe's declared privatePaths; ctx is the full framework Context (structural). */
export interface ReconcileJournal {
  readonly ctx: Context;
  readonly journalPath: string;
  readonly statePath: string;
  readonly pseudonymDir: string;
  readonly recipe: string;
  readonly namespace: string;
  /** Identifying keys are always pseudonymized; false stores plain keys, allowed only for
   *  a namespace the recipe declares non-identifying. Default: pseudonymize. */
  readonly identifying?: boolean;
}
export interface ReconcileApplyOptions {
  /** The owned config dot path (declared via `owns`). */
  readonly path: string;
  /** The calling recipe's name; the owner of `path` must be this recipe. */
  readonly recipe: string;
  /** Either the joined `owns` catalog or a lookup; at least one must be supplied. */
  readonly owners?: readonly ReconcilePathOwner[];
  readonly ownerOf?: (path: string) => ReconcilePathOwner | undefined;
  /** Extends (never shrinks) the built-in protected segment list. */
  readonly protectedPaths?: readonly string[];
  readonly journal: ReconcileJournal;
  /** Defaults to appConfigAccessor(ctx, path); supply a fake in checks. */
  readonly accessor?: ReconcileAccessor;
  /** Read-only source of the desired set; a throw or an undefined result refuses with
   *  `guard` (fail-closed) and applies nothing. */
  readonly readDesired?: () => Promise<readonly ReconcileEntry[] | undefined>;
  /** Extra caller-supplied desired-set validation, run before planning. */
  readonly validateDesired?: (value: unknown) => boolean;
  readonly maxRemovedCount?: number;
  readonly maxRemovedFraction?: number;
  /** Only the exported RECONCILE_LARGE_REMOVAL_CONSENT token lifts the bounds. */
  readonly largeRemovalConsent?: symbol;
  /** Record provenance for overlap keys, adopting operator-added entries the desired set
   *  also wants. Without it they are reported and left alone. */
  readonly adoptOverlaps?: boolean;
  /** Free-text reason recorded in the journal detail; sanitized like any detail string. */
  readonly reason?: string;
}
/** A precomputed plan or the raw desired entries; apply always recomputes against the
 *  current projection, never replays a stored plan after a crash gap. */
export type ReconcileApplySource = ReconcilePlan | readonly ReconcileEntry[];
/** Stable outcome of a reconcile apply. Expected failures return a result instead of
 *  throwing; `RecipeKitRefusal` is reserved for programmer errors (invalid options/paths). */
export type ReconcileApplyStatus = "applied" | "no-op" | "dry-run" | "refused" | "failed";
export interface ReconcileApplyResult {
  /** "applied": the batch patch landed and verified. "no-op": nothing to do. "dry-run":
   *  planned and guarded only. "refused": a guard (ownership, protected path, removal
   *  bounds/consent, pending intent) stopped it before any write. "failed": a source,
   *  transport or verification failure after guarding. */
  readonly status: ReconcileApplyStatus;
  /** Compatibility shorthand: true for "applied"/"no-op"/"dry-run", false otherwise. */
  readonly ok: boolean;
  /** Compatibility shorthand: true exactly when status is "applied". */
  readonly applied: boolean;
  /** Compatibility shorthand: true exactly when status is "dry-run". */
  readonly dryRun?: boolean;
  /** Content-free reason code for non-success outcomes ("guard" for refusals and
   *  verification mismatch, "transport" for read/patch transport failures). */
  readonly reason?: RecipeKitReason;
  /** Structured detail for guard refusals (e.g. GUARD_VERIFY_MISMATCH) or removal-bound
   *  counts — content-free by contract. */
  readonly detail?: string;
  readonly info?: Record<string, number>;
  readonly summary: ReconcileSummary;
  readonly pendingIntents: number;
  /** Crash-recovery outcome on the dry-run and no-op paths: counts only, never keys. */
  readonly recovery?: { readonly promoted: number; readonly dropped: number };
  /** Redacted plan view (pseudonym-or-index keys, keyed fingerprints or the read-only
   *  marker, counts) of the plan computed for this run. Present for EVERY outcome once a
   *  plan existed — including refused and failed outcomes (the verification mismatch
   *  carries the already-computed view). Absent ONLY when no plan ever existed: a source
   *  failure or guard refusal before planning. */
  readonly view?: ReconcilePlanView;
}
/** Distinct from, and not derivable from, the MCP `confirm` token: an unexportable symbol. */
export const RECONCILE_LARGE_REMOVAL_CONSENT: unique symbol = Symbol("clawwright.reconcile.large-removal-consent.v1");
/** Absolute removal bound; both bounds must hold unless the consent token is passed. */
export const RECONCILE_MAX_REMOVED_COUNT = 100;
/** Fraction-of-current-members removal bound. */
export const RECONCILE_MAX_REMOVED_FRACTION = 0.5;
/** Built-in protected path segments, generic by design (owner/approver/credential lists).
 *  Callers may extend via options.protectedPaths; the union can never shrink. Frozen so
 *  runtime mutation cannot change enforcement. */
export const RECONCILE_PROTECTED_SEGMENTS: readonly string[] = Object.freeze(["owners", "approvers", "credentials"] as const);
/** Guard refusal details, exported so checks compare the structured field instead of prose. */
export const GUARD_PATH_PROTECTED = "path is protected";
export const GUARD_NO_OWNERSHIP_SOURCE = "no ownership source supplied";
export const GUARD_PATH_UNOWNED = "path is not owned by any recipe";
export const GUARD_PATH_FOREIGN_OWNER = "path is owned by another recipe";
export const GUARD_VERIFY_MISMATCH = "re-read does not match the intended projection";
/** Journal intent/result kind and private-state version markers. */
export const RECONCILE_INTENT_KIND = "reconcile";
/** v2: the state carries {keys, pending} for two-phase (crash-safe) provenance. */
export const RECONCILE_STATE_VERSION = 2;
