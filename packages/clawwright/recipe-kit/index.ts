/** Domain-agnostic, stdin-only recipe helpers. */
export { appCli, appConfigPatch } from "./app.ts";
export { consumerFetch } from "./consumer.ts";
export {
  reconcilePlanView, reconcileApply, appConfigAccessor, reconcilePendingIntents,
  checkProtectedPath, checkProtectedPlan,
  canonical, isReconcileValue,
  RECONCILE_LARGE_REMOVAL_CONSENT, RECONCILE_MAX_REMOVED_COUNT, RECONCILE_MAX_REMOVED_FRACTION,
  RECONCILE_PROTECTED_SEGMENTS,
  GUARD_NO_OWNERSHIP_SOURCE, GUARD_PATH_FOREIGN_OWNER, GUARD_PATH_PROTECTED, GUARD_PATH_UNOWNED,
  GUARD_VERIFY_MISMATCH,
} from "./reconcile/index.ts";
export type {
  ReconcileValue, ReconcileEntry, ReconcileKeyChange, ReconcileKeyRef,
  ReconcileSummary, ReconcilePlanInput, ReconcilePlanView, ReconcileViewEntry,
  ReconcilePlanViewOptions, ReconcilePathOwner,
  ReconcileAccessor, ReconcileJournal, ReconcileApplyOptions, ReconcileApplySource,
  ReconcileApplyResult,
} from "./reconcile/index.ts";
export { RecipeKitRefusal, DEFAULT_TIMEOUT_MS, DEFAULT_OUTPUT_BYTES_MAX, REQUEST_BYTES_MAX } from "./types.ts";
export type {
  RecipeKitReason, CommandResult, RecipeRunOptions, RecipeRuntime, RecipeContext,
  AppCliOptions, AppCliJsonOptions, AppCliJsonResult, ConfigPatchOptions,
  ConsumerRequest, ConsumerResponse,
} from "./types.ts";
