// `clawwright set try --set <artifact>` — install a set into a throwaway instance, run its
// acceptance checks, tear it down: "does it actually work" without touching the real
// deployment.
//
// Reuses bootstrap's order of operations, --set's source override, provision-agent's
// reconciliation, runCheck's check kinds. New here is the throwaway home (deployment
// directory, data path, port) so teardown removes only what this operation created.

import { mkdir, writeFile, rm, cp } from "node:fs/promises";
import { join, dirname, resolve, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { log, info, warn, die, maskSecrets, registerSecret, UserError } from "#src/core/io/log.ts";
import { format, tryParse } from "#src/runtime/docker/image-ref.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { parseEnv, serializeEnvLine, frameworkRoot, readEnvFileText } from "#src/core/env.ts";
import { useDeployment, deploymentDir, composeProjectOverride, useComposeProjectOverride, composeProjectName, envFile } from "#src/runtime/deployment.ts";
import { createContext } from "#src/core/context.ts";
import { readIfExists } from "#src/runtime/transport/transport.ts";
import type { Context } from "#src/core/context.ts";
import { mountPoints } from "#src/runtime/mounts.ts";
import { useSetSource, clearSetSource, setSourceDir } from "#src/set/artifacts/source.ts";
import { recordInstalledSet, unpackArtifactVerified } from "#src/set/artifacts/install.ts";
// From its own module, not set.ts: set.ts reads SET_TRY_ARGUMENTS at load, so importing it
// back here is a cycle that fails with a TDZ error when set-try is the entry.
import { localSecretValues } from "./set-secrets-guard.ts";
import type { LocalArtifact } from "#src/core/values/plan.ts";
import * as kinds from "#src/core/values/kinds.ts";
import { ensureDataDirs, ensureSecretsFile, secretsFileOnTarget, runMaybePrivileged } from "#src/runtime/files/datadir.ts";
import { ensureBaselineConfig, configureProvider } from "#src/commands/management/configuration/credentials/provider.ts";
import { applyConfig } from "#src/commands/orchestration/config.ts";
import { preflightSecrets } from "#src/commands/management/configuration/secrets.ts";
import { down } from "#src/commands/lifecycle/instance/control.ts";
import { loadSecrets } from "#src/commands/lifecycle/state.ts";
import { createPrivateFile, protectPrivateDirectory } from "#src/security/privacy/private-file.ts";
import { provisionAgent } from "#src/commands/management/provision-agent/index.ts";
import { runCheck, requiresModel, summarize } from "#src/commands/orchestration/accept.ts";
import { withModelApproval } from "#src/service/openclaw-cli.ts";
import type { AcceptanceResult } from "#src/commands/orchestration/accept.ts";
import { observeRuntime, runtimeMatches, saveEvidence } from "#src/set/artifacts/evidence.ts";
import type { ObservedRuntime } from "#src/set/artifacts/evidence.ts";
import { findFreePort, tryDeploymentName, targetSiblingRoot, buildEnv, tryTargetProblem } from "./set-try-env.ts";
import { defineAction, type ArgumentSpec } from "#src/core/command/index.ts";

export * from "./set-try-env.ts";

// The same kind object prepare derives through, so the plan carries the resolve's
// LocalArtifact: a missing artifact is refused at prepare, before the .env/secrets reads.
const SET_ARTIFACT = kinds.localFile("a set artifact path");

export const SET_TRY_ARGUMENTS = [
  { name: "set", description: "Built set artifact", kind: "option", valueName: "artifact", required: true, value: SET_ARTIFACT },
  {
    name: "with-model",
    summary: "Include model checks",
    description: "With try: include acceptance checks that call the model",
    kind: "flag",
  },
  {
    name: "keep",
    summary: "keep the throwaway instance instead of removing it",
    description: "With try: keep the throwaway instance running instead of removing it",
    kind: "flag",
  },
  { name: "json", summary: "Emit the trial report as JSON", description: "Emit the trial report as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

const SCAFFOLD_MODULES: Record<string, string> = {
  app: "core/app",
  mounts: "runtime/mounts",
  "commands/index": "commands/interface/index",
};

export function setTryModuleUrl(name: string, extension: string, sourceRoot = frameworkRoot): string {
  const module = SCAFFOLD_MODULES[name];
  if (module === undefined) throw new Error(`unknown temporary app module: ${name}`);
  return pathToFileURL(resolve(sourceRoot, `${module}${extension}`)).href;
}

export interface TryReport {
  readonly name: string;
  readonly setId: string;
  readonly setName: string;
  readonly serviceUrl: string;
  readonly acceptance: {
    readonly passed: number;
    readonly failed: number;
    readonly notChecked: number;
    readonly couldNotCheck: number;
    readonly summary: string;
    readonly results: Record<string, AcceptanceResult[]>;
  };
  readonly healthy: boolean;
  readonly torndown: boolean;
  readonly receipt?: { id: string; setId: string; verdict: string };
}

export interface TryTeardownResult {
  readonly torndown: boolean;
  readonly running: boolean;
  readonly error?: unknown;
}

/** Parsed inputs for an isolated set trial. The run-level entry keeps the resolved path:
 *  the action's plan carries the LocalArtifact (prepare's artifact fact), and the run
 *  adapts it to the path the trial engine unpacks. */
export interface SetTryOptions {
  readonly artifact: string;
  readonly withModel: boolean;
  readonly keep: boolean;
  readonly jsonOnly: boolean;
}

/** The action's plan: the artifact already proven present at prepare. */
interface SetTryPlan {
  readonly artifact: LocalArtifact;
  readonly withModel: boolean;
  readonly keep: boolean;
  readonly jsonOnly: boolean;
}

/** The artifact and explicit execution options. */

/** Stops and removes only the resources owned by a try. Callbacks are injectable so the
 * lifecycle contract can be tested without Docker. */
export async function teardownTry(
  ctx: Context,
  dataRoot: string,
  keep: boolean,
  operations: {
    down?: (ctx: Context) => Promise<void>;
    remove?: (ctx: Context, dataRoot: string) => Promise<void>;
  } = {},
): Promise<TryTeardownResult> {
  let running = false;
  try {
    running = await ctx.runtime.isRunning();
  } catch {
    // Unanswerable: not called running, not called torn down either.
  }
  if (keep) return { torndown: false, running };

  let error: unknown;
  // Unconditional: a failed bootstrap can leave a stopped container/network behind, while
  // isRunning() only reports the process, not the project.
  try {
    await (operations.down ?? ((target) => down(target, [])))(ctx);
  } catch (failure) {
    error = failure;
  }
  // If compose teardown failed, leave the data in place: deleting a bind mount an orphaned
  // container still uses is worse than reporting a recoverable leftover.
  if (error === undefined) {
    try {
      await (operations.remove ?? ((target, root) => runMaybePrivileged(target, root, "rm", ["-rf", root])))(ctx, dataRoot);
    } catch (failure) {
      error = failure;
    }
  }
  return { torndown: error === undefined, running, ...(error === undefined ? {} : { error }) };
}

/** `set try`'s run; `dependencies` lets the checks drive it without Docker. */
export async function runSetTry(ctx: Context, options: SetTryOptions, dependencies: {
  createContext?: typeof createContext;
  findFreePort?: typeof findFreePort;
  protectPrivateDirectory?: typeof protectPrivateDirectory;
  createPrivateFile?: typeof createPrivateFile;
} = {}): Promise<void> {
  return withModelApproval(options.withModel, () => setTryInScope(ctx, options, dependencies));
}

async function setTryInScope(ctx: Context, options: SetTryOptions, dependencies: {
  createContext?: typeof createContext;
  findFreePort?: typeof findFreePort;
  protectPrivateDirectory?: typeof protectPrivateDirectory;
  createPrivateFile?: typeof createPrivateFile;
} = {}): Promise<void> {
  const startedAt = new Date().toISOString();
  const { artifact, withModel, keep, jsonOnly } = options;

  // Gathered from the real deployment before useDeployment() points at the throwaway one —
  // a set carries secret NAMES only, never values. Two sources; live wins when both answer,
  // since a host-side secret store can be stale but a running instance's value cannot be.
  const realDir = deploymentDir();
  const previousSource = setSourceDir();
  // The throwaway's createContext() clears this too (its .env has no OC_COMPOSE_PROJECT),
  // so it's restored in the same finally block a caller reusing the original Context needs.
  const previousComposeProject = composeProjectOverride();
  const realEnv = parseEnv(await readEnvFileText().catch(() => ""), envFile());
  const targetLocation = (realEnv.OC_TARGET_LOCATION ?? "auto").toLowerCase();
  const targetProblem = tryTargetProblem(targetLocation);
  if (targetProblem !== undefined) die(targetProblem);
  const secretValues: Record<string, string> = Object.fromEntries(
    (await localSecretValues()).map(({ name, value }) => [name.replace(/ \([^)]*\)$/, ""), value]),
  );
  // Refused before the target is contacted: a typo'd --set path must not cost a read of
  // the live secrets file, and an unreachable target must not mask the local refusal.
  const unpacked = await unpackArtifactVerified(artifact);
  const staging = unpacked.staging;
  // Register local values before the target read: a transport failure may echo one verbatim.
  for (const value of Object.values(secretValues)) registerSecret(value);
  const liveSecretsPath = secretsFileOnTarget(ctx);
  let liveSecrets: string | undefined;
  try {
    // The read contract (S3.4): absent is "no live secrets yet" (as before); unknown
    // refuses with Advice instead of the old plain-text die that stripped it.
    const liveRead = await readIfExists(ctx.transport, liveSecretsPath);
    if (liveRead.kind === "present") liveSecrets = liveRead.value;
  } catch (readFailure) {
    // The throw leaves before the outer finally runs: staging goes by hand first.
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    // Registered values must not travel in the refusal text: the masked message keeps the
    // read contract's Advice and the original failure as its cause.
    const advice = (readFailure as { advice?: readonly never[] }).advice;
    throw new UserError(maskSecrets(readFailure instanceof Error ? readFailure.message : String(readFailure)), {
      cause: readFailure,
      ...(advice === undefined ? {} : { advice: advice as never }),
    });
  }
  // Registered so a transport error that echoes one of these values is masked when the
  // failure is reported — including the read failure right below.
  if (liveSecrets !== undefined) {
    Object.assign(secretValues, parseEnv(liveSecrets, liveSecretsPath));
    for (const value of Object.values(secretValues)) registerSecret(value);
  }

  // deploymentName() derives the compose project name from the directory basename, so
  // tryName must already be lowercase-and-hyphens (unlike mkdtemp's random suffix, which
  // can contain uppercase and compose rejects).
  const tryName = tryDeploymentName();
  // Under the checkout: a WSL/SSH path bridge can express this location on the target,
  // a random host temp directory cannot be mapped by SSH.
  const tempDir = join(realDir, "sets", ".tries", tryName);
  let tempDirCreated = false;
  const dataRoot = targetSiblingRoot(realEnv.OC_DATA_DIR ?? "/tmp/openclaw/data", tryName);

  let report: TryReport | undefined;
  let teardownError: unknown;
  let operationError: unknown;
  let ownsTarget = false;
  let observedBefore: ObservedRuntime | undefined;
  let observedAfter: ObservedRuntime | undefined;
  let provisioned = false;

  try {
    const { manifest, id } = unpacked.verified;

    // Acceptance, secret names and the image grammar are the unpack gate's verdict
    // (unpackArtifactVerified → loadSet/validateLoadedSet, with the files present) — no second
    // check here (R32-05). The parsed image is what reaches the .env, the same format(ref)
    // string the upgrade path guarantees.
    const imageRef = tryParse(manifest.requires.image)!;

    const targetLines = manifest.secrets
      .filter((name) => name !== "OPENCLAW_GATEWAY_TOKEN" && secretValues[name] !== undefined)
      .map((name) => serializeEnvLine(name, secretValues[name]));

    await mkdir(dirname(tempDir), { recursive: true });
    await mkdir(tempDir);
    tempDirCreated = true;
    await (dependencies.protectPrivateDirectory ?? protectPrivateDirectory)(tempDir);
    await cp(staging, tempDir, { recursive: true });

    const port = await (dependencies.findFreePort ?? findFreePort)();
    const token = randomBytes(24).toString("hex");

    await mkdir(join(tempDir, "config"), { recursive: true });
    const extension = extname(fileURLToPath(import.meta.url));
    // Absolute file:// URL, never a relative specifier: tempDir and frameworkRoot can sit on
    // different Windows drives, where a relative path can't cross between them.
    // pathToFileURL is drive-agnostic and correct on POSIX too.
    await writeFile(join(tempDir, "app.ts"),
      `import { defineApp } from ${JSON.stringify(setTryModuleUrl("app", extension))};\n` +
      `import { mountPoints } from ${JSON.stringify(setTryModuleUrl("mounts", extension))};\n` +
      `import { openclawCommands } from ${JSON.stringify(setTryModuleUrl("commands/index", extension))};\n` +
      `export default defineApp({name:${JSON.stringify(tryName)},description:"temporary set instance",service:{name:"gateway"},mounts:mountPoints,commands:openclawCommands});\n`);
    await (dependencies.createPrivateFile ?? createPrivateFile)(
      join(tempDir, ".env"),
      buildEnv({ port, token, image: format(imageRef), dataRoot, copiedFrom: realEnv }),
    );

    useDeployment(tempDir);
    useSetSource(staging);

    let tryCtx: Context;
    try {
      tryCtx = await (dependencies.createContext ?? createContext)({ mounts: mountPoints, service: { name: "gateway", logTail: "100" } });
    } catch (error) {
      // Preserve the real target/path error through the outer restoration cleanup.
      operationError = error;
      throw error;
    }

    try {
      log(`bringing up a throwaway instance "${tryName}" on port ${port}`);
      // Verify the path bridge and target-side port before creating data directories — a
      // local port probe can't see an SSH/WSL target's listeners.
      await tryCtx.paths.toTarget(tempDir);
      const conflict = await tryCtx.runtime.portConflict(String(port));
      if (conflict !== undefined) die(`throwaway port ${port} is already used on the target by ${conflict}`);
      await runMaybePrivileged(tryCtx, dataRoot, "mkdir", [dataRoot]);
      ownsTarget = true;
      // trustExisting: dataRoot is the mkdir this call just ran, not pre-existing.
      await ensureDataDirs(tryCtx, { trustExisting: true });
      await ensureSecretsFile(tryCtx);

      // Values only, never the gateway token (this instance generated its own). Anything
      // the set needs but this machine doesn't know is left absent for preflightSecrets to report.
      if (targetLines.length > 0) {
        await loadSecrets(tryCtx, `${targetLines.join("\n")}\n`);
      }

      await tryCtx.runtime.pullImage();
      await ensureBaselineConfig(tryCtx);
      // Same order as bootstrap: a new provider's baseUrl/models must exist before OpenClaw
      // accepts an apiKey for it. restartAdvice: false since this instance starts below anyway.
      await applyConfig(tryCtx, [], { restartAdvice: false });
      await configureProvider(tryCtx, []);
      await preflightSecrets(tryCtx);

      await tryCtx.runtime.start();
      await tryCtx.runtime.waitForHealth();
      log(`throwaway instance healthy: ${tryCtx.settings.serviceUrl}`);

      // Per recipe, not all-or-nothing: one failed provision must not stop the report on
      // the others or abort before acceptance checks run.
      const provisionError = new Map<string, string>();
      for (const [recipe, recipeEntry] of Object.entries(manifest.recipes)) {
        if (recipeEntry.agent === undefined) continue;
        try {
          await provisionAgent(tryCtx, [recipe]);
        } catch (error) {
          provisionError.set(recipe, error instanceof Error ? error.message : String(error));
          warn(`recipe "${recipe}" did not provision — its acceptance checks are reported as could-not-check`);
        }
      }

      await recordInstalledSet(tryCtx, manifest, id);
      provisioned = provisionError.size === 0;
      observedBefore = await observeRuntime(tryCtx, manifest);

      const results: Record<string, AcceptanceResult[]> = {};
      let passed = 0;
      let failed = 0;
      let notChecked = 0;
      let couldNotCheck = 0;
      for (const [recipe, checks] of Object.entries(manifest.acceptance)) {
        const recipeResults: AcceptanceResult[] = [];
        const failure = provisionError.get(recipe);
        for (const check of checks) {
          if (failure !== undefined) {
            recipeResults.push({ name: check.name ?? check.kind, kind: check.kind, status: "could-not-check", detail: `recipe did not provision: ${failure}` });
            couldNotCheck += 1;
            continue;
          }
          if ((requiresModel(check.kind) || check.usesModel === true) && !withModel) {
            recipeResults.push({ name: check.name ?? check.kind, kind: check.kind, status: "not-checked", detail: "calls the model — pass --with-model to include it" });
            notChecked += 1;
            continue;
          }
          const result = await runCheck(tryCtx, recipe, check);
          recipeResults.push(result);
          if (result.status === "passed") passed += 1;
          else if (result.status === "failed") failed += 1;
          else if (result.status === "could-not-check") couldNotCheck += 1;
          else notChecked += 1;
        }
        results[recipe] = recipeResults;
      }
      // A recipe with no acceptance checks would otherwise vanish from the report entirely
      // instead of just not adding to the counts above.
      for (const [recipe, failure] of provisionError) {
        if ((results[recipe]?.length ?? 0) > 0) continue;
        results[recipe] = [{ name: "provision", kind: "provision", status: "could-not-check", detail: failure }];
        couldNotCheck += 1;
      }

      report = {
        name: tryName,
        setId: id,
        setName: manifest.name,
        serviceUrl: tryCtx.settings.serviceUrl,
        acceptance: {
          passed,
          failed,
          notChecked,
          couldNotCheck,
          summary: summarize(passed, failed, notChecked, couldNotCheck),
          results,
        },
        healthy: Object.values(results).some((entries) => entries.length > 0)
          && failed === 0 && notChecked === 0 && couldNotCheck === 0,
        torndown: !keep,
      };
      observedAfter = await observeRuntime(tryCtx, manifest);
    } catch (error) {
      // Keep the lifecycle result machine-readable: a thrown error without a report makes
      // a failed try indistinguishable from one never attempted.
      operationError = error;
      report = {
        name: tryName,
        setId: id,
        setName: manifest.name,
        serviceUrl: tryCtx.settings.serviceUrl,
        acceptance: {
          passed: 0,
          failed: 0,
          notChecked: 0,
          couldNotCheck: 0,
          summary: "0 passed, 0 failed",
          results: {},
        },
        healthy: false,
        torndown: false,
      };
    } finally {
      const teardown = ownsTarget
        ? await teardownTry(tryCtx, dataRoot, keep)
        : { torndown: true, running: false };
      teardownError ??= teardown.error;
      if (keep && ownsTarget) {
        info(teardown.running
          ? `--keep: instance "${tryName}" left running at ${tryCtx.settings.serviceUrl}, data at ${dataRoot}`
          : `--keep: instance "${tryName}" was not confirmed running; inspect it before cleanup, data at ${dataRoot}`);
        // --app selects apps/<name> only, so no gate invocation can address a throwaway
        // directory. The compose teardown is not spelled out: its env file is a private
        // temporary one that compose operations write to the target and remove after each call
        // (docs/internal/backlog-p3.md), so a command line built here would name a path that
        // does not exist.
        info(`deployment retained at ${tempDir} (compose project ${composeProjectName()}); the gate cannot address a throwaway directory — stop its containers by hand when done,`);
        info(`  then remove the data root ${dataRoot} and the directory ${tempDir}`);
      }
    }
  } finally {
    clearSetSource();
    useDeployment(realDir);
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    // --keep retains only a try that owned target resources; a failure before one exists
    // (path bridge, port conflict) leaves nothing behind to keep.
    if ((!keep || !ownsTarget) && teardownError === undefined && tempDirCreated) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        teardownError ??= error;
      }
    }
    if (previousSource === undefined) clearSetSource();
    else useSetSource(previousSource);
    useComposeProjectOverride(previousComposeProject);
  }

  // Unreachable as a branch — the catch above always leaves a report (its one throw,
  // createContext's, rethrows out of the catch itself) — kept as the narrowing the reads
  // below need.
  if (report === undefined) die("set try did not produce a report");
  if (!keep || !ownsTarget) report = { ...report, torndown: teardownError === undefined };

  const observed = observedAfter ?? observedBefore ?? { observations: { frameworkVersion: "unknown" }, digests: [] };
  const receipt = await saveEvidence({
    verified: unpacked.verified,
    source: "set-try",
    startedAt,
    withModel,
    selected: Object.keys(unpacked.verified.manifest.acceptance),
    results: report.acceptance.results,
    observed,
    subjectVerified: provisioned && operationError === undefined && teardownError === undefined
      && observedBefore !== undefined && observedAfter !== undefined
      && runtimeMatches(unpacked.verified.manifest, observedBefore, observedAfter),
    failure: operationError instanceof Error ? operationError.message : undefined,
    root: realDir,
  });
  report = { ...report, receipt: { id: receipt.receiptId, setId: receipt.setId, verdict: receipt.verdict } };

  if (jsonOnly || isCaptured()) {
    emit(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    log(`set "${report.setName}" (${report.setId.slice(0, 12)}…) tried on throwaway instance "${report.name}"`);
    if (Object.keys(report.acceptance.results).length === 0) {
      info("the set declares no acceptance checks — the instance came up, but nothing was verified");
    } else {
      info(`acceptance: ${report.acceptance.summary}`);
      for (const [recipe, checks] of Object.entries(report.acceptance.results)) {
        for (const entry of checks) {
          const mark = entry.status === "passed" ? "ok  " : entry.status === "failed" ? "FAIL" : entry.status === "not-checked" ? "WAIT" : "?   ";
          info(`  ${mark} ${recipe}/${entry.name}${entry.detail === undefined ? "" : ` — ${entry.detail}`}`);
        }
      }
    }
    info(report.torndown ? "torn down — nothing left behind" : `instance resources retained; deployment at ${tempDir}, data at ${dataRoot}`);
    info(`receipt: ${receipt.receiptId} (${receipt.verdict})`);
  }

  if (teardownError !== undefined) {
    warn(`teardown had a problem: ${teardownError instanceof Error ? teardownError.message : String(teardownError)}`);
    warn(`check for a leftover instance — data root was ${dataRoot}`);
    if (operationError === undefined) throw new Error(`throwaway instance cleanup failed: ${teardownError instanceof Error ? teardownError.message : String(teardownError)}`);
  }

  // Preserve the original failure after emitting the report and restoring the caller's context.
  if (typeof operationError !== "undefined") throw operationError;

  if (report.acceptance.failed > 0 || report.acceptance.couldNotCheck > 0) {
    throw new Error(`${report.acceptance.failed + report.acceptance.couldNotCheck} acceptance check(s) did not pass on the throwaway instance`);
  }
}

export const SET_TRY = defineAction({
  summary: "Try a set in a throwaway instance",
  effect: "destroy",
  arguments: SET_TRY_ARGUMENTS,
  prepare: async (call) => ({
    // The resolved set artifact arrives in the plan's own key slot (S2.5): a missing
    // artifact is refused by the kind's resolve, before the .env/secrets reads.
    artifact: call.values.set,
    withModel: call.values["with-model"],
    keep: call.values.keep,
    jsonOnly: call.values.json,
  } satisfies SetTryPlan),
  run: (ctx, plan) => runSetTry(ctx, { ...plan, artifact: plan.artifact.path }),
});
