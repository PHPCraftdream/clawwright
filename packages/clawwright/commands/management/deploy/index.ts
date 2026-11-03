// `clawwright deploy user@host` — puts this repository on a server and brings the instance up.
//
// Two deliveries: the framework (code, mirrored with deletions) and the deployment
// (configuration, only its non-secret parts). rsync and ssh run on the target side.
//
// Phases, in order: resolve arguments (arguments.ts) → refuse if any tree carries private
// bytes (refusals.ts) → prove the target is reachable and equipped (server.ts) → prove the
// remote root is safe for --delete (server.ts) → mirror both trees (sync.ts) → bootstrap or
// report (sync.ts). Each phase mutates nothing the phase before it didn't already allow.
//
// npm distribution: this command is monorepo-specific, mirroring the whole checkout over
// rsync — it deliberately uses `monorepoRoot`, not `frameworkRoot` (see
// frameworkSourceRoot below): installed as a package, monorepoRoot would resolve to an
// unrelated directory and mirroring it with --delete would be dangerous.

import { log, info, UserError } from "#src/core/io/log.ts";
import { emit, withOutputSink } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import { commandBody, runOnContext } from "#src/core/command/index.ts";
import type { DeployPlan, DeployPrepared } from "./arguments.ts";
import { deriveDeployLocalFacts, resolveDeployArguments, DEPLOY_ARGUMENTS } from "./arguments.ts";
import { assertDeployable } from "./refusals.ts";
import { checkServerReady, prepareRemoteRoot } from "./server.ts";
import { syncTrees, bootstrapAndReport, bootstrapRemoteLine } from "./sync.ts";

export { DEPLOY_ARGUMENTS, frameworkSourceRoot, recipesRelocation } from "./arguments.ts";
export { runRemote } from "./server.ts";
export {
  collectSensitiveCheckoutNames,
  rootProbeScript,
  parseRootProbe,
  markerWriteScript,
  markerVerifyScript,
} from "#src/security/privacy/deploy-boundary.ts";

/** `--dry-run`: the local refusal check plus the same reachability/tool check a real deploy
 *  runs BEFORE its first mutation — nothing past that runs, since preparing the remote root
 *  is itself a write. Doesn't cover whether the root is safe for --delete or the exact
 *  file-level diff rsync would produce. */
async function deployDryRun(ctx: Context, plan: DeployPlan): Promise<void> {
  await checkServerReady(ctx, plan.target);

  const report = {
    ok: true,
    changed: false,
    dryRun: true,
    target: plan.target,
    remotePath: plan.remotePath,
    remoteApp: plan.remoteApp,
    remoteRecipes: plan.remoteRecipes,
    wouldRunBootstrap: plan.runBootstrap,
    wouldSync: [
      "framework (full mirror, --delete, credentials excluded)",
      `${plan.name} deployment (declaration, desired state, recipes) -> ${plan.remoteApp}`,
    ],
    refusals: [] as string[],
  };

  if (plan.jsonOnly) {
    emit(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  log(`deploy --dry-run: would mirror the framework and the "${plan.name}" deployment to ${plan.target}:${plan.remotePath}`);
  info("connection and remote dependencies: checked, OK");
  info("framework mirror: --delete, credentials excluded (.env, apps/, data/, snapshots/, secrets/)");
  info(`deployment mirror: declaration, desired state, recipes -> ${plan.remoteApp}`);
  if (plan.runBootstrap) info(`would bootstrap remotely afterwards: ${bootstrapRemoteLine(plan.remotePath, plan.name)}`);
  else info("bootstrap skipped (--no-bootstrap)");
  if (plan.remotePathNote !== undefined) info(plan.remotePathNote);
  info(
    "does not cover: whether the remote root is safe for --delete (proving that writes a marker there) " +
      "or the exact file-level diff rsync would produce — both only happen during a real deploy",
  );
}

/** The command body; deploy(ctx, args) stays for callers that already hold a Context. */
export const DEPLOY = commandBody({
  effect: "destroy",
  arguments: DEPLOY_ARGUMENTS,
  // The local facts — checkout, deployment name, recipes relocation, and the remote root —
  // are derived and refused here, in the prepare stage (stage 7 S2.5): every one of their
  // refusals is an argument/local fact, and at run an unreachable target would report
  // instead of them. Run re-derives nothing and never re-validates the remote root.
  prepare: ({ values }, local) => deriveDeployLocalFacts(values, local),
  async run(ctx, prepared) {
    await runDeployCommand(ctx, prepared as DeployPrepared);
  },
});

export async function deploy(ctx: Context, args: string[]): Promise<void> {
  await runOnContext(DEPLOY, ctx, args);
}

async function runDeployCommand(ctx: Context, prepared: DeployPrepared): Promise<void> {
  if (ctx.transport.sessionScoped === true) throw new UserError("SSJACK_SECOND_HOP_UNSUPPORTED");
  // Every local fact was already derived (and refused) in prepare; run only plans.
  const plan = resolveDeployArguments(ctx, prepared);

  await assertDeployable(prepared.sourceRoot);

  if (plan.dryRun) return deployDryRun(ctx, plan);

  if (plan.jsonOnly) {
    let caught: unknown;
    await withOutputSink(() => {}, async () => {
      try {
        await runDeploy(ctx, prepared.sourceRoot, plan);
      } catch (error) {
        caught = error;
      }
    });
    if (caught !== undefined) {
      const message = caught instanceof Error ? caught.message : String(caught);
      emit(`${JSON.stringify({ ok: false, changed: true, target: plan.target, remotePath: plan.remotePath, problems: [message] }, null, 2)}\n`);
      throw caught;
    }
    emit(
      `${JSON.stringify(
        { ok: true, changed: true, target: plan.target, remotePath: plan.remotePath, remoteApp: plan.remoteApp, bootstrapped: plan.runBootstrap },
        null,
        2,
      )}\n`,
    );
    return;
  }

  await runDeploy(ctx, prepared.sourceRoot, plan);
}

async function runDeploy(ctx: Context, sourceRoot: string, plan: DeployPlan): Promise<void> {
  await checkServerReady(ctx, plan.target);

  const root = await prepareRemoteRoot(ctx, plan.target, plan.remotePath, plan.name, plan.adopt);

  await syncTrees(ctx, plan.target, sourceRoot, plan.remotePath, plan.remoteApp, plan.remoteRecipes, plan.name, root);

  await bootstrapAndReport(ctx, plan.target, plan.remotePath, plan.name, plan.runBootstrap, plan.remotePathNote);
}
