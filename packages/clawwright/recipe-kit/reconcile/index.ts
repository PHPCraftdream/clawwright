/** Reconcile primitive (U3): guarded apply, redacted plan views, provenance and journaling.
 *  The internal full-fidelity plan (raw keys and values) is deliberately not exported: no
 *  entry function can return it, callers see `reconcilePlanView`'s redacted view only. */
export { reconcilePlanView, isReconcileValue, canonical } from "./plan.ts";
export { reconcileApply, appConfigAccessor } from "./apply.ts";
export { checkProtectedPath, checkProtectedPlan } from "./guard.ts";
export { reconcilePendingIntents } from "./provenance.ts";
export {
  GUARD_NO_OWNERSHIP_SOURCE, GUARD_PATH_FOREIGN_OWNER, GUARD_PATH_PROTECTED, GUARD_PATH_UNOWNED,
  GUARD_VERIFY_MISMATCH,
  RECONCILE_LARGE_REMOVAL_CONSENT,
  RECONCILE_MAX_REMOVED_COUNT,
  RECONCILE_MAX_REMOVED_FRACTION,
  RECONCILE_PROTECTED_SEGMENTS,
  RECONCILE_INTENT_KIND,
  RECONCILE_STATE_VERSION,
} from "./types.ts";
export type {
  ReconcileValue, ReconcileEntry, ReconcileKeyChange, ReconcileKeyRef,
  ReconcileSummary, ReconcilePlanInput, ReconcilePlanView, ReconcileViewEntry,
  ReconcilePlanViewOptions, ReconcilePathOwner, ReconcileAccessor, ReconcileJournal,
  ReconcileApplyOptions, ReconcileApplySource, ReconcileApplyResult,
} from "./types.ts";
