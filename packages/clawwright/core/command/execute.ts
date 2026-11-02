// The one execution pipeline for the console and MCP: parse → confirm → prepare →
// environment → context → run. Every stage's failure is returned (never thrown) as an
// Execution, so a surface decides how to report it; the terminal `--json` failure document
// (entry/cli.ts's former reportJsonFailure) is emitted here, once for both surfaces' caller.
//
// Not re-exported from core/command/index.ts: this file pulls the runtime and integration
// layers (context, transport, environment provisioning), which the declaration model must not.

import type { AppCommand, AppDefinition } from "#src/core/app.ts";
import { callFacts, callFactsFor, legacyPreparesEnvironment, type CallFacts, type EffectShape } from "#src/core/command/effect.ts";
import { ArgumentError, ConfirmationRequiredError, LateArgumentError, UnknownArgumentError } from "#src/core/command/errors.ts";
import { bindNamed, isVerbatim, parseCall, selectAction, tokenize, type CallInput, type CallShape } from "#src/core/command/parse/index.ts";
import { localScope, NOTHING, preparedPlan, specData, specOf, specShape, unitNeeds, type CommandBody, type DeploymentScope, type LocalScope, type ParsedCall } from "#src/core/command/spec.ts";
import { argumentsView } from "#src/core/command/view.ts";
import { createContext, type Context, type ContextOptions } from "#src/core/context.ts";
import { maskSecrets, UserError, CommandFailedError } from "#src/core/io/log.ts";
import { renderCurrentAdviceRows } from "#src/core/io/invocation/render.ts";
import { emit, machineWritesCount, stdoutBytesWritten } from "#src/core/io/output.ts";
import { useApplicationRecipesDir, envFile } from "#src/runtime/deployment.ts";
import { createTransport, type Transport } from "#src/runtime/transport/transport.ts";
import { clearRecipesDir } from "#src/service/recipe.ts";
import { ensureEnvironment, provisioningWrote } from "#src/integration/provision.ts";

/** How and by whom a command is run. */
export interface CommandIo {
  readonly surface: "terminal" | "mcp";
  /** MCP: the call carried confirm: true. */
  readonly confirmed?: boolean;
  /** Checks' seam, the way ContextOptions.transport is: stands in for the transport both
   *  createContext and the deployment scope would otherwise build. */
  readonly transport?: Transport;
  readonly observe?: (stage: Stage) => void;
}

/** Where a call stopped: parse → confirm → prepare → environment → context → run. */
export type Stage = "parse" | "confirm" | "prepare" | "environment" | "context" | "run";

/** A returned failure: which stage refused, with what. `facts` is set from the confirm
 *  stage on, for the MCP envelope. */
export interface Execution {
  readonly stage: Stage;
  readonly error?: unknown;
  readonly facts?: CallFacts;
  readonly reachedRun: boolean;
  readonly environmentWrote?: boolean;
  readonly exitCode?: number;
}

/** The deployment scope `needs: "deployment"` commands run on: the local view plus the
 *  service name and a transport selected from the .env location settings — no Settings
 *  parse, no Context (recover-env exists to repair the facts a Context is built from). */
export async function deploymentScope(app: AppDefinition, io: CommandIo): Promise<DeploymentScope> {
  const local = localScope();
  const env = await local.env();
  if (env === undefined) throw new UserError(`${envFile()} does not exist`);
  const transport = io.transport ?? await createTransport({
    location: env.OC_TARGET_LOCATION,
    wslDistro: env.OC_WSL_DISTRO,
    sshHost: env.OC_SSH_HOST,
  });
  return { ...local, service: app.service?.name ?? "app", transport: async () => transport };
}

/** Whether the call selects a declared `json` flag: the chosen action's own arguments when an
 *  action was parsed, the flat declaration otherwise (the parse stage has no action yet). */
function declaresJsonFlag(declared: readonly { readonly name: string; readonly kind: string }[] | undefined, shape: EffectShape | undefined, action: string | undefined): boolean {
  const has = (args: readonly { readonly name: string; readonly kind: string }[] | undefined): boolean =>
    args?.some((argument) => argument.name === "json" && argument.kind === "flag") === true;
  if (shape === undefined || shape.actions === undefined) {
    return has(declared);
  }
  return action === undefined ? false : has(shape.actions[action]?.arguments);
}

/** The legacy AppCommand path's json decision: the tokenizer over the flat declaration —
 *  a `--json` an option swallows as its value does not request the document, and a
 *  tokenizer refusal means the parser refuses the call, so json is never bound either. */
