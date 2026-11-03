// `clawwright apply` — run the plan, then check the result.
//
// "Applied" and "working" are different claims. Every step returning successfully doesn't
// mean the instance is healthy, so this command inspects again afterwards and reports what
// it found — the answer is about the instance, not about the steps.
//
// Refuses a plan whose declaration changed while it was being read: doesn't stop two people
// applying at once, but stops applying steps chosen for a different repository version.

import { log, info, warn, die } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { computePlan, printPlanActions } from "./plan.ts";
import { gatherInspection } from "./inspect/gather.ts";
import { currentComposition, declarationChecksum, frameworkVersion } from "#src/commands/management/lock.ts";
import { isHealthy, nextActions, nextAdvice, PROBLEM_CODES } from "#src/service/inspection.ts";
import { applyConfig } from "./config.ts";
import { secrets } from "#src/commands/management/configuration/secrets.ts";
import { up, restart } from "#src/commands/lifecycle/instance/control.ts";
import { provisionAgent, removeOwnedObject } from "#src/commands/management/provision-agent/index.ts";
import { recoverEnv } from "#src/commands/operate/recover-env/index.ts";
import { readLedgerStrict } from "#src/set/ownership/ledger.ts";
import type { OwnedKind } from "#src/set/ownership/ledger.ts";
import { Journal, snapshotConfig, newOperationId } from "#src/service/operations.ts";
import type { StepStatus } from "#src/service/operations.ts";
import { runOwning, takeLock, withLockUnlessHeld } from "#src/runtime/lock/instance-lock.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { withSetSource } from "#src/set/artifacts/source.ts";
import { withUnpackedArtifact, recordInstalledSet, storeArtifactForRollback, requirementProblems, runningImageDigest, readInstalledSetStrict } from "#src/set/artifacts/install.ts";
import type { VerifiedArtifact } from "#src/set/artifacts/install.ts";
import type { PlanAction, Plan } from "./plan.ts";
import type { Context } from "#src/core/context.ts";
import { refreshContext } from "#src/core/context.ts";
import type { Advice } from "#src/core/io/invocation/advice.ts";
import type { ArgumentSpec } from "#src/core/command/spec.ts";
import { commandBody, runOnContext } from "#src/core/command/index.ts";
import { LOCK_TAKEOVER_ARGUMENTS, takeoverOf } from "#src/commands/interface/groups/shared-arguments.ts";
import * as kinds from "#src/core/values/kinds.ts";
import type { Checksum, LocalArtifact } from "#src/core/values/plan.ts";

// The --set artifact: the same kind object prepare derives through, so the plan carries the
// resolve's LocalArtifact and the run never sees an unresolved path.
const SET_ARTIFACT = kinds.localFile("a set artifact path");

