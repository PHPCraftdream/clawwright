// `inspect [--json]` — what this deployment declares, what the instance actually
// is, and where the two disagree. `doctor` lives here too: same inspection, read
// for its problems rather than its inventory, so there is only ever one gatherer.
//
// Read-only: nothing here writes, starts, restarts or registers anything, so it is safe to
// call before deciding to act. `plan` turns findings into actions; `apply` executes them.
//
// Split for organisation only: helpers.ts (pure pieces), declared.ts (what this repository
// declares), drift.ts (declared-vs-target comparisons), live.ts (what the target reports
// with no declared counterpart), upkeep.ts (recoverability), this file (CLI surface).

import { renderAdvice } from "#src/core/io/invocation/render.ts";
import { observeInstanceLock, instanceLockAdvice } from "#src/runtime/lock/instance-lock.ts";
import { log, info, warn, reportBlocking } from "#src/core/io/log.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { desiredStateFile } from "#src/runtime/deployment.ts";
import { NotBootstrapped } from "#src/runtime/runtime.ts";
import { requirementsForConfig, statusForRequirements, collectConfiguredProviders } from "#src/service/secrets.ts";
import { compareLock, readLock, currentComposition } from "#src/commands/management/lock.ts";
import { pluginsForLock, skillsForLock } from "#src/commands/management/extensions.ts";
import { readInstalledSet, requirementProblems, runningDigests, matchRequiredDigest } from "#src/set/artifacts/install.ts";
import {
  problem,
  unreachableProblem,
  blockingProblems,
  isHealthy,
  nextActions,
  nextAdvice,
} from "#src/service/inspection.ts";
import type { Problem, Inspection, SecretStoreObservation } from "#src/service/inspection.ts";
import type { SecretStatus } from "#src/service/secrets.ts";
import { TransportUnreachableError } from "#src/runtime/transport/transport.ts";
import { hasDigest, sameContent } from "#src/runtime/docker/image-ref.ts";
import type { Context } from "#src/core/context.ts";
import { prospectiveConfig, publicConfigValue, readLiveConfigForProspective, frameworkVersion, redactEndpoint, redactEndpointText } from "./helpers.ts";
import { declaredState, observeDeclarationFile } from "./declared.ts";
import { observeConfig, observeConnectionFacts, observeSecretStore } from "./drift.ts";
import { observeLive } from "./live.ts";
import { observeBackupHealth, observeDiskSpace } from "./upkeep.ts";
import { runSecurityAudit } from "#src/security/audit.ts";
import type { ArgumentSpec } from "#src/core/command/spec.ts";
import { commandBody, runOnContext } from "#src/core/command/index.ts";

