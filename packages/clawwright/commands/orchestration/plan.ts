// `plan` — what the declaration implies, as an ordered list of actions, without
// doing any of it.
//
// The dependencies are real (config is read at startup so it precedes a restart;
// provisioning needs the gateway up; a missing secret blocks the instance from starting at
// all) — collected here in one function, each step carrying the finding that motivates it.
//
// Read-only, like inspect. Two kinds of action: most name a command `apply` can run; a few
// are advisory — nothing here can perform them (an MCP client owns its own processes), or
// performing them automatically would defeat their purpose (re-pinning the lock would
// silently accept whatever drifted; overwriting the secret store would discard whatever
// recovery cannot reach).

import { log, info, warn } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { gatherInspection } from "./inspect/gather.ts";
import { currentComposition, declarationChecksum } from "#src/commands/management/lock.ts";
import { isHealthy } from "#src/service/inspection.ts";
import { TransportUnreachableError } from "#src/runtime/transport/transport.ts";
import { withSetSource } from "#src/set/artifacts/source.ts";
import { withUnpackedArtifact } from "#src/set/artifacts/install.ts";
import type { Inspection, Problem, ProblemCode } from "#src/service/inspection.ts";
import type { Context } from "#src/core/context.ts";
import type { ArgumentSpec } from "#src/core/command/spec.ts";
import { commandBody, runOnContext } from "#src/core/command/index.ts";
import * as kinds from "#src/core/values/kinds.ts";

// The --set artifact: the same kind object prepare derives through, so the plan carries the
// resolve's LocalArtifact and the run never sees an unresolved path.
const SET_ARTIFACT = kinds.localFile("a set artifact path");

