// `clawwright set` — the command body: build, validate, diff, receipts, try, forget.
//
// Split for organisation only: set-secrets-guard.ts (value scan before a build writes
// anything), set-manifest.ts (collectManifest/writeArtifact/buildSet), set-diff.ts,
// set-receipts.ts and set-try.ts (their own actions). This file keeps build/validate/forget
// and assembles the body, and re-exports the guard and manifest modules, so every
// external importer keeps using "./set.ts".

import { die, log, info } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { createName } from "#src/core/values/names.ts";
import type { NameOf, OwnedObjectName } from "#src/core/values/names.ts";
import * as kinds from "#src/core/values/kinds.ts";
import type { LocalArtifact } from "#src/core/values/plan.ts";
import type { Context } from "#src/core/context.ts";
import { deploymentName } from "#src/runtime/deployment.ts";
import { validateLoadedSet, loadSet } from "#src/set/load.ts";
import { printProblem } from "#src/commands/orchestration/inspect/gather.ts";
import type { Problem } from "#src/service/inspection.ts";
import { nextActions, nextAdvice } from "#src/service/inspection.ts";
import { removeOwnedObject } from "#src/commands/management/provision-agent/index.ts";
import { withLockUnlessHeld } from "#src/runtime/lock/instance-lock.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import { newOperationId } from "#src/service/operations.ts";
import { LOCK_TAKEOVER_ARGUMENTS, takeoverOf } from "#src/commands/interface/groups/shared-arguments.ts";
import { SET_TRY } from "./set-try.ts";
import { SET_DIFF_ARGUMENTS, diffPrepare, runSetDiff } from "./set-diff.ts";
import { SET_RECEIPTS } from "./set-receipts.ts";
import { withArtifactInspected } from "#src/set/artifacts/install.ts";
import type { SetManifest } from "#src/set/artifacts/model.ts";
import { buildSet, defaultSetName } from "./set-manifest.ts";
import { defineAction, multiActionBody, type ArgumentSpec } from "#src/core/command/index.ts";
import type { OwnedKind } from "#src/set/ownership/ledger.ts";

const SET_NAME_SUMMARY = "Set name";

// The --set artifact: the same kind object prepare derives through, so the plan carries the
// resolve's LocalArtifact and the run never sees an unresolved path.
const SET_ARTIFACT = kinds.localFile("a set artifact path");