export const INSPECT_ARGUMENTS = [
  { name: "json", description: "Whole inspection as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

export const RECREATE_SWITCHES_IMAGES = "the next recreate (up, restart after compose changes, apply) would switch images";

/** gatherInspection's opt-in extras; a caller that omits this gets the inspection it always did. */
export interface GatherInspectionOptions {
  /** Gather safe channel telemetry by default; false explicitly suppresses the read. */
  readonly channels?: boolean;
}

/** The whole picture. Exported because doctor, plan and apply all read it rather than
 *  gathering their own.
 *
 *  declaredState() runs outside the try below on purpose: it never touches the target, so
 *  it is available even when the target is not (TARGET_UNREACHABLE, NOT_BOOTSTRAPPED). */
export async function gatherInspection(ctx: Context, options?: GatherInspectionOptions): Promise<Inspection> {
  const problems: Problem[] = [];
  const declared = await declaredState(ctx, problems);
  const instanceLock = await observeInstanceLock(ctx);
  try {
    const inspection = await gatherReachedInspection(ctx, declared, problems, options);
    return publicInspection({ ...inspection, observed: { ...inspection.observed, instanceLock } });
  } catch (error) {
    if (!(error instanceof TransportUnreachableError)) throw error;
    return publicInspection({
      declared,
      observed: { instanceLock, running: false, probes: {}, config: {}, secrets: [], agents: [], mcpServers: [], cronJobs: [], foreignObjects: [] },
      problems: [...problems, unreachableProblem(error)],
    });
  }
}

function publicInspection(inspection: Inspection): Inspection {
  return {
    ...inspection,
    declared: {
      ...inspection.declared,
      config: inspection.declared.config.map((entry) => ({
        path: entry.path,
        value: publicConfigValue(entry.path, entry.value),
      })),
    },
    observed: {
      ...inspection.observed,
      egress: inspection.observed.egress?.map((entry) => ({
        ...entry,
        endpoint: redactEndpoint(entry.endpoint),
        ...(entry.detail === undefined ? {} : { detail: redactEndpointText(entry.detail) }),
      })),
      config: Object.fromEntries(Object.entries(inspection.observed.config).map(([path, value]) => [
        path, publicConfigValue(path, value),
      ])),
    },
    problems: inspection.problems.map((entry) => entry.code === "EGRESS_UNREACHABLE"
      ? { ...entry, detail: redactEndpointText(entry.detail) }
      : entry),
  };
}

/** observeConfig()'s own return shape, named here so the preflight/running split below can
 *  pass it along without re-stating the inline object type at every boundary. */
interface ConfigState {
  readonly config: Record<string, unknown>;
  readonly mtimeMs?: number;
}

/** Everything gatherReachedInspection needs before it can even tell whether the instance is
 *  running: isRunning() itself, the image-pin check, secrets against the prospective config,
 *  the provider check, and the two target reads (secret store, live config on disk) that are
 *  no more expensive to take on a stopped instance than a running one. */
async function gatherPreflight(
  ctx: Context,
  declared: Inspection["declared"],
  problems: Problem[],
): Promise<{
  running: boolean;
  notBootstrapped: NotBootstrapped | undefined;
  liveConfig: unknown;
  secrets: SecretStatus[];
  secretStore: SecretStoreObservation | undefined;
  configState: ConfigState;
}> {
  // isRunning() needs the data directory to write compose's env file; pre-bootstrap it
  // doesn't exist yet, so DockerRuntime throws NotBootstrapped instead of a transport error.
  // Caught here and reported as its own finding, not folded into GATEWAY_DOWN — "up" is not
  // a working remedy pre-bootstrap.
  let running: boolean;
  let notBootstrapped: NotBootstrapped | undefined;
  try {
    running = await ctx.runtime.isRunning();
  } catch (error) {
    if (!(error instanceof NotBootstrapped)) throw error;
    running = false;
    notBootstrapped = error;
  }

  // Pure fact about this deployment's own .env, no runtime call needed. Skipped
  // pre-bootstrap like PROVIDER_MISSING below: NOT_BOOTSTRAPPED already names the remedy,
  // and `upgrade` (this finding's remedy) needs a running instance to roll back to.
  if (notBootstrapped === undefined && !hasDigest(declared.image)) {
    problems.push(problem("IMAGE_UNPINNED", `OPENCLAW_IMAGE is "${declared.image}", a tag rather than a digest`));
  }

  // Asked of the PROSPECTIVE config (live + declared overlay): a SecretRef the declaration
  // is about to add is a real requirement before CONFIG_DRIFT is ever applied.
  //
  // prospectiveConfig() throws on a declared path through __proto__/constructor/prototype
  // (setAt's guard against prototype pollution) — caught, not left to crash a read-only
  // command; live config alone is still a safe fallback.
  let prospective: unknown;
  let liveConfig: unknown;
  try {
    // One read serves both the prospective merge and the egress endpoints observeLive probes.
    liveConfig = await readLiveConfigForProspective(ctx);
    prospective = prospectiveConfig(liveConfig, declared.config);
  } catch (error) {
    // A transport failure here is TARGET_UNREACHABLE, not a bad declared path.
    if (error instanceof TransportUnreachableError) throw error;
    problems.push(problem("CONFIG_DRIFT", `${desiredStateFile()} declares an unsafe configuration path: ${(error as Error).message}`));
    prospective = liveConfig;
  }
  const secrets = await statusForRequirements(ctx, await requirementsForConfig(ctx, prospective));
  for (const secret of secrets) {
    if (secret.required && !secret.present) {
      problems.push(problem("SECRET_MISSING", `${secret.name} (${secret.usedBy}) is not set in ${secret.location === "repo-env" ? ".env" : "<data>/config/.env"}`));
    }
  }

  // A provider apiKey is inferred from the configured id, so with no id configured there is
  // no requirement for SECRET_MISSING above to catch — without this, a bootstrap with no
  // provider key reports healthy while every agent turn fails at the first model call.
  // Skipped pre-bootstrap: NOT_BOOTSTRAPPED above already names the remedy.
  if (notBootstrapped === undefined && collectConfiguredProviders(prospective).length === 0) {
    problems.push(problem("PROVIDER_MISSING", "models.providers declares no provider, and no auth.profiles entry names one either"));
  }

  // BACKUP_MISSING/BACKUP_STALE/DISK_LOW: recoverability, not liveness — same pre-bootstrap
  // skip as above, nothing backed up or disk-limited yet.
  if (notBootstrapped === undefined) {
    await observeBackupHealth(ctx, problems);
    await observeDiskSpace(ctx, problems);
  }

  // The operator side reads while the instance is down, and matters most then: the store
  // is the only place a stopped instance's values can still be re-read from, since the
  // container that carries repo-env values is gone.
  const secretStore = await observeSecretStore(ctx, secrets, problems);

  // Read whether or not anything is serving: the declaration is compared against a file on
  // the target, and a stopped instance is exactly when someone is about to start one.
  const configState = await observeConfig(ctx, declared, problems);

  return { running, notBootstrapped, liveConfig, secrets, secretStore, configState };
}

/** Everything needing an actually-running instance: declaration/connection facts, the live
 *  observation, image-digest comparison, installed-set check, lock comparison — assembled
 *  into the final Inspection. Split out so gatherReachedInspection stays a short dispatch. */
async function gatherRunningInspection(
  ctx: Context,
  declared: Inspection["declared"],
  problems: Problem[],
  configState: ConfigState,
  liveConfig: unknown,
  secrets: SecretStatus[],
  secretStore: SecretStoreObservation | undefined,
  options: GatherInspectionOptions | undefined,
): Promise<Inspection> {
  // Both need a running instance: DECLARATION_MISSING is only a finding while something is
  // running to be re-declared, and ENV_STALE compares against a running container's facts.
  await observeDeclarationFile(problems);
  const connectionFacts = await observeConnectionFacts(ctx, problems);

  const live = await observeLive(ctx, declared, problems, configState.mtimeMs, liveConfig, options?.channels !== false);

  // Shared below by the set-requirement match and the displayed digest, one container
  // inspect instead of two.
  const runningDigestList = await runningDigests(ctx);

  // Only for a tag still in force (a digest can't move) and only while running (nothing to
  // compare a stopped container against) — a pinned deployment never pays for this extra
  // `docker image inspect`.
  if (!hasDigest(declared.image) && runningDigestList.length > 0) {
    const localTagDigest = await ctx.runtime.imageReference();
    if (
      localTagDigest !== undefined &&
      !runningDigestList.some((digest) => sameContent(digest, localTagDigest))
    ) {
      problems.push(
        problem(
          "IMAGE_TAG_MOVED",
          `the local tag "${declared.image}" now resolves to ${localTagDigest}, but the running container is ${runningDigestList[0]} — ` +
            RECREATE_SWITCHES_IMAGES,
        ),
      );
    }
  }

  // Which set is installed, and whether this machine matches what it required. Read before
  // the lock comparison because it's the more specific answer: a lock says what the
  // composition was pinned to, a set id says what was actually installed.
  const installed = await readInstalledSet(ctx);
  if (installed !== undefined) {
    const installedManifest = { requires: installed.requires } as never;
    problems.push(
      ...requirementProblems(
        installedManifest,
        // Against the already-fetched running digests, not ctx.runtime.imageReference():
        // the latter follows a `docker pull`'s tag move even when the container wasn't
        // recreated and is still on the old digest.
        { framework: await frameworkVersion(), imageDigest: matchRequiredDigest(runningDigestList, installedManifest) },
      ),
    );
  }

  // Last, and only while running: the lock pins the image digest, unreadable from a stopped
  // instance. Plugins/skills come from `live`'s already-batched read, not a second fetch.
  const composition = await currentComposition(ctx);
  problems.push(
    ...compareLock(await readLock(), {
      ...composition,
      plugins: live.plugins === undefined || live.skills === undefined ? undefined : pluginsForLock(live.plugins),
      skills: live.plugins === undefined || live.skills === undefined ? undefined : skillsForLock(live.skills),
    }),
  );

  return {
    declared,
    observed: {
      running: true,
      secrets,
      secretStore: secretStore,
      image: ctx.settings.image,
      // The actually-running container's digest, not ctx.runtime.imageReference() — see
      // matchRequiredDigest comment above. No fallback: an absent answer beats a wrong one.
      imageDigest: runningDigestList[0],
      frameworkVersion: await frameworkVersion(),
      probes: live.probes ?? {},
      health: live.health,
      egress: live.egress,
      connectionFacts: connectionFacts,
      channels: live.channels,
      memory: live.memory,
      config: configState.config,
      agents: live.agents,
      mcpServers: live.mcpServers,
      cronJobs: live.cronJobs,
      foreignObjects: live.foreignObjects ?? [],
      openclawVersion: live.openclawVersion,
    },
    problems,
  };
}

async function gatherReachedInspection(
  ctx: Context,
  declared: Inspection["declared"],
  problems: Problem[],
  options: GatherInspectionOptions | undefined,
): Promise<Inspection> {
  const { running, notBootstrapped, liveConfig, secrets, secretStore, configState } = await gatherPreflight(ctx, declared, problems);

  if (!running) {
    problems.push(
      notBootstrapped !== undefined
        ? problem("NOT_BOOTSTRAPPED", notBootstrapped.message)
        : problem("GATEWAY_DOWN", `no running container for deployment "${declared.deployment}"`),
    );
    return {
      declared,
      observed: {
        running: false,
        probes: {},
        config: configState.config,
        secrets,
        secretStore: secretStore,
        agents: [],
        mcpServers: [],
        cronJobs: [],
        foreignObjects: [],
        frameworkVersion: await frameworkVersion(),
      },
      problems,
    };
  }

  return gatherRunningInspection(ctx, declared, problems, configState, liveConfig, secrets, secretStore, options);
}

export const INSPECT = commandBody({
  effect: "read",
  arguments: INSPECT_ARGUMENTS,
  async run(ctx, plan) {
    const inspection = await gatherInspection(ctx);

    if (plan.json || isCaptured()) {
      emit(`${JSON.stringify(renderJson(inspection), null, 2)}\n`);
      return;
    }

    renderText(inspection);
  },
});

/** The full-context entry for callers outside this group (connectivity fixtures): the
 *  same declaration, parsed and run on a context they already hold. */
export const inspect = (ctx: Context, args: string[]): Promise<void> => runOnContext(INSPECT, ctx, args);

/** The machine-readable answer. Its own shape rather than the Inspection struct verbatim:
 *  what a caller needs first is the verdict and what to do about it, and burying those under
 *  the raw observation would make every consumer compute them again — differently. */
function lockNext(inspection: Inspection) {
  const lock = inspection.observed.instanceLock;
  return lock === undefined || lock.state === "absent" ? [] : [instanceLockAdvice(lock)];
}

export function renderJson(inspection: Inspection): Record<string, unknown> {
  return {
    deployment: inspection.declared.deployment,
    healthy: isHealthy(inspection),
    problems: inspection.problems,
    nextActions: [...nextActions(inspection.problems), ...lockNext(inspection).map((entry) => renderAdvice(entry))],
    next: [...nextAdvice(inspection.problems), ...lockNext(inspection)],
    declared: inspection.declared,
    observed: inspection.observed,
  };
}

/** One problem line, prefixed by what its severity actually earns — `blocking:` rather than
 *  `warning:` for one that fails the run — so a blocking finding never reads as merely worth
 *  noting. Shared by doctor() and renderText() so the two never drift apart on it. */
export function printProblem(entry: Problem): void {
  (entry.severity === "blocking" ? reportBlocking : warn)(`${entry.code}  ${entry.detail}`);
  info(`  → ${entry.nextAction}`);
}

/** `doctor` — the same inspection, answered as "is anything wrong, and what do I run".
 *
 *  Exits non-zero when something blocking was found, because that is the only part of the
 *  answer a script or a CI step can act on without reading the text. Warnings do not fail
 *  it: an instance with no lock file works, and a command that fails on everything it has
 *  an opinion about stops being consulted. */
export const DOCTOR_ARGUMENTS = [
  { name: "json", description: "Verdict and next actions as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

export const DOCTOR = commandBody({
  effect: "read",
  arguments: DOCTOR_ARGUMENTS,
  async run(ctx, plan) {
    const jsonOnly = plan.json;

    const inspection = await gatherInspection(ctx);
    // The security gate: only doctor and accept run it — a container exec per audit, twice —
    // so its findings are merged in here rather than gathered inside gatherInspection() itself.
    const security = await runSecurityAudit(ctx);
    const problems = [...inspection.problems, ...security.problems];
    const blocking = blockingProblems(problems);
    const warnings = problems.filter((entry) => entry.severity === "warning");

    if (!jsonOnly && !isCaptured()) printObservationInventory(inspection);
    if (jsonOnly || isCaptured()) {
      emit(
        `${JSON.stringify(
          {
            deployment: inspection.declared.deployment,
            healthy: isHealthy(inspection) && blockingProblems(security.problems).length === 0,
            problems,
            observed: inspection.observed,
            security: security.findings,
            nextActions: [...nextActions(problems), ...lockNext(inspection).map((entry) => renderAdvice(entry))],
            next: [...nextAdvice(problems), ...lockNext(inspection)],
          },
          null,
          2,
        )}\n`,
      );
    } else if (problems.length === 0) {
      log(`${inspection.declared.deployment} is what this repository declares`);
      info(`state  running (${inspection.observed.health ?? "unknown"})`);
    } else {
      // Reported before the failure below, not instead of it: a reader who only sees "3
      // problems" learns nothing, and the whole point of the codes is that they travel.
      log(`${inspection.declared.deployment}: ${blocking.length} blocking, ${warnings.length} warning(s)`);
      for (const entry of problems) printProblem(entry);
      const suppressed = security.findings.filter((finding) => finding.suppressed);
      for (const finding of suppressed) {
        info(`SUPPRESSED  ${finding.source} ${finding.checkId}: ${finding.message} (${finding.suppressedReason})`);
      }
      if (blocking.length === 0) info(isHealthy(inspection) ? "nothing blocking — the instance is doing its job" : "nothing blocking — operational health is impaired or unconfirmed");
    }

    if (blocking.length > 0) {
      throw new Error(
        `${blocking.length} blocking problem(s): ${blocking.map((entry) => entry.code).join(", ")}. ` +
          `Next: ${nextActions(blocking).join(", ")}`,
      );
    }
  },
});

export const doctor = (ctx: Context, args: string[]): Promise<void> => runOnContext(DOCTOR, ctx, args);

function printObservationInventory(inspection: Inspection): void {
  const { observed } = inspection;
  const lock = observed.instanceLock;
  if (lock !== undefined) {
    info(`instanceLock ${lock.state} host=${lock.host ?? "unknown"} pid=${lock.pid ?? "unknown"} birth=${lock.startedAt ?? "unknown"} operation=${lock.operation ?? "unknown"} ageMs=${lock.ageMs ?? "unknown"} heartbeatAgeMs=${lock.heartbeatAgeMs ?? "unknown"}`);
    info(`  → ${renderAdvice(instanceLockAdvice(lock))}`);
  }
  const accounts = observed.channels?.channelAccounts;
  if (accounts === undefined) info("channels   unknown");
  else if (Object.keys(accounts).length === 0) info("channels   (none)");
  else for (const [channel, entries] of Object.entries(accounts).slice(0, 32)) {
    if (!Array.isArray(entries)) continue;
    for (const account of entries.slice(0, 64)) {
      const facts = account as Record<string, unknown>;
      info(`channel    ${channel}/${facts.accountId}: ${Object.entries(facts).filter(([key]) => key !== "accountId").map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ")}`);
    }
  }
  if (observed.memory === undefined) info("memory     unknown");
  else if (observed.memory.length === 0) info("memory     (no agent facts)");
  else for (const memory of observed.memory.slice(0, 64)) info(`memory     agent-${memory.agent} agentId=${memory.agentId ?? "unchecked"} backend=${memory.backend ?? "unchecked"} provider=${memory.provider ?? "unchecked"} requestedProvider=${memory.requestedProvider ?? "unchecked"} model=${memory.model ?? "unchecked"} ${memory.state} scanned=${memory.scannedFiles ?? "unknown"} indexedFiles=${memory.files ?? "unknown"} chunks=${memory.chunks ?? "unknown"} dirty=${memory.dirty ?? "unknown"} metadata=${memory.indexIdentity} fts=${memory.fts} vector=${memory.vector} embedding=${memory.embedding}`);
}

function renderText(inspection: Inspection): void {
  const { declared, observed, problems } = inspection;

  printObservationInventory(inspection);
  log(`deployment ${declared.deployment}`);
  info(`state      ${observed.running ? `running (${observed.health ?? "unknown"})` : "not running"}`);
  if (observed.image !== undefined) info(`image      ${observed.image}`);
  if (observed.imageDigest !== undefined) info(`digest     ${observed.imageDigest}`);
  if (observed.frameworkVersion !== undefined) info(`framework  ${observed.frameworkVersion}`);
  if (observed.openclawVersion !== undefined) info(`openclaw   ${observed.openclawVersion}`);
  if (Object.keys(observed.probes).length > 0) {
    info(`probes     ${Object.entries(observed.probes).map(([name, code]) => `${name} ${code}`).join("  ")}`);
  }
  if (observed.egress !== undefined && observed.egress.length > 0) {
    info(`egress     ${observed.egress.map((entry) => `${entry.endpoint} ${entry.state}`).join("  ")}`);
  }

  log("declared vs live");
  info(`config     ${declared.config.length} declared setting(s), ${problems.filter((entry) => entry.code === "CONFIG_DRIFT").length} drifted`);
  info(`secrets    ${observed.secrets.filter((entry) => entry.present).length}/${observed.secrets.length} present`);
  info(`recipes    ${declared.recipes.length === 0 ? "(none)" : declared.recipes.join(", ")}`);
  if (observed.agents === undefined) info("agents     unknown (CLI read failed)");
  else if (observed.agents.length > 0) info(`agents     ${observed.agents.join(", ")}`);
  if (observed.mcpServers === undefined) info("mcp        unknown (CLI read failed)");
  else if (observed.mcpServers.length > 0) info(`mcp        ${observed.mcpServers.join(", ")}`);
  if (observed.cronJobs === undefined) info("cron       unknown (CLI read failed)");
  else if (observed.cronJobs.length > 0) info(`cron       ${observed.cronJobs.join(", ")}`);
  if (observed.foreignObjects.length > 0) {
    info(`foreign    ${observed.foreignObjects.map((entry) => `${entry.kind}:${entry.name}`).join(", ")} (not created by this framework — never touched)`);
  }

  if (problems.length === 0) {
    log("no problems found");
    return;
  }

  log(`${problems.length} problem(s), ${blockingProblems(problems).length} blocking`);
  for (const entry of problems) printProblem(entry);
}