function legacyJsonGiven(command: AppCommand, argv: readonly string[]): boolean {
  try {
    return tokenize(command.arguments ?? [], argv).given.includes("json");
  } catch {
    return false;
  }
}

/** The pre-parse stand-in for a parsed call's `given`: the real tokenizer (parse.ts's
 *  tokenize, bound to the action selectAction would choose and the same verbatim-tail
 *  decision) over the raw argv — so an option's value (`--interval --json`), a repeated
 *  option (`--profile full --profile --json`), `--opt=value --json` and a post-`--` token
 *  read exactly as the parser reads them. A strict refusal aborts the scan, so the longest
 *  clean prefix answers for what the parser DID bind before it stopped: a `--json` given
 *  ahead of the refused token counts (decision Q3: a gate refusal under --json prints the
 *  document), one an option swallowed as its value does not (that case never throws). */
function jsonTokenGiven(shape: CallShape & EffectShape, argv: readonly string[]): boolean {
  try {
    const chosen = selectAction(shape, { kind: "argv", argv });
    const declared = chosen.slice;
    const action = chosen.selected.name;
    // Deliberately no `refuse` here: the probe reads what the tokenizer binds, not what the
    // declaration refuses ahead of tokenizing.
    const scope = action === undefined ? undefined : { action, siblings: chosen.siblings };
    try {
      const tokens = tokenize(declared, chosen.rest, scope, isVerbatim(declared));
      return tokens.given.includes("json");
    } catch {
      // A strict refusal aborts the scan; the parser DID bind everything before the refused
      // token, so the longest clean prefix answers for it. A `--json` an option swallowed as
      // its value never counts (that case does not throw — the strict scan above reads it).
      for (let end = chosen.rest.length - 1; end > 0; end -= 1) {
        try {
          return tokenize(declared, chosen.rest.slice(0, end), scope, isVerbatim(declared)).given.includes("json");
        } catch {
          continue;
        }
      }
      return false;
    }
  } catch {
    return false;
  }
}

/** Deep-masks a JSON-ready value — strings and keys — the way the MCP envelope masks its
 *  own, so a secret that reached an advice argv cannot ride the failure document out. */
/** The terminal `--json` failure document (one writer for both paths' failed closures): the
 * masked message plus, as data (rf6-fix30), the refusal's remedy — the advice a UserError
 * carries is the success documents' `next`, nextActions its rendered form, masked alike. */
function emitJsonFailureDocument(error: unknown): void {
  const message = maskSecrets(error instanceof Error ? error.message : String(error));
  const advice = error instanceof UserError ? error.advice : [];
  emit(`${JSON.stringify({
    error: { message },
    ...(advice.length === 0 ? {} : {
      nextActions: [...new Set(advice.flatMap(renderCurrentAdviceRows).map(maskSecrets))],
      next: advice.map(maskedJson),
    }),
  }, null, 2)}\n`);
}

function maskedJson(value: unknown): unknown {
  if (typeof value === "string") return maskSecrets(value);
  if (Array.isArray(value)) return value.map(maskedJson);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[maskSecrets(key)] = maskedJson(entry);
    return out;
  }
  return value;
}

/** The context both spec and legacy target commands run on: built here, not by the command —
 *  an application never constructs a transport itself. */
function contextOptions(app: AppDefinition, io: CommandIo): ContextOptions {
  return {
    mounts: app.mounts,
    service: app.service,
    settings: app.settings,
    secrets: app.secrets,
    afterBackup: app.afterBackup,
    beforeRestore: app.beforeRestore,
    transport: io.transport,
  };
}

/** The one pipeline. Precondition: `app.commands[name]` exists and `--help` was handled by
 *  the caller. Takes a CallInput: the console passes {kind:"argv"}, an MCP tool call
 *  {kind:"named"}. A legacy command (no spec) runs exactly as before: argv as is, its own
 *  predicates deciding environment preparation. */