export const APPLY_ARGUMENTS = [
  { name: "set", description: "Install a built set", kind: "option", valueName: "artifact", value: SET_ARTIFACT },
  { name: "expect", description: "Plan checksum", kind: "option", valueName: "checksum", value: kinds.checksum("hex64", { expected: "a declaration checksum", invalid: () => "takes a declaration checksum — 64 hexadecimal digits", example: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" }) },
  { name: "dry-run", description: "Show the steps only", kind: "flag", effect: "read" },
  ...LOCK_TAKEOVER_ARGUMENTS,
  { name: "json", description: "Outcome as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

/** Whether the container is running but its image could not be resolved to any digest at
 *  all. requirementProblems() treats an undefined imageDigest as "nothing to compare, no
 *  problem" (right for inspect's informational reporting) but wrong for deciding whether
 *  to RECORD a set as installed: that needs proof of a match, not absence of a mismatch. */
export async function runningImageUnconfirmed(ctx: Context): Promise<boolean> {
  const running = await ctx.runtime.runningImageIdentity?.();
  // Both shapes of "cannot determine anything" refuse recording: no identity at all, and
  // an identity with no digests — checking only the latter let an unknown image pass as confirmed.
  return running === undefined || running.digests.length === 0;
}

/** Strict control-marker preflight for `--set`, under the instance lock before the first
 *  live mutation: a corrupt installed-set marker or ownership ledger refuses the whole
 *  install while the target is still untouched, rather than failing after the rollback
 *  artifact is stored and steps/provisioning have already run. */
export async function preflightControlMarkers(ctx: Context): Promise<void> {
  await readInstalledSetStrict(ctx);
  await readLedgerStrict(ctx);
}

/** How each executable step is actually performed. Called directly rather than shelling
 *  out to `clawwright`: the step already knows which function it means, and going back
 *  out through the dispatcher would lose the Context, the output sink and the error. */
const RUNNERS: Record<string, (ctx: Context, action: PlanAction) => Promise<void>> = {
  // Recovery steps write only the operator side (.env, local store, declaration) — nothing
  // the instance lock serializes — so their runners call lockless modes directly, riding
  // along under apply's own run-level lock. Bare recover-env is the safe form: it fills
  // missing connection facts and never overwrites a value both sides carry.
  "recover-env": (ctx) => recoverEnv(ctx, []),
  secrets: (ctx) => secrets(ctx, ["--apply"]),
  // restartAdvice: false — planActions() always schedules this alongside "up"/"restart" in
  // the same plan, so the default "restart to pick it up" advice would be self-contradicting.
  "apply-config": (ctx) => applyConfig(ctx, [], { restartAdvice: false }),
  // Planned advisory (see planActions), with a runner anyway: if a future plan ever emits it
  // as executable it must fail loudly at the --force refusal, never fall out as "no runner".
  "secrets-dump": (ctx) => secrets(ctx, ["--dump"]),
  "apply-config-dump": (ctx) => applyConfig(ctx, ["--dump"]),
  up: (ctx) => up(ctx, []),
  restart: (ctx) => restart(ctx, []),
};

/** Steps that rewrite the deployment's .env, the file every other step's Context was built
 *  from. After either succeeds, the rest of the run re-derives its Context from disk — or
 *  stops if the target's own coordinates moved, since the lock was taken for the old target. */
const REDERIVES_CONTEXT = new Set(["recover-env", "secrets"]);

/** Exported so checks can assert every executable step a plan can emit has one — the gap
 *  would otherwise surface as a failed run in production, not a failing check. */
export function runnerFor(action: PlanAction): ((ctx: Context, action: PlanAction) => Promise<void>) | undefined {
  if (action.id.startsWith("provision-agent:")) {
    const recipe = action.id.slice("provision-agent:".length);
    return (ctx) => provisionAgent(ctx, [recipe]);
  }
  if (action.id.startsWith("remove-owned:")) {
    // "remove-owned:<kind>:<name>" — the agent case never reaches here: planActions marks
    // it advisory, and runSteps skips advisory actions before asking for a runner.
    const rest = action.id.slice("remove-owned:".length);
    const separator = rest.indexOf(":");
    const kind = rest.slice(0, separator) as OwnedKind;
    const name = rest.slice(separator + 1);
    return (ctx) => removeOwnedObject(ctx, kind, name);
  }
  return RUNNERS[action.id];
}

export interface StepOutcome {
  readonly id: string;
  readonly status: StepStatus;
  readonly detail?: string;
}

export interface ApplyOutcome {
  readonly deployment: string;
  /** The journal entry this run wrote — the same id the configuration snapshot and the MCP
   *  result carry, so "what happened in that operation" has one answer. */
  readonly operationId: string;
  readonly changed: boolean;
  readonly healthy: boolean;
  readonly steps: StepOutcome[];
  readonly problems: readonly { readonly code: string; readonly detail: string }[];
  readonly nextActions: string[];
  /** The same remedies as structured advice, index-aligned with nextActions. */
  readonly next: Advice[];
}

/** Thrown by runSteps when a step moved the deployment target itself (dataDir, port, ...):
 *  the remaining steps were planned for the previous target and the lock covers only the old
 *  coordinates. The run stops safely (outcomes stay in the journal); a fresh apply re-plans
 *  against the refreshed .env. */
export class TargetChangedError extends Error {
  readonly stepId: string;
  readonly changes: readonly string[];
  readonly outcomes: StepOutcome[];

  constructor(stepId: string, changes: readonly string[], outcomes: StepOutcome[]) {
    super(
      `step "${stepId}" changed the deployment target (${changes.join(", ")}) — the remaining steps were planned for the previous target.\n` +
        `Re-run ${commandLine("apply")}: it re-plans against the refreshed .env and takes the lock for the new coordinates.`,
    );
    this.name = "TargetChangedError";
    this.stepId = stepId;
    this.changes = changes;
    this.outcomes = outcomes;
  }
}

/** Everything the run needs, decided from the arguments alone in the prepare stage. */
interface ApplyPlan {
  readonly set?: LocalArtifact;
  readonly expect?: Checksum;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly takeover: { readonly breakLock: boolean; readonly breakForeignLockHost?: string };
}

export const APPLY = commandBody({
  effect: "destroy",
  arguments: APPLY_ARGUMENTS,
  prepare: async (call) => ({
    // The resolved set artifact and checksum arrive in the plan's own key slots: the
    // pipeline resolved each bound value through its declared kind (S2.5).
    set: call.values.set,
    expect: call.values.expect,
    dryRun: call.values["dry-run"],
    json: call.values.json,
    takeover: takeoverOf(call.values),
  } satisfies ApplyPlan),
  run: (ctx, plan) => applyPlan(ctx, plan),
});

/** The full-context entry for callers outside this group (the set lifecycle checks): the
 *  same declaration, parsed and run on a context they already hold. */
export const apply = (ctx: Context, args: string[]): Promise<void> => runOnContext(APPLY, ctx, args);

async function applyPlan(ctx: Context, plan: ApplyPlan): Promise<void> {
  const { set: artifact } = plan;
  if (artifact === undefined) {
    await applyFromSource(ctx, plan);
    return;
  }

  await withUnpackedArtifact(artifact, (staging, verified) =>
    withSetSource(staging, () => applySetArtifact(ctx, plan, artifact, verified)),
  plan.dryRun ? `checking ${artifact}` : `installing from ${artifact}`);
}

/** The --set flow once the artifact is unpacked and its recipe files are the active source. */
async function applySetArtifact(ctx: Context, plan: ApplyPlan, artifact: LocalArtifact, verified: VerifiedArtifact): Promise<void> {
  if (plan.dryRun) {
    await applyFromSource(ctx, plan);
    return;
  }

  // Refused before anything is touched: up/restart start whatever this deployment's OWN
  // .env already names, since applying this artifact never pulls or switches images.
  // Recording the set as installed while the runtime runs a different image would be
  // false, not merely optimistic — same check as inspect's SET_REQUIREMENT_UNMET.
  const framework = await frameworkVersion();
  await refuseUnmetRequirements(ctx, verified, framework);

  const operationId = newOperationId("apply");
  // Nesting-safe: a caller (rollback --previous-set) already holding the lock must not have
  // this acquire refuse itself as "another operation changing this instance".
  await withLockUnlessHeld(ctx, "apply set", operationId, { breakLock: plan.takeover.breakLock, breakForeignLockHost: plan.takeover.breakForeignLockHost }, () =>
    installSetUnderLock(ctx, plan, artifact, verified, framework, operationId),
  );
}

/** Runs the executable steps in order, stopping at the first failure — steps depend on each
 *  other, so reporting later ones successful after an earlier failure would describe an
 *  instance nobody has. What didn't run is still reported, as advisory or blocked. */
export async function runSteps(
  ctx: Context,
  actions: readonly PlanAction[],
  journal?: Journal,
  scope: { current: Context } = { current: ctx },
): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  let stopped = false;

  const record = async (outcome: StepOutcome): Promise<void> => {
    outcomes.push(outcome);
    // Written as each step finishes, not once at the end: a run killed mid-way is exactly
    // the case the journal exists for.
    await journal?.step(outcome.id, outcome.status, outcome.detail);
  };

  for (const [index, action] of actions.entries()) {
    if (action.advisory === true) {
      await record({ id: action.id, status: "advisory", detail: "advisory: for you to do, not this command" });
      continue;
    }
    if (stopped) {
      await record({ id: action.id, status: "blocked", detail: "an earlier step failed" });
      continue;
    }

    const runner = runnerFor(action);
    if (runner === undefined) {
      // Plan and runner table drifting apart, an implementation gap. Treated as a failure:
      // steps after it were ordered around one that can't run.
      stopped = true;
      await record({ id: action.id, status: "failed", detail: "no runner for this step" });
      continue;
    }

    log(`step: ${action.summary}`);
    try {
      await runner(scope.current, action);
      await record({ id: action.id, status: "done" });
      if (REDERIVES_CONTEXT.has(action.id)) {
        const refresh = await refreshContext(scope.current);
        if (refresh !== undefined) {
          if (refresh.targetChanges.length > 0) {
            // Target moved. Everything queued was planned for the previous target and the
            // lock covers the old coordinates, so nothing after this step runs; each
            // remaining step is recorded with why, and applyFromSource turns this into a
            // reported failure pointing at a fresh apply.
            for (const later of actions.slice(index + 1)) {
              if (later.advisory === true) {
                await record({ id: later.id, status: "advisory", detail: "advisory: for you to do, not this command" });
              } else {
                await record({
                  id: later.id,
                  status: "blocked",
                  detail: `the deployment target changed (${refresh.targetChanges.join(", ")}) — re-run ${commandLine("apply")} against the refreshed .env`,
                });
              }
            }
            throw new TargetChangedError(action.id, refresh.targetChanges, outcomes);
          }
          if (refresh.changed.length > 0) {
            // Same target, new values: later steps (up/restart included) must interpolate
            // what is on disk now, not the snapshot this run started from.
            scope.current = refresh.context;
            info(`.env changed during this run (${refresh.changed.join(", ")}) — the remaining steps continue against the refreshed context`);
          }
        }
      }
    } catch (error) {
      // Not a step failure: must reach applyFromSource as-is, or the run would close its
      // journal as an ordinary failed step instead of pointing at a fresh apply.
      if (error instanceof TargetChangedError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      await record({ id: action.id, status: "failed", detail });
      stopped = true;
    }
  }

  return outcomes;
}

/** Refused before anything is touched — see applySetArtifact's own comment for why. */
async function refuseUnmetRequirements(ctx: Context, verified: VerifiedArtifact, framework: string | undefined): Promise<void> {
  const requirementIssues = requirementProblems(verified.manifest, {
    framework,
    imageDigest: await runningImageDigest(ctx, verified.manifest),
  });
  if (requirementIssues.length > 0) {
    die(
      `this set cannot be installed here:\n${requirementIssues.map((entry) => `  ${entry.detail}`).join("\n")}\n` +
        "Point this deployment's OPENCLAW_IMAGE at the required digest (or update the framework) before applying it.",
    );
  }
}

/** Everything --set does once the instance lock is held: run the steps, record a no-op
 *  operation if nothing ran, confirm the result matches, then record the set as installed. */
async function installSetUnderLock(
  ctx: Context,
  plan: ApplyPlan,
  artifact: LocalArtifact,
  verified: VerifiedArtifact,
  framework: string | undefined,
  operationId: string,
): Promise<void> {
  // First thing under the lock, before storeArtifactForRollback: a corrupt control marker
  // must stop the run here, not after the instance has already changed.
  await preflightControlMarkers(ctx);
  refuseUnreliableCliRead(await computePlan(ctx));
  await storeArtifactForRollback(artifact, verified);
  const ranSteps = await applyFromSource(ctx, plan, operationId);

  // applyFromSource's "nothing to apply" fast path never opens a Journal or takes a
  // snapshot for operationId. But recordInstalledSet() below writes
  // installed.operationId = operationId regardless, and rollback --previous-set reads that
  // field to find its snapshot — so a no-op set transition still needs a recorded
  // operation to point at. Decided from applyFromSource()'s own report of whether it ran
  // anything, not by probing readOperation() afterward, which would re-open a fresh
  // Journal and take a snapshot of the config AFTER the real steps changed it.
  if (!ranSteps) {
    const noopJournal = await Journal.open(ctx, "apply", deploymentName(), operationId);
    const snapshot = await snapshotConfig(ctx, operationId);
    if (snapshot !== undefined) await noopJournal.noteSnapshot(snapshot);
    await noopJournal.close("succeeded", "no executable steps — the live configuration already matched this set");
  }

  // Checked again now that up/restart have run: the pre-check only proves the instance
  // was NOT already wrong, not that this apply brought it into line. Not recorded as
  // installed over an instance this apply can't show actually matches it.
  await refuseUnconfirmedResult(ctx, verified, framework);

  await recordInstalledSet(ctx, verified.manifest, verified.id, operationId);
}

/** Whether the post-run inspection still proves this set does not match — either a real
 *  mismatch, or no proof at all that it matches (an unresolved running image). */
async function refuseUnconfirmedResult(ctx: Context, verified: VerifiedArtifact, framework: string | undefined): Promise<void> {
  const afterIssues = requirementProblems(verified.manifest, {
    framework,
    imageDigest: await runningImageDigest(ctx, verified.manifest),
  });
  // An undefined imageDigest means nothing to compare against, which isn't good enough
  // here: recording installed is a claim of proof, and an unresolvable digest is as
  // unproven as a wrong one.
  const unconfirmed = await runningImageUnconfirmed(ctx);
  if (afterIssues.length > 0 || unconfirmed) {
    die(
      unconfirmed && afterIssues.length === 0
        ? "apply finished, but this instance's running image could not be resolved to any digest — " +
          "there is no proof it matches what this set requires. The set is NOT recorded as installed."
        : `apply finished, but the running instance still does not match what this set requires:\n` +
          `${afterIssues.map((entry) => `  ${entry.detail}`).join("\n")}\n` +
          "The set is NOT recorded as installed.",
    );
  }
}

/** Returns whether it actually ran executable steps, as opposed to a dry run or the
 *  "nothing to apply" fast path — what applyPlan's --set branch needs to decide
 *  whether a no-op transition still needs a snapshot taken on its behalf. */
async function applyFromSource(ctx: Context, plan: ApplyPlan, heldOperationId?: string): Promise<boolean> {
  const jsonOnly = plan.json;
  const dryRun = plan.dryRun;
  const expected = plan.expect;

  const computed = await computePlan(ctx);
  refuseStaleDeclaration(expected, computed);

  if (dryRun) {
    // Same renderer as `plan`, so the two never disagree.
    emitOrPrint(jsonOnly, computed, () => {
      printPlanActions(computed.actions);
      log("dry run — nothing was applied");
    });
    return false;
  }

  refuseUnreliableCliRead(computed);

  const executable = computed.actions.filter((action) => action.advisory !== true);
  if (executable.length === 0) {
    await reportNoExecutableActions(ctx, jsonOnly, computed);
    return false;
  }

  await runPlan(ctx, plan, jsonOnly, computed, heldOperationId);
  return true;
}

/** Never enact a plan based on an unconfirmed live registration read. */
export function refuseUnreliableCliRead(plan: Pick<Plan, "problems">): void {
  const failed = plan.problems.filter((entry) => entry.code === "CLI_READ_FAILED");
  if (failed.length > 0) {
    die(`apply stopped before changes: ${failed.map((entry) => entry.detail).join("; ")}. Retry ${commandLine("inspect")}`);
  }
}

/** The declaration a caller planned against, if it named one. Checked before any step runs:
 *  the value of the refusal is entirely in it happening first. */
function refuseStaleDeclaration(expected: Checksum | undefined, plan: Plan): void {
  if (expected !== undefined && expected !== plan.declarationChecksum) {
    die(
      "the declaration changed after that plan was computed — the steps in it were chosen " +
        "for a different version of this repository.\n" +
        `planned against ${expected}, now ${plan.declarationChecksum}\n` +
        `Look at the current one and apply that: ${commandLine("plan")}`,
    );
  }
}

/** Nothing to record: writing a journal entry for every no-op apply would bury the runs
 *  that did something. Still ends like a run that did work, though — failOnRemainder still
 *  runs, since success must mean a healthy gateway. */
async function reportNoExecutableActions(ctx: Context, jsonOnly: boolean, plan: Plan): Promise<void> {
  const outcome = await confirm(
    ctx,
    plan,
    plan.actions.map((action) => ({ id: action.id, status: "advisory" as const, detail: "advisory" })),
    false,
    "(none)",
  );
  report(jsonOnly, outcome, "nothing to apply");
  failOnRemainder(blockingRemainder(outcome.problems), outcome);
}

/** Takes the run-level lock (unless a caller already holds it), executes the plan under it,
 *  reports the result and throws for whichever way the run did not fully succeed. */
async function runPlan(ctx: Context, requested: ApplyPlan, jsonOnly: boolean, plan: Plan, heldOperationId?: string): Promise<void> {
  const { breakLock, breakForeignLockHost } = requested.takeover;

  // Lock first, journal only once held: a run refused here never started, and a journal
  // entry with no outcome should mean "began and we don't know how it ended", not "refused".
  //
  // Held for the whole run, not per step: what this prevents happens between steps — one
  // run restarting the instance while another is halfway through provisioning against it.
  const operationId = heldOperationId ?? newOperationId("apply");
  const held = heldOperationId === undefined ? await takeLock(ctx, "apply", operationId, { breakLock, breakForeignLockHost }) : undefined;

  let run: PlanRun;
  try {
    run = await runOwning(held, () => executePlan(ctx, plan, operationId));
  } finally {
    await held?.release();
  }

  report(jsonOnly, run.outcome, undefined);
  throwOnRunFailure(run);
  failOnRemainder(run.remaining, run.outcome);
}

/** What one held-lock execution of the plan produced — passed back to runPlan rather than
 *  captured in its closure, so executePlan is checkable on its own. */
interface PlanRun {
  readonly journal: Journal;
  readonly outcome: ApplyOutcome;
  readonly failedStep: StepOutcome | undefined;
  readonly targetChange: TargetChangedError | undefined;
  readonly snapshot: string | undefined;
  readonly remaining: readonly { readonly code: string; readonly detail: string }[];
}

/** Runs the plan's steps under the already-held lock, confirms the result and closes the
 *  journal. The one place that decides "succeeded" vs "failed" for the record. */
async function executePlan(ctx: Context, plan: Plan, operationId: string): Promise<PlanRun> {
  if (declarationChecksum(await currentComposition(ctx)) !== plan.declarationChecksum) {
    die("the declaration changed while preparing this apply — compute a new plan");
  }
  const journal = await Journal.open(ctx, "apply", plan.deployment, operationId);
  // Before the first mutating step: a copy taken afterwards would be a copy of the damage.
  const snapshot = await snapshotConfig(ctx, journal.id);
  if (snapshot !== undefined) await journal.noteSnapshot(snapshot);

  // One holder for the whole run: steps that rewrite .env re-derive the context, and every
  // later step (and the confirming inspection) sees what is on disk now.
  const scope: { current: Context } = { current: ctx };
  let steps: StepOutcome[];
  let targetChange: TargetChangedError | undefined;
  try {
    steps = await runSteps(ctx, plan.actions, journal, scope);
  } catch (error) {
    if (!(error instanceof TargetChangedError)) throw error;
    targetChange = error;
    steps = targetChange.outcomes;
  }
  const failedStep = steps.find((step) => step.status === "failed");
  const outcome = await confirm(scope.current, plan, steps, steps.some((step) => step.status === "done"), journal.id);

  // Every step succeeding isn't the claim this command makes: the confirming inspection
  // has the last word, so a run ending with something blocking is a failed run regardless
  // of what its steps returned.
  const remaining = blockingRemainder(outcome.problems);

  await journal.close(
    failedStep === undefined && targetChange === undefined && remaining.length === 0 ? "succeeded" : "failed",
    failedStep !== undefined
      ? `stopped at "${failedStep.id}": ${failedStep.detail ?? "no detail"}`
      : targetChange !== undefined
        ? `stopped after "${targetChange.stepId}": the deployment target changed (${targetChange.changes.join(", ")})`
        : remaining.length === 0
          ? undefined
          : `every step ran, but the instance still reports ${remaining.map((entry) => entry.code).join(", ")}`,
  );

  return { journal, outcome, failedStep, targetChange, snapshot, remaining };
}

/** The two ways a completed run still throws — moved target or failed step — checked in
 *  that order: a target change makes the remaining "blocked" statuses the point. */
function throwOnRunFailure(run: PlanRun): void {
  if (run.targetChange !== undefined) {
    throw new Error(
      `${run.targetChange.message}\n` +
        `What ran, and what did not: ${commandLine(["operations", run.journal.id])}`,
    );
  }

  if (run.failedStep !== undefined) {
    throw new Error(
      `step "${run.failedStep.id}" failed: ${run.failedStep.detail ?? "no detail"}\n` +
        `The instance is left as that step found it. What ran, and what did not: ` +
        `${commandLine(["operations", run.journal.id])}\n` +
        (run.snapshot === undefined
          ? "No configuration snapshot was taken, so there is nothing to roll back to."
          : `Put the previous configuration back: ${commandLine(["rollback", "--operation", run.journal.id])}`),
    );
  }
}

/** The one place both paths end. A run that leaves the instance not doing its job is a
 *  failed run whether it executed ten steps or none — "applied" vs "working". */
function failOnRemainder(
  remaining: readonly { readonly code: string; readonly detail: string }[],
  outcome: ApplyOutcome,
): void {
  if (remaining.length === 0) return;
  throw new Error(
    `the instance is not what this repository declares: ${remaining.map((entry) => entry.code).join(", ")}\n` +
      `${remaining.map((entry) => `  ${entry.code}  ${entry.detail}`).join("\n")}\n` +
      `Next: ${outcome.nextActions.join(", ")}`,
  );
}

/** Which codes mean "not doing its job", derived from PROBLEM_CODES rather than duplicated. */
const BLOCKING = new Set(
  Object.entries(PROBLEM_CODES)
    .filter(([, meaning]) => meaning.severity === "blocking")
    .map(([code]) => code),
);

/** What the confirming inspection found that still means the instance is not what the
 *  repository declares. Exported so the rule can be checked on its own, without needing a
 *  planner, an inspector and a target to reach it through apply(). */
export function blockingRemainder(
  problems: readonly { readonly code: string; readonly detail: string }[],
): readonly { readonly code: string; readonly detail: string }[] {
  return problems.filter((entry) => BLOCKING.has(entry.code));
}

/** The stronger claim: inspect again and report what the instance actually is now. */
async function confirm(ctx: Context, plan: Plan, steps: StepOutcome[], changed: boolean, operationId: string): Promise<ApplyOutcome> {
  const after = await gatherInspection(ctx);
  return {
    deployment: plan.deployment,
    operationId,
    changed,
    healthy: isHealthy(after),
    steps,
    problems: after.problems.map((entry) => ({ code: entry.code, detail: entry.detail })),
    nextActions: nextActions(after.problems),
    next: nextAdvice(after.problems),
  };
}

function emitOrPrint(jsonOnly: boolean, payload: unknown, print: () => void): void {
  if (jsonOnly || isCaptured()) {
    emit(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  print();
}

function report(jsonOnly: boolean, outcome: ApplyOutcome, headline: string | undefined): void {
  emitOrPrint(jsonOnly, outcome, () => {
    if (headline !== undefined) log(`${outcome.deployment}: ${headline}`);
    for (const step of outcome.steps) {
      if (step.status === "done") info(`done     ${step.id}`);
      else if (step.status === "failed") warn(`failed   ${step.id}: ${step.detail ?? ""}`);
      else info(`${step.status.padEnd(8)} ${step.id}${step.detail === undefined ? "" : ` (${step.detail})`}`);
    }

    // What the instance is now, not what the steps returned.
    if (outcome.healthy && outcome.problems.length === 0) {
      log(`${outcome.deployment} is what this repository declares`);
      return;
    }
    log(`${outcome.problems.length} problem(s) remain`);
    for (const entry of outcome.problems) warn(`${entry.code}  ${entry.detail}`);
    if (outcome.nextActions.length > 0) info(`next: ${outcome.nextActions.join(", ")}`);
  });
}