export const SET_BUILD_ARGUMENTS = [
  { name: "name", summary: SET_NAME_SUMMARY, description: "Set name (default: the deployment's name)", kind: "option", valueName: "name", value: kinds.name("set", "create") },
  { name: "json", summary: "Emit the manifest and its id as JSON", description: "Emit the manifest and its id as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

export const SET_VALIDATE_ARGUMENTS = [
  { name: "name", summary: SET_NAME_SUMMARY, description: "Set name (default: the deployment's name)", kind: "option", valueName: "name", value: kinds.name("set", "read") },
  { name: "set", description: "Built set artifact", kind: "option", valueName: "artifact", value: SET_ARTIFACT },
  { name: "json", summary: "Emit the findings as JSON", description: "Emit the findings as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

export const SET_FORGET_ARGUMENTS = [
  { name: "kind", description: "agent, mcp-server, or cron-job", kind: "option", valueName: "kind", required: true, value: kinds.choice(["agent", "mcp-server", "cron-job"]) },
  { name: "name", summary: "Object name", description: "Object name", kind: "option", valueName: "name", required: true, value: kinds.name("owned-object", "read") },
  ...LOCK_TAKEOVER_ARGUMENTS,
] as const satisfies readonly ArgumentSpec[];

export * from "./set-secrets-guard.ts";
export * from "./set-manifest.ts";
export { collectManifest } from "#src/set/load.ts";

/** Fixed phrases of set validate's own report, exported so checks assert the same text the
 *  product prints instead of restating it. */
export function blockingFindingsMessage(count: number, codes: readonly string[]): string {
  return `${count} blocking finding(s): ${[...new Set(codes)].join(", ")}`;
}
export function blockingWarningsSummary(blocking: number, warnings: number): string {
  return `${blocking} blocking, ${warnings} warning(s)`;
}
const ARTIFACT_CONTENTS_MATCH = " and its artifact contents match";
function coherentLine(name: string, note = ""): string {
  return `set ${name} is coherent${note}`;
}

/** `clawwright set validate` — the same manifest `build` would produce, or one read back
 *  from an artifact, put through every check that needs no gateway.
 *
 *  Validating the working tree also checks the files are there; validating an artifact runs
 *  the same checks against the staging directory it was unpacked into, so the artifact is
 *  held to exactly what the tree it came from would have been — an incomplete recipe is
 *  refused here (by the unpack verification), not waved through as "coherent". */
async function validateAction(
  ctx: Context,
  options: { name?: string; artifact?: LocalArtifact; jsonOnly: boolean },
): Promise<void> {
  // Both sources answer through one report, so the artifact path cannot drift from the
  // tree path: blocking findings print as blocking (doctor's verb, not warning:), the
  // summary names each failing code once, and non-zero exit comes from the blockers alone.
  const report = async (manifest: SetManifest, source: string, problems: readonly Problem[], coherentNote = "", id?: string): Promise<void> => {
    const blocking = problems.filter((entry) => entry.severity === "blocking");
    if (options.jsonOnly || isCaptured()) {
      emit(
        `${JSON.stringify(
          {
            set: manifest.name,
            // The artifact's content id, as the JSON always carried for an artifact.
            ...(id === undefined ? {} : { id }),
            source,
            valid: blocking.length === 0,
            problems,
            nextActions: nextActions(problems),
            next: nextAdvice(problems),
          },
          null,
          2,
        )}\n`,
      );
    } else if (problems.length === 0) {
      log(coherentLine(manifest.name, coherentNote));
      info(`${Object.keys(manifest.recipes).length} recipe(s), ${manifest.secrets.length} secret name(s)`);
      info("checked without a gateway; whether the pinned image supports what the recipes use is settled at install");
    } else {
      log(`set ${manifest.name}: ${blockingWarningsSummary(blocking.length, problems.length - blocking.length)}`);
      for (const entry of problems) printProblem(entry);
    }
    if (blocking.length > 0) {
      throw new Error(blockingFindingsMessage(blocking.length, blocking.map((entry) => entry.code)));
    }
  };

  if (options.artifact !== undefined) {
    const artifact = options.artifact;
    log(`checking ${artifact.path}`);
    // Read-only: the unpack gate's integrity checks still refuse a corrupt archive (typed as
    // ArtifactIntegrityError), but blocking semantic findings come back and go through the
    // same report as the tree — blocking: lines, the JSON document, MCP problems — instead
    // of dying as one bare error string before anything was printed (R32-05).
    return withArtifactInspected(artifact, (_staging, verified, problems) =>
      report(verified.manifest, artifact.path, problems, ARTIFACT_CONTENTS_MATCH, verified.id));
  }
  // The tag is kept in requires.image rather than dying here: validate reports the gap
  // itself (SET_IMAGE_UNPINNED) together with everything else it found. An invalid
  // declaration is reported the same way an artifact carrying the same bytes is.
  const loaded = await loadSet({ kind: "tree" }, {
    name: options.name ?? defaultSetName(deploymentName()),
    declaredImage: ctx.settings.image,
    tolerateUnpinnedImage: true,
    reportInvalidDeclaration: true,
  });
  await report(loaded.manifest, "working tree", await validateLoadedSet(loaded));
}

/** `clawwright set forget --kind <kind> --name <name>` — removes an object this framework
 *  created and stops tracking it. `apply` does this on its own for an orphaned MCP server
 *  or cron job; exposed by hand for an orphaned agent, whose removal prunes a workspace and
 *  memory — a decision for whoever runs this, not something a plan does automatically. The
 *  plan carries the read name branded; the object's existence is the run's target fact. */
interface ForgetPlan {
  readonly kind: string;
  readonly name: OwnedObjectName;
  readonly takeover: { readonly breakLock: boolean; readonly breakForeignLockHost?: string };
}

async function forgetAction(ctx: Context, plan: ForgetPlan): Promise<void> {
  const { kind, name } = plan;
  // `value: kinds.choice(...)` types the bound value as string (the kind's grammar is the
  // authority at run time); the list above is exactly OwnedKind.
  const ownedKind = kind as OwnedKind;
  // Same never-bootstrapped refusal as the sibling preflights; without it the isRunning()
  // check below dies with the bare NotBootstrapped message.
  await requireBootstrapped(ctx);
  if (!(await ctx.runtime.isRunning())) die(`the gateway is not running. Start it with ${commandLine("up")}`);

  // `apply` calls this indirectly while already holding the lock; nested, the second acquire
  // would refuse the run its own caller started. Taken only when this is invoked directly.
  await withLockUnlessHeld(ctx, `set forget ${kind} ${name}`, newOperationId("set-forget"), plan.takeover, async () => {
    await removeOwnedObject(ctx, ownedKind, name);
  });
  log(`${kind} "${name}" removed and no longer tracked as owned`);
}

/** `clawwright set build`: the artifact, and an inventory of what went into it. The plan
 *  carries the already-minted name (prepare owns the creator grammar; the run never
 *  re-validates it — NC-S2-grammar-in-run). */
interface BuildPlan {
  readonly name: NameOf<"set">;
  readonly json: boolean;
}

async function buildAction(ctx: Context, plan: BuildPlan): Promise<void> {
  const built = await buildSet(ctx, plan.name);

  // Same split as lock: --json or a captured caller gets the machine-readable answer;
  // a terminal gets the inventory, because an artifact whose contents can only be
  // discovered by unpacking it is one nobody will trust.
  if (plan.json || isCaptured()) {
    emit(
      `${JSON.stringify({ name: built.name, id: built.id, artifact: built.artifact, manifest: built.manifest }, null, 2)}\n`,
    );
    return;
  }

  log(`built set ${built.name} (${Object.keys(built.manifest.files).length} file(s))`);
  info(`id        ${built.id}`);
  info(`artifact  ${built.artifact}`);
  info(`requires  framework ${built.manifest.requires.framework}, image ${built.manifest.requires.image}`);

  const names = Object.keys(built.manifest.recipes);
  info(`recipes   ${names.length === 0 ? "(none)" : names.join(", ")}`);
  for (const [recipe, entry] of Object.entries(built.manifest.recipes)) {
    info(
      `${recipe.padEnd(16)} ${Object.keys(entry.files).length} file(s) served, ` +
        `${Object.keys(entry.agentFiles ?? {}).length} in the agent bundle`,
    );
    const agent = entry.agent;
    if (agent !== undefined) {
      const cron = agent.cronJobName === undefined ? "no cron job" : `cron ${agent.cronJobName} at ${agent.cronSchedule}`;
      info(`${"".padEnd(16)} agent ${agent.agentId} (mcp server ${agent.mcpServerName}), ${cron}`);
    }
    const checks = built.manifest.acceptance[recipe];
    if (checks !== undefined) info(`${"".padEnd(16)} ${checks.length} acceptance check(s)`);
  }

  info(`secrets   ${built.manifest.secrets.length === 0 ? "(none)" : built.manifest.secrets.join(", ")}`);
  info("names only — values stay on the machine that has them");
}

export const SET = multiActionBody({
  effect: "change",
  action: { description: "Set action" },
  actions: {
    build: defineAction({
      summary: "Build the set artifact from the working tree",
      arguments: SET_BUILD_ARGUMENTS,
      // The name may be absent (default: the deployment's name — a local fact), so prepare
      // mints the effective name through the creator grammar and the plan carries it
      // branded; a GIVEN name is already validated by the declaration's kind at parse.
      prepare: ({ values }, local) => ({
        name: values.name ?? createName("set", defaultSetName(local.deployment().name)),
        json: values.json,
      }),
      run: buildAction,
    }),
    validate: defineAction({
      summary: "Check a set without a running instance",
      effect: "read",
      arguments: SET_VALIDATE_ARGUMENTS,
      prepare: async (call) => ({
        name: call.values.name,
        // The resolved set artifact arrives in the plan's own key slot (S2.5).
        set: call.values.set,
        json: call.values.json,
      }),
      run: (ctx, { name, set: artifact, json: jsonOnly }) => validateAction(ctx, { name, artifact, jsonOnly }),
    }),
    diff: defineAction({
      summary: "Compare two verified artifacts",
      effect: "read",
      arguments: SET_DIFF_ARGUMENTS,
      rules: [{ rule: "oneOf", groups: [["artifacts"], ["from", "to"]], required: true }],
      prepare: diffPrepare,
      run: runSetDiff,
    }),
    receipts: SET_RECEIPTS,
    try: SET_TRY,
    forget: defineAction({
      summary: "Remove an object this framework created",
      effect: "destroy",
      arguments: SET_FORGET_ARGUMENTS,
      prepare: ({ values }) => ({ kind: values.kind, name: values.name, takeover: takeoverOf(values) }),
      run: forgetAction,
    }),
  },
});