export async function executeCommand(app: AppDefinition, name: string, input: CallInput, io: CommandIo): Promise<Execution> {
  const command = app.commands[name]!;
  const entry = specOf(command);
  const writesAtStart = machineWritesCount();
  const stdoutAtStart = stdoutBytesWritten();

  // Terminal `--json` failure contract: a command invoked with its own declared --json flag
  // that fails still prints a machine-readable answer, unless it already printed (or
  // streamed) something of its own. Never for an unknown-argument error — that is reported as such.
  let environmentWrote = false;
  const failed = (stage: Stage, error: unknown, facts?: CallFacts, shape?: EffectShape, action?: string, jsonGiven?: boolean): Execution => {
    io.observe?.(stage);
    environmentWrote ||= provisioningWrote(error);
    if (io.surface === "terminal" && !(error instanceof UnknownArgumentError)
      && declaresJsonFlag(command.arguments, shape, action)
      && (jsonGiven ?? false)
      && machineWritesCount() === writesAtStart && stdoutBytesWritten() === stdoutAtStart) {
      emitJsonFailureDocument(error);
    }
    return { stage, error, reachedRun: stage === "run", ...(stage === "run" && error instanceof CommandFailedError ? { exitCode: error.exitCode } : {}), ...(environmentWrote ? { environmentWrote: true } : {}), ...(facts === undefined ? {} : { facts }) };
  };

  if (entry !== undefined) return executeSpec(name, entry, input, io, app);

  // Zero legacy commands ship today; a named call reaching one is an invariant breach, not
  // a refusal, so it throws rather than returning an Execution.
  const argv = input.kind === "argv" ? input.argv : (() => { throw new Error("a legacy command cannot take a named call"); })();
  const facts = callFactsFor(command, [...argv]);
  if (io.surface === "mcp" && facts.effect === "destroy" && io.confirmed !== true) {
    return failed("confirm", new ConfirmationRequiredError(name), facts, undefined, undefined, legacyJsonGiven(command, argv));
  }
  try {
    useApplicationRecipesDir(app.recipesDir);
    clearRecipesDir();
  } catch (error) {
    return failed("prepare", error, facts, undefined, undefined, legacyJsonGiven(command, argv));
  }
  io.observe?.("prepare");
  try {
    // Only a mutating call prepares: legacyPreparesEnvironment also refuses argv the
    // command's own parser would reject, before anything is written.
    if (legacyPreparesEnvironment(command, [...argv])) environmentWrote = (await ensureEnvironment()).wrote;
  } catch (error) {
    return failed("environment", error, facts, undefined, undefined, legacyJsonGiven(command, argv));
  }
  io.observe?.("environment");
  let ctx: Context;
  try {
    ctx = await createContext(contextOptions(app, io));
  } catch (error) {
    return failed("context", error, facts, undefined, undefined, legacyJsonGiven(command, argv));
  }
  io.observe?.("run");
  try {
    await command.run(ctx, [...argv]);
  } catch (error) {
    return failed("run", error instanceof ArgumentError && !(error instanceof LateArgumentError) ? new LateArgumentError(error) : error, facts, undefined, undefined, legacyJsonGiven(command, argv));
  }
  return { stage: "run", facts, reachedRun: true, ...(environmentWrote ? { environmentWrote: true } : {}) };
}

/** The spec-body path, shared by executeCommand (a deployment's command) and executeBody (a
 *  gate command — design D6: `needs: "nothing"`, no app, no recipes-directory selection).
 *  Precondition: `--help` was handled by the caller. */