export const PLAN_ARGUMENTS = [
  { name: "set", description: "Plan from a built set", kind: "option", valueName: "artifact", value: SET_ARTIFACT },
  { name: "json", description: "Plan as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

export interface PlanAction {
  /** Stable identifier, so a report about a step can name it: "apply-config",
   *  "provision-agent:example-recipe". */
  readonly id: string;
  readonly summary: string;
  /** The framework command this step runs, absent for an advisory step. */
  readonly command?: string;
  /** Which findings this step resolves — why it is in the list at all. */
  readonly because: ProblemCode[];
  /** True when `clawwright apply` cannot or must not perform it. */
  readonly advisory?: boolean;
}

export interface Plan {
  readonly deployment: string;
  /** What the declaration was when this plan was computed. `apply` refuses a plan whose
   *  declaration has changed since — the steps below were chosen for a different repository
   *  state and applying them would enact a decision nobody made. */
  readonly declarationChecksum: string;
  readonly healthy: boolean;
  readonly problems: readonly Problem[];
  readonly actions: readonly PlanAction[];
}

function has(problems: readonly Problem[], ...codes: ProblemCode[]): boolean {
  return problems.some((entry) => codes.includes(entry.code));
}

function found(problems: readonly Problem[], ...codes: ProblemCode[]): ProblemCode[] {
  return [...new Set(problems.filter((entry) => codes.includes(entry.code)).map((entry) => entry.code))];
}

/** Which recipes have findings of their own. Per recipe rather than one blanket step:
 *  re-provisioning a correct recipe wastes time on a live instance. */
function recipeWork(inspection: Inspection): Map<string, ProblemCode[]> {
  const perRecipe = new Map<string, ProblemCode[]>();
  const recipeCodes: ProblemCode[] = ["RECIPE_MIRROR_DRIFT", "AGENT_MISSING", "MCP_SERVER_MISSING", "CRON_DRIFT"];

  for (const entry of inspection.problems) {
    if (!recipeCodes.includes(entry.code)) continue;
    // The remedy carries the recipe name as its argv: ["provision-agent", "<recipe>"] —
    // read from the advice's data, never re-parsed out of the human sentence.
    const recipe = entry.next.kind === "clawwright" && entry.next.argv[0] === "provision-agent" && entry.next.argv.length === 2
      ? entry.next.argv[1]
      : undefined;
    if (recipe === undefined) continue;
    const codes = perRecipe.get(recipe) ?? [];
    if (!codes.includes(entry.code)) codes.push(entry.code);
    perRecipe.set(recipe, codes);
  }
  return perRecipe;
}

/** SET_OBJECT_ORPHANED's remedy is set forget's argv — ["set", "forget", "--kind", <kind>,
 *  "--name", <name>] — same convention as recipeWork's, kind/name taken from there. */
function forgottenObject(entry: Problem): { kind: string; name: string } | undefined {
  const argv = entry.next.kind === "clawwright" ? entry.next.argv : [];
  return argv.length === 6 && argv[0] === "set" && argv[1] === "forget" && argv[2] === "--kind" && argv[4] === "--name"
    ? { kind: argv[3], name: argv[5] }
    : undefined;
}

/** Orphaned objects, turned into steps. An agent is always advisory since deleting one
 *  prunes its workspace and memory — a decision for the reader. An MCP server or cron job
 *  carries no memory, so removing one is an ordinary executable step. */
function orphanActions(inspection: Inspection): PlanAction[] {
  const actions: PlanAction[] = [];
  for (const entry of inspection.problems) {
    if (entry.code !== "SET_OBJECT_ORPHANED") continue;
    const forgotten = forgottenObject(entry);
    if (forgotten === undefined) continue;
    const { kind, name } = forgotten;
    if (kind !== "agent" && kind !== "mcp-server" && kind !== "cron-job") continue;
    if (kind === "agent") {
      actions.push({
        id: `remove-owned:${kind}:${name}`,
        summary: `agent "${name}" was created for a recipe no longer in the set — removing it would also prune its workspace and memory`,
        because: ["SET_OBJECT_ORPHANED"],
        advisory: true,
      });
    } else {
      actions.push({
        id: `remove-owned:${kind}:${name}`,
        summary: `remove the ${kind} "${name}", created for a recipe no longer in the set`,
        command: commandLine(["set", "forget", "--kind", kind, "--name", name]),
        because: ["SET_OBJECT_ORPHANED"],
      });
    }
  }
  return actions;
}

/** Every problem no step above names becomes an advisory step with its own nextAction, so a
 *  plan never stays silent about a problem it cannot fix. One step per code. */
function fallbackActions(problems: readonly Problem[], resolved: ReadonlySet<ProblemCode>): PlanAction[] {
  const byCode = new Map<ProblemCode, Problem[]>();
  for (const entry of problems) {
    if (resolved.has(entry.code)) continue;
    const group = byCode.get(entry.code);
    if (group === undefined) byCode.set(entry.code, [entry]);
    else group.push(entry);
  }

  const actions: PlanAction[] = [];
  for (const [code, group] of byCode) {
    const details = [...new Set(group.map((entry) => entry.detail))];
    const remedies = [...new Set(group.map((entry) => entry.nextAction))];
    actions.push({
      id: `problem:${code}`,
      summary: `${details.join("; ")} — next: ${remedies.join(" or ")}`,
      because: [code],
      advisory: true,
    });
  }
  return actions;
}

// Bootstrap first. Nothing else needs suppressing: instance-side findings cannot exist
// before bootstrap, and the operator-side ones (SECRET_MISSING, STORE_INCOMPLETE) still apply.
function pushNotBootstrappedAction(problems: readonly Problem[], actions: PlanAction[]): void {
  const notBootstrapped = problems.find((entry) => entry.code === "NOT_BOOTSTRAPPED");
  if (notBootstrapped !== undefined) {
    actions.push({
      id: "problem:NOT_BOOTSTRAPPED",
      summary: `${notBootstrapped.detail} — next: ${notBootstrapped.nextAction}`,
      because: ["NOT_BOOTSTRAPPED"],
      advisory: true,
    });
  }
}

// 0. Operator-side recovery, before anything repairs the instance: `secrets --apply`
//    REPLACES the target's config/.env with the local store's names, so it must run after
//    the dump step or it would destroy exactly the values the dump exists to recover.
function pushOperatorRecoveryActions(problems: readonly Problem[], actions: PlanAction[]): void {
  if (has(problems, "ENV_STALE")) {
    // Advisory: a divergence between .env and the running container has two readings this
    // code can't tell apart (file rotted, or operator edited and container hasn't caught
    // up), so both directions are named and picking one is the reader's call.
    actions.push({
      id: "recover-env",
      summary:
        "connection facts in .env differ from the running container — decide the direction: " +
        `${commandLine(["recover-env", "--adopt-runtime"])} keeps the container's values; ` +
        `${commandLine("up")} recreates the container from the edited .env`,
      because: found(problems, "ENV_STALE"),
      advisory: true,
    });
  }

  if (has(problems, "STORE_INCOMPLETE")) {
    // Advisory, though a runner exists (apply.ts): `secrets --dump` refuses to overwrite
    // an existing store without --force, so whether its contents matter is the reader's call.
    actions.push({
      id: "secrets-dump",
      summary:
        `recover the target's secret values into the local store — ${commandLine(["secrets", "--dump"])} refuses to overwrite the existing store without --force, and whether its contents matter is the decision this step leaves with you`,
      because: found(problems, "STORE_INCOMPLETE"),
      advisory: true,
    });
  }

  if (has(problems, "DECLARATION_MISSING")) {
    // Executable without --force: the declaration is ABSENT, so dump's refusal (protecting
    // an existing one) has nothing to protect. If one appears before applying, the step
    // fails with that refusal instead of quietly acquiring the flag.
    actions.push({
      id: "apply-config-dump",
      summary: "reconstruct config/desired-state.json from the live config",
      command: commandLine(["apply-config", "--dump"]),
      because: found(problems, "DECLARATION_MISSING"),
    });
  }
}

// 1. Secrets before anything that needs the instance: a missing one stops the instance from
//    starting, so every later step would be working against something that cannot come up.
function pushSecretsAction(problems: readonly Problem[], actions: PlanAction[]): void {
  if (has(problems, "SECRET_MISSING")) {
    actions.push({
      id: "secrets",
      summary: "install the missing secrets on the target",
      command: commandLine(["secrets", "--apply"]),
      because: found(problems, "SECRET_MISSING"),
    });
  }
}

// 2. Configuration before anything starts or restarts: it is read at startup, so applying
//    it afterwards would need a second restart nobody planned.
function pushConfigAction(problems: readonly Problem[], actions: PlanAction[]): void {
  if (has(problems, "CONFIG_DRIFT")) {
    actions.push({
      id: "apply-config",
      summary: "push config/desired-state.json onto the instance",
      command: commandLine("apply-config"),
      because: found(problems, "CONFIG_DRIFT"),
    });
  }
}

// 3. Bring it up, or restart it — never both. A stopped instance reads the configuration
//    when it starts, so starting it is already the restart.
function pushLifecycleAction(inspection: Inspection, problems: readonly Problem[], actions: PlanAction[]): void {
  if (has(problems, "GATEWAY_DOWN")) {
    actions.push({
      id: "up",
      summary: "start the gateway",
      command: commandLine("up"),
      because: found(problems, "GATEWAY_DOWN"),
    });
  } else if (has(problems, "RESTART_REQUIRED", "CONFIG_DRIFT") ||
    (inspection.observed.running && has(problems, "SECRET_MISSING"))) {
    // Drift and newly installed secrets are read only at startup. A stopped instance takes
    // the `up` branch above, so only a running one needs this restart.
    actions.push({
      id: "restart",
      summary: "restart so the instance reads the configuration on disk",
      command: commandLine("restart"),
      because: found(problems, "RESTART_REQUIRED", "CONFIG_DRIFT", "SECRET_MISSING"),
    });
  }
}

// 4. Recipes last among the executable steps: provisioning talks to a running gateway.
function pushRecipeActions(inspection: Inspection, actions: PlanAction[]): void {
  for (const [recipe, codes] of [...recipeWork(inspection)].sort(([a], [b]) => a.localeCompare(b))) {
    actions.push({
      id: `provision-agent:${recipe}`,
      summary: `re-provision recipe "${recipe}" (files, agent, MCP server, cron)`,
      command: commandLine(["provision-agent", recipe]),
      because: codes,
    });
  }
}

// 5. Advisory. Mirrored recipe files changing is precisely when a client that has been
//    holding that recipe's MCP server open is serving the old content — nothing here can
//    reconnect it, because the client owns that process.
function pushReconnectMcpAction(inspection: Inspection, actions: PlanAction[]): void {
  if (recipeWork(inspection).size > 0) {
    actions.push({
      id: "reconnect-mcp",
      summary: "reconnect the MCP client: a server it started earlier is serving the previous files",
      because: ["MCP_RESTART_REQUIRED"],
      advisory: true,
    });
  }
}

// The lock is never rewritten automatically. Re-pinning whatever drifted is how a
// reproducibility claim turns into a rubber stamp; the decision is the reader's.
function pushLockAction(problems: readonly Problem[], actions: PlanAction[]): void {
  if (has(problems, "LOCK_MISSING", "LOCK_DRIFT")) {
    actions.push({
      id: "lock",
      summary: `review the difference from the lock, then run ${commandLine("lock")} to re-pin it deliberately`,
      because: found(problems, "LOCK_MISSING", "LOCK_DRIFT"),
      advisory: true,
    });
  }
}

// Plugins/skills: always advisory, never run unattended — a supply-chain surface where this
// framework doesn't even have proof its reinstall command names the right package (an
// npm-origin plugin's id can differ from its manifest name). Each finding carries its own
// best-effort command (compareExtensions); this only turns it into a step the reader sees.
function pushExtensionDriftActions(problems: readonly Problem[], actions: PlanAction[]): void {
  for (const entry of problems.filter((candidate) => candidate.code === "PLUGIN_DRIFT" || candidate.code === "SKILL_DRIFT")) {
    actions.push({
      id: `extension-drift:${entry.code === "PLUGIN_DRIFT" ? "plugin" : "skill"}:${actions.length}`,
      summary: entry.detail,
      because: [entry.code],
      advisory: true,
    });
  }
}

/** The ordered steps. Exported so `apply` executes exactly this list and checks can assert
 *  the order without a live instance — the order the numbering documents is user-visible. */
export function planActions(inspection: Inspection): PlanAction[] {
  const { problems } = inspection;
  const actions: PlanAction[] = [];

  pushNotBootstrappedAction(problems, actions);
  pushOperatorRecoveryActions(problems, actions);
  pushSecretsAction(problems, actions);
  pushConfigAction(problems, actions);
  pushLifecycleAction(inspection, problems, actions);
  pushRecipeActions(inspection, actions);

  // 4b. Objects created for a recipe the set no longer declares this way (dropped or
  //     renamed). After provisioning: a rename adds the new name first, removes the old after.
  actions.push(...orphanActions(inspection));

  pushReconnectMcpAction(inspection, actions);
  pushLockAction(problems, actions);
  pushExtensionDriftActions(problems, actions);

  // Backstop: every code the steps above did not name is still shown.
  const resolved = new Set(actions.flatMap((action) => action.because));
  actions.push(...fallbackActions(problems, resolved));

  return actions;
}

/** Exported so `apply` can compute a plan itself rather than being handed one — passing a
 *  plan between processes would need a file format, and nothing yet needs one. */
export async function computePlan(ctx: Context): Promise<Plan> {
  const inspection = await gatherInspection(ctx);
  let checksum: string;
  try {
    checksum = declarationChecksum(await currentComposition(ctx));
  } catch (error) {
    if (!(error instanceof TransportUnreachableError)) throw error;
    // currentComposition() reaches the target for its image digest even though the checksum
    // only hashes local desiredState/recipes — TARGET_UNREACHABLE is already in
    // inspection.problems above, so this must not crash a read-only command too.
    checksum = "";
  }
  return {
    deployment: inspection.declared.deployment,
    declarationChecksum: checksum,
    healthy: isHealthy(inspection),
    problems: inspection.problems,
    actions: planActions(inspection),
  };
}

export const PLAN = commandBody({
  effect: "read",
  arguments: PLAN_ARGUMENTS,
  prepare: async (call) => ({
    // The resolved set artifact arrives in the plan's own key slot: the pipeline resolved
    // it through the declared kind (S2.5).
    set: call.values.set,
    json: call.values.json,
  }),
  async run(ctx, plan) {
    const jsonOnly = plan.json;
    const artifact = plan.set;

    // One engine, two sources: with --set the declaration comes from the artifact and
    // everything about the machine keeps coming from the deployment. Without it, nothing
    // changes.
    const computed = artifact === undefined
      ? await computePlan(ctx)
      : await withUnpackedArtifact(artifact, (staging) => withSetSource(staging, () => computePlan(ctx)));

    if (jsonOnly || isCaptured()) {
      emit(`${JSON.stringify(computed, null, 2)}\n`);
      return;
    }

    if (planIsClean(computed)) {
      log(`${computed.deployment} is what this repository declares — nothing to do`);
      return;
    }

    if (computed.actions.length === 0) {
      // Unhealthy with no step: never claim the deployment matches its declaration.
      warn(`${computed.deployment}: ${computed.problems.length} problem(s) found, but plan has no step for any of them — this is a gap in planActions()`);
      for (const entry of computed.problems) info(`  ${entry.code}  ${entry.detail}`);
      return;
    }

    printPlanActions(computed.actions);
    log(planNextStepLine(computed.actions));
  },
});

/** The full-context entry for callers outside this group (transport, connectivity
 *  fixtures): the same declaration, parsed and run on a context they already hold. */
export const plan = (ctx: Context, args: string[]): Promise<void> => runOnContext(PLAN, ctx, args);

export function planSummaryLine(total: number, executable: number): string {
  return `${total} step(s) — ${executable} that ${commandLine("apply")} will run`;
}

/** The step list `plan` and `apply --dry-run` both print; the executable count is the filter
 *  `apply` runs. */
export function printPlanActions(actions: readonly PlanAction[]): void {
  const executable = actions.filter((action) => action.advisory !== true);
  log(planSummaryLine(actions.length, executable.length));
  actions.forEach((action, index) => {
    info(`${index + 1}. ${action.summary}`);
    info(`     ${action.advisory === true ? "(you)" : action.command}   because ${action.because.join(", ")}`);
  });
}

/** "Nothing to do" is a claim about the deployment — healthy and problem-free — never
 *  inferred from an empty step list. Exported for the checks. */
export function planIsClean(computed: Pick<Plan, "healthy" | "problems">): boolean {
  return computed.healthy && computed.problems.length === 0;
}

/** What to tell the reader once the numbered steps are printed: apply runs only the
 *  executable ones, so advising it when there are none would point at a no-op command.
 *  Exported so checks can pin the wording without a live instance. */
export function planNextStepLine(actions: readonly PlanAction[]): string {
  const executable = actions.filter((action) => action.advisory !== true);
  return executable.length > 0
    ? `apply it: ${commandLine("apply")}`
    : `every step above is advisory — ${commandLine("apply")} would run nothing; carry them out yourself`;
}