async function executeSpec(name: string, body: CommandBody, input: CallInput, io: CommandIo, app?: AppDefinition): Promise<Execution> {
  const data = specData(body);
  const shape = specShape(body);
  // The flat argument view the --json contract reads at the parse stage (no action yet).
  const declared = argumentsView(body) as readonly { readonly name: string; readonly kind: string }[];
  const writesAtStart = machineWritesCount();
  const stdoutAtStart = stdoutBytesWritten();

  // Terminal `--json` failure contract: a command invoked with its own declared --json flag
  // that fails still prints a machine-readable answer, unless it already printed (or
  // streamed) something of its own. Never for an unknown-argument error — that is reported as such.
  let environmentWrote = false;
  const failed = (stage: Stage, error: unknown, facts?: CallFacts, failureShape?: EffectShape, action?: string, jsonGiven?: boolean): Execution => {
    io.observe?.(stage);
    environmentWrote ||= provisioningWrote(error);
    if (io.surface === "terminal" && !(error instanceof UnknownArgumentError)
      && declaresJsonFlag(declared, failureShape, action)
      && (jsonGiven ?? false)
      && machineWritesCount() === writesAtStart && stdoutBytesWritten() === stdoutAtStart) {
      emitJsonFailureDocument(error);
    }
    return { stage, error, reachedRun: stage === "run", ...(stage === "run" && error instanceof CommandFailedError ? { exitCode: error.exitCode } : {}), ...(environmentWrote ? { environmentWrote: true } : {}), ...(facts === undefined ? {} : { facts }) };
  };

  let call: ParsedCall<Record<string, unknown>>;
  try {
    call = input.kind === "argv" ? parseCall(shape, input.argv, name) : bindNamed(shape, input, name, { confirmed: io.confirmed === true });
  } catch (error) {
    return failed("parse", error, undefined, undefined, undefined, input.kind === "argv" ? jsonTokenGiven(shape, input.argv) : false);
  }
  let facts = callFacts(shape, call);
  // The recipes-directory selection happens here — before the effectOf resolver reads any
  // manifest — so the resolver, the confirm decision and preparation all read the same
  // root. Fail closed: a selection failure is the prepare-stage refusal.
  if (app !== undefined) {
    try {
      useApplicationRecipesDir(app.recipesDir);
      clearRecipesDir();
    } catch (error) {
      return failed("prepare", error, facts, shape, call.action, call.given.includes("json"));
    }
  }
  io.observe?.("parse");
  // The selected unit's per-call effect resolver, before the confirm decision: an effect that
  // depends on data in a manifest can require confirmation like destroy does. A declared read
  // flag given wins (dry-run stays a read): the resolver is not consulted at all. On throw the
  // static facts stand (fail closed — a resolver error must not skip a confirmation).
  const resolver = data.kind === "single" ? data.effectOf : data.actions[call.action!]?.effectOf;
  if (resolver !== undefined && facts.effect !== "read") {
    try {
      const resolved = await resolver(call.values, call.given);
      if (resolved !== undefined) {
        const confirm = resolved.confirm === true || resolved.effect === "destroy";
        facts = { ...facts, effect: resolved.effect, ...(confirm ? { confirm: true } : {}) };
      }
    } catch {
      // keep the static facts
    }
  }
  if (io.surface === "mcp" && (facts.effect === "destroy" || facts.confirm === true) && io.confirmed !== true) {
    return failed("confirm", new ConfirmationRequiredError(name), facts, shape, call.action, call.given.includes("json"));
  }
  io.observe?.("confirm");
  const phases = data.kind === "single" ? data : data.actions[call.action!];
  const needs = unitNeeds(data, call.action);
  // `nothing` runs without a deployment: no recipes-directory selection, no .env, no
  // transport, no Context (design §6). Anything else here is an invariant breach.
  if (needs !== "nothing" && app === undefined) {
    return failed("prepare", new Error(`command ${name} needs a deployment but was run without one`), facts, shape, call.action, call.given.includes("json"));
  }
  let plan: unknown;
  try {
    // Recipes-directory selection already ran before the effectOf resolver (same root).
    plan = await preparedPlan(phases, call);
  } catch (error) {
    return failed("prepare", error, facts, shape, call.action, call.given.includes("json"));
  }
  io.observe?.("prepare");
  try {
    if (data.kind === "single" && data.preparesEnvironment && needs === "target" && facts.effect !== "read") environmentWrote = (await ensureEnvironment()).wrote;
  } catch (error) {
    return failed("environment", error, facts, shape, call.action, call.given.includes("json"));
  }
  io.observe?.("environment");
  // Needs are the selected unit's own: `nothing`/`local` stop after prepare — no .env parse,
  // no transport, no Context.
  let on: Context | DeploymentScope | LocalScope | typeof NOTHING;
  try {
    on = needs === "nothing"
      ? NOTHING
      : needs === "deployment"
        ? await deploymentScope(app!, io)
        : needs === "local"
          ? localScope()
          : await createContext(contextOptions(app!, io));
  } catch (error) {
    return failed("context", error, facts, shape, call.action, call.given.includes("json"));
  }
  io.observe?.("run");
  try {
    const code = await (phases.run as (on: unknown, plan: unknown) => Promise<void | number>)(on, plan);
    // A gate command reports by returning a process-style exit code; a non-zero one is the
    // run-stage failure, carrying its code for the caller (the process verdict a gate command stands in for).
    if (typeof code === "number" && code !== 0) {
      return failed("run", new CommandFailedError(`${name} failed (exit ${code})`, code), facts, shape, call.action, call.given.includes("json"));
    }
  } catch (error) {
    // A run phase cannot build an ArgumentError (the token is private to core/command) —
    // one reaching here escaped through a nested runOnContext: an invariant breach, raised
    // as the LateArgumentError, text preserved, stage still "run".
    return failed("run", error instanceof ArgumentError && !(error instanceof LateArgumentError) ? new LateArgumentError(error) : error, facts, shape, call.action, call.given.includes("json"));
  }
  return { stage: "run", facts, reachedRun: true, ...(environmentWrote ? { environmentWrote: true } : {}) };
}

/** The one pipeline for a gate command (design D6): the deployment pipeline without the app —
 *  parse, confirm, prepare, run on the NothingScope. `run`'s non-zero ExitCode is the
 *  run-stage failure. */
export async function executeBody(name: string, body: CommandBody, input: CallInput, io: CommandIo): Promise<Execution> {
  return executeSpec(name, body, input, io);
}
