// Commands that run before a deployment exists.
//
// `check` describes the framework, `new-app`/`init` create the thing every other command
// needs — none can be an AppCommand (that type takes a Context, built from a deployment's
// .env). Dispatched by the gate (tools/clawwright.ts, framework/entry/bin.ts), not cli.ts's
// dispatcher, but still declared like a capability of the gate: one declaration feeds
// dispatch, `--help` and the MCP tool list, so help text lives in the declaration, not as
// literal strings at each call site.
//
// Which entries exist depends on the gate: `new-app` belongs to the monorepo one, `init` to
// the installed one (exactly one deployment, at the repo root), `check` needs this
// repository's own test suite, which the npm package doesn't ship. Each gate builds its own list.

import { info, log, reportError, UserError } from "../core/io/log.ts";
import { command, changeDirectory, manual, type Advice } from "../core/io/invocation/advice.ts";
import { commandLine, renderAdvice } from "../core/io/invocation/render.ts";
import { tokenize, tokenizeLenient, type CallShape } from "../core/command/parse/index.ts";
import { defaultActionOf } from "../core/command/parse/scan.ts";
import { closestCommand, UnknownArgumentError } from "../core/command/errors.ts";
import { materializeGateRun, specOf, specShape, type CommandBody } from "../core/command/spec.ts";
import { executeBody } from "../core/command/execute.ts";
import { argumentsView } from "../core/command/view.ts";
import { CommandFailedError } from "../core/io/log.ts";
import { destructiveSymbol, helpEntryLine, renderCommandHelp, renderFullCommandHelp, renderUsage, usageTopLine } from "../core/io/help-render.ts";
import { DISPATCHER_COMMANDS } from "../core/app.ts";
import type { AppCommand, AppDefinition, CommandArgument } from "../core/app.ts";
import { VERSION_ALIASES } from "./version.ts";
import { commandName } from "../core/values/kinds.ts";

export { closestCommand } from "../core/command/index.ts";

/** Fixed parts of the gate's own screen and refusals, exported so checks assert the same
 *  text the product prints instead of restating it. */
export const FULL_LIST_NOTE = "The full command list appears inside an initialised app folder";
export const CHECKOUT_NOTE = "This is a Clawwright checkout";
export const NO_APP_TS_HERE = "there is no app.ts here";
export const RUNS_INSIDE_NOTE = "runs inside an app folder";
export function emptyDirNote(deploymentDir: string): string {
  return `${deploymentDir} ${NO_APP_TS}`;
}

export interface GateCommand {
  readonly name: string;
  /** One line for the command list and the MCP tool's short description. */
  readonly summary: string;
  /** The longer explanation, shown by `--help` and folded into the tool description. */
  readonly details?: string;
  /** Alternative first-token spellings the gate rewrites onto this command (e.g. --version);
   *  completion offers them at the top level. */
  readonly aliases?: readonly string[];
  /** The spec body (needs "nothing", design D6): arguments with typed value kinds, rules,
   *  effect and the run phases — ONE declaration feeding the binder, help, the MCP schema
   *  and the pipeline. The old second validate/help/effect path is gone. */
  readonly body: CommandBody;
  /** The body's arguments projected the way an AppCommand's are (help, MCP schema, registry). */
  readonly arguments?: CommandArgument[];
  /** The common pipeline (executeBody), with the gate's terminal reporting parity: an
   *  unknown argument earns the --help pointer, every other refusal prints bare, and a
   *  non-zero ExitCode passes through as the exit code. */
  readonly run: (args: string[]) => Promise<number>;
}

/** Builds the GateCommand facade over a `commandBody({ needs: "nothing", ... })` (design D6):
 *  the run closure goes through executeBody, and materializeGateRun stamps the body onto it
 *  so specOf — the effect profile, the help renderer, the schema — reads the one declaration. */
export function materializeGate(gate: {
  readonly name: string;
  readonly summary: string;
  readonly details?: string;
  readonly aliases?: readonly string[];
  readonly body: CommandBody;
}): GateCommand {
  const command: GateCommand = {
    name: gate.name,
    summary: gate.summary,
    ...(gate.details === undefined ? {} : { details: gate.details }),
    ...(gate.aliases === undefined ? {} : { aliases: gate.aliases }),
    body: gate.body,
    arguments: argumentsView(gate.body) as CommandArgument[],
    run: async (args) => {
      const execution = await executeBody(gate.name, gate.body, { kind: "argv", argv: args }, { surface: "terminal" });
      if (execution.error === undefined) return execution.exitCode ?? 0;
      // A non-zero ExitCode is the command's own verdict: its code, silently, like the
      // process it stands in for. Everything else reports.
      if (execution.error instanceof CommandFailedError) return execution.error.exitCode;
      // Same parity as the app-command dispatcher (entry/cli.ts): only an unknown argument
      // earns the --help pointer; every other refusal prints bare.
      if (execution.error instanceof UnknownArgumentError) reportUnknownArgument(gate.name, execution.error);
      else reportError(execution.error);
      return 1;
    },
  };
  materializeGateRun(command.run, gate.summary, gate.body);
  return command;
}

/** The `--help` screen for one gate command, from its declaration — the same renderer
 *  entry/cli.ts uses for an AppCommand, so a gate command's `choices` and value names show
 *  up here too instead of only on the deployment's own commands. */
export function gateCommandHelp(command: GateCommand): void {
  // The one full-help renderer for any body (design D6) — the effect note included (R18).
  renderFullCommandHelp(command.name, command);
}

/** Lines for the command list in the gate's `help`, so a gate command appears beside the
 *  rest, marked with the same effect marker the deployment's list carries (R18). */
export function gateHelpLines(commands: GateCommand[]): string[] {
  if (commands.length === 0) return [];
  return commands.map((command) => helpEntryLine(command.name, `${command.summary}${destructiveSymbol(command)}`));
}

/** Dispatches argv against the gate's own commands. Returns the exit code when one of them
 *  ran, and undefined when argv belongs to the deployment's commands instead — so a gate
 *  can hand over without knowing what the deployment declares. */
export async function runGateCommand(
  commands: GateCommand[],
  argv: string[],
): Promise<number | undefined> {
  const command = commands.find((entry) => entry.name === argv[0]);
  if (command === undefined) return undefined;

  const args = argv.slice(1);
  // Same boundary as the deployment commands: help before a bare `--` belongs to us; help
  // after it belongs to what the command passes through, not to us.
  if (requestsShortHelp(args)) {
    gateCommandHelp(command);
    return 0;
  }
  // The facade's run is the common pipeline (executeBody); parse refusals, rules, confirm,
  // the effect and the --json document all come from the declaration.
  return command.run(args);
}

/** The tokens before the first bare `--`; everything after belongs to the command's
 *  passthrough, not to the gate's scan. */
export function beforeBareDoubleDash(args: readonly string[]): readonly string[] {
  const sep = args.indexOf("--");
  return sep === -1 ? args : args.slice(0, sep);
}

/** Whether argv asks for this command's own `--help`, scanning only tokens before the first
 *  bare `--` — the one boundary function for both entry points (entry/cli.ts re-exports it).
 *  Only `--help`: a deployment command may pass a literal `-h` through (`exec df -h`). */
export function requestsHelp(args: readonly string[]): boolean {
  return beforeBareDoubleDash(args).includes("--help");
}

/** requestsHelp for the commands that pass nothing through (gate commands, control-mcp):
 *  `-h` before the first bare `--` asks for help too. */
export function requestsShortHelp(args: readonly string[]): boolean {
  return requestsHelp(args) || beforeBareDoubleDash(args).includes("-h");
}

/** The syntactic scan for the dispatcher's own commands (help,
 *  control-mcp): a token the declaration has no slot for is refused; `choices` stay with the
 *  command, whose own answer to an unknown name is richer than a choices refusal. */
export function refuseUnknownTokens(entry: RegistryEntry | undefined, args: readonly string[]): void {
  if (entry !== undefined) tokenize(entry.arguments ?? [], args);
}

/** What the help without a deployment knows about its surroundings. */
export interface HelpContext {
  /** Names of the deployment's commands, known without an app.ts. */
  readonly deploymentCommands: readonly string[];
  /** The Clawwright checkout the directory is in, if any: `init` is refused there. */
  readonly checkout?: string;
  /** Renders a deployment command's --help body from its declaration, without a
   *  deployment (built from openclawCommands, as the checkout root does). Required:
   *  both entries build it, so a deployment command always answers. */
  readonly deploymentHelp: (name: string) => void;
}

/** `help`/`--help`/`-h` (or no argument at all) where no deployment exists: the gate's own
 *  commands only. Returns the exit code, or undefined when argv is not a help request. */
export function helpWithoutDeployment(commands: GateCommand[], argv: string[], context: HelpContext): number | undefined {
  const first = argv[0];
  const { checkout } = context;
  // `init` is refused in a checkout, so it is no suggestion there either.
  const offered = checkout === undefined ? commands : commands.filter((entry) => entry.name !== "init");
  const candidates = [...context.deploymentCommands, ...offered.map((entry) => entry.name), ...DISPATCHER_COMMANDS];
  if (first !== undefined && first !== "help" && first !== "--help" && first !== "-h") {
    // `<deployment command> --help` answers without a deployment, from the built-in
    // declaration — same as the checkout root (R32-09). A bare command stays a refusal.
    if (context.deploymentCommands.includes(first) && isDeploymentHelpRequest(argv, context.deploymentCommands)) {
      context.deploymentHelp(first);
      deploymentHelpNote(first, checkout);
      return 0;
    }
    // A word nothing declares is a typo, not a missing app.ts; options are left to the caller.
    if (first.startsWith("-") || candidates.includes(first) || commands.some((entry) => entry.name === first)) return undefined;
    reportUnknownCommand(first, candidates);
    return 1;
  }
  const target = first === "help" ? argv[1] : undefined;
  if (target === undefined || target === "--help" || target === "-h" || target === "help") {
    log("clawwright — manage self-hosted OpenClaw deployments");
    info("");
    info(usageTopLine());
    info("");
    for (const line of gateHelpLines(offered)) info(line);
    info("");
    if (checkout === undefined) info(`${FULL_LIST_NOTE} (create one with: ${commandLine(["init"])})`);
    else info(checkoutListNote(checkout));
    return 0;
  }
  const command = commands.find((entry) => entry.name === target);
  if (command !== undefined) {
    gateCommandHelp(command);
    return 0;
  }
  // `help list` from a checkout subfolder: the command is real, it just runs at the root —
  // the same answer typing `list` there gets, not "unknown command".
  if (checkout !== undefined) {
    const fromRoot = checkoutSubfolderReport(target, checkout);
    if (fromRoot !== undefined) {
      reportError(fromRoot);
      return 1;
    }
  }
  // A deployment command's declaration is built in — the checkout root answers
  // `help <cmd>` from it, so a subfolder and an installed command outside an app answer
  // the same way instead of refusing (R32-09).
  if (context.deploymentCommands.includes(target)) {
    context.deploymentHelp(target);
    deploymentHelpNote(target, checkout);
    return 0;
  }
  reportUnknownCommand(target, candidates);
  return 1;
}

/** The head of reportUnknownCommand's answer. */
export const UNKNOWN_COMMAND = "unknown command";

export function unknownCommandMessage(name: string): string {
  return `${UNKNOWN_COMMAND}: ${name}`;
}

export const NOT_FOUND = "not found";

/** A misplaced `--app` is an ordering mistake, not a deployment choice. */
export const APP_ORDER = "--app must come before the command";

export function didYouMeanMessage(suggestion: string): string {
  return `did you mean: ${suggestion}`;
}

/** The pointers the checkout's place-naming sentences embed, spelled from the checkout root
 *  (the at mark) whatever copy runs and wherever it stood. Exported so the entry matrix
 *  renders the very rows the notes carry, not a restatement. */
const CHECKOUT_ROOT_GATE = command([], { at: "checkout-root" });
const CHECKOUT_ROOT_HELP = command(["help"], { at: "checkout-root" });

export function checkoutInlineNotes(): Advice[] {
  return [CHECKOUT_ROOT_GATE, CHECKOUT_ROOT_HELP];
}

/** The one line after a deployment command's help, rendered without a deployment: where
 *  the command actually runs. */
export function outsideAppNote(name: string, checkout: string | undefined): string {
  return checkout === undefined
    ? `"${name}" ${RUNS_INSIDE_NOTE} — ${NO_APP_TS_HERE}; run: ${commandLine(["init"])}`
    : `"${name}" ${RUNS_INSIDE_NOTE} — this is a Clawwright checkout; run it from apps/<name> or with ${renderAdvice(CHECKOUT_ROOT_GATE)} at the checkout root`;
}

function deploymentHelpNote(name: string, checkout: string | undefined): void {
  info("");
  info(outsideAppNote(name, checkout));
}

/** The monorepo gate's own commands, which are real in any folder of a checkout — just run
 *  from its root. A subfolder's help must not call them unknown. Derived from
 *  entry/checkout-gate.ts, where the declarations live — there is no hand list left to
 *  keep in step with tools/clawwright.ts. */
export { CHECKOUT_GATE_COMMANDS } from "../entry/checkout-gate.ts";
import { CHECKOUT_GATE_COMMANDS } from "../entry/checkout-gate.ts";

/** The message body of checkoutSubfolderReport. */
export const CHECKOUT_ROOT_NOTE = "is a checkout command — run it from the checkout root:";

/** The checkout-root line of the bare help screen: where the full list lives instead. */
export function checkoutListNote(checkout: string): string {
  return `${CHECKOUT_NOTE} (${checkout}): ${renderAdvice(CHECKOUT_ROOT_HELP)} at its root lists every command, apps/<name> holds the deployments.`;
}

/** The refusal for a checkout gate command typed from a checkout subfolder: the command is
 *  real there too, it just runs at the root — not an unknown command. The cd line is for
 *  another shell, so it is shell advice: nothing rewrites it. */
export function checkoutSubfolderReport(first: string, checkout: string): UserError | undefined {
  if (!CHECKOUT_GATE_COMMANDS.includes(first)) return undefined;
  // One `cd` advice, spelled for every shell the command's host types (rf6-fix33, D4):
  // changeDirectory carries the per-shell alternatives, the renderer picks by the frame.
  return new UserError(`${first} ${CHECKOUT_ROOT_NOTE}`, {
    advice: [changeDirectory(checkout)],
  });
}

/** `<command> [<any arguments up to a bare --> --help>` for a deployment command: help must
 *  answer without a deployment. The scan is requestsHelp — so the natural
 *  `<command> <action> --help` form and `--json --help` count, while `-h` after a command,
 *  which requestsHelp also does not treat as help, does not. */
export function isDeploymentHelpRequest(argv: readonly string[], deploymentCommands: readonly string[]): boolean {
  if (argv[0] === undefined || !deploymentCommands.includes(argv[0])) return false;
  const rest = argv.slice(1);
  if (rest.length === 0) return false;
  return requestsHelp(rest);
}

/** What a leading `--app <name>` or `--app=<name>` split off argv, if either was there. */
export interface AppFlagSplit {
  /** The name after --app/--app=, absent when --app did not lead argv at all. */
  readonly value: string | undefined;
  /** --app led argv with no value after it — distinct from "absent" so the caller can
   *  report "--app needs a deployment name" rather than falling through to the default. */
  readonly missingValue: boolean;
  readonly rest: string[];
}

/** Recognises `--app`/`--app=<name>` only as the very first token(s) of argv — after the
 *  command name, an identically-spelled `--app` belongs to that command's own arguments
 *  (exec/cli/host pass theirs through verbatim) and must survive untouched. */
export function splitLeadingAppFlag(argv: string[]): AppFlagSplit {
  if (argv[0] === "--app") {
    const value = argv[1];
    if (value === undefined) return { value: undefined, missingValue: true, rest: argv.slice(1) };
    return { value, missingValue: false, rest: argv.slice(2) };
  }
  if (argv[0] !== undefined && argv[0].startsWith("--app=")) {
    return { value: argv[0].slice("--app=".length), missingValue: false, rest: argv.slice(1) };
  }
  return { value: undefined, missingValue: false, rest: argv };
}

/** The first `--app`/`--app=<name>` among a command's own arguments (a leading one was already
 *  split off), stopping at a bare `--` — tokens after it are values, not flags. `exempt` names
 *  commands that read their argv verbatim: gate commands and those declaring a variadic argument
 *  (cli, exec, host), whose `--app` belongs to them. With the command's `declared` arguments the
 *  tokenizer decides: an `--app` it binds (the command's own flag) or swallows (an option's
 *  value) is not misplaced; one it refuses before a bare `--` is. */
export function misplacedAppFlag(
  commandName: string | undefined,
  args: readonly string[],
  exempt: readonly string[],
  declared?: readonly CommandArgument[],
): string | undefined {
  if (commandName === undefined || exempt.includes(commandName)) return undefined;
  if (declared === undefined) return beforeBareDoubleDash(args).find((arg) => arg === "--app" || arg.startsWith("--app="));
  try {
    tokenize(declared, args);
    return undefined;
  } catch (error) {
    const token = error instanceof UnknownArgumentError ? error.argument : undefined;
    if (token === undefined || !(token === "--app" || token.startsWith("--app="))) return undefined;
    // A token the tokenizer reached behind an options-end `--` is a literal, not a flag.
    const stopped = args.indexOf(token);
    return stopped === -1 || tokenizeLenient(declared, args.slice(0, stopped)).optionsEnded ? undefined : token;
  }
}

/** The standard answer to a token no declared argument matches: the refusal (already
 *  carrying a did-you-mean guess from parseDeclaredArgs) plus a pointer to that command's
 *  own --help. Sits beside reportUnknownCommand, its sibling for the command-name case. */
export function reportUnknownArgument(commandName: string, error: UnknownArgumentError, options?: { readonly deploymentFree?: boolean }): void {
  reportError(error);
  info(`run ${commandLine([commandName, "--help"], options)} for its full argument list`);
}

/** The standard answer to a command name nothing declares: the typo, a nearby spelling
 *  guess, and a pointer to the real list — never the full help screen. */
export function reportUnknownCommand(name: string, candidates: readonly string[]): void {
  reportError(unknownCommandMessage(name));
  const suggestion = closestCommand(name, candidates);
  if (suggestion !== undefined) info(didYouMeanMessage(suggestion));
  info(`run ${commandLine(["help"])} to list every command`);
}

/** Where a name comes from: the deployment's own commands, the gate's, or the dispatcher's
 *  two built-ins (control-mcp, help). */
export type CommandOrigin = "deployment" | "gate" | "dispatcher";

/** One name the dispatcher resolves, for a surface (help, completion, docs, checks) to read
 *  from — a command declaration plus where it came from. `command`/`gate` carry the effect and
 *  the run for readers that need them; the help renderer reads only summary/arguments. */
export interface RegistryEntry {
  readonly name: string;
  readonly origin: CommandOrigin;
  readonly summary: string;
  readonly details?: string;
  readonly arguments?: readonly CommandArgument[];
  /** only a multi-action deployment command with a default action: the action a bare call runs */
  readonly defaultAction?: string;
  /** the parse-level shape its completion reads (dispatcher entries — { arguments }) */
  readonly shape: CallShape<CommandArgument>;
  /** only "deployment": the spec, effect, group and run */
  readonly command?: AppCommand;
  /** only "gate" */
  readonly gate?: GateCommand;
}

/** Every name the dispatcher resolves: deployment commands (declaration order), the gate's
 *  (gate order), then the two dispatcher entries. `find` is what help, the MCP help tool and
 *  completion read a command by. */
export interface CommandRegistry {
  readonly entries: readonly RegistryEntry[];
  readonly names: readonly string[];
  find(name: string): RegistryEntry | undefined;
}

// The dispatcher's names live in core/app.ts beside the declaration-time refusal that
// guards them; re-exported here, where the registry claims them as its backstop.
export { DISPATCHER_COMMANDS };

/** The registry `help` entry's summary, exported so checks pin the rendered text to the
 *  declaration rather than a copy (the MCP `help` TOOL's own summary is HELP_TOOL_SUMMARY,
 *  integration/mcp/server.ts — a different surface, a different sentence). */
export const HELP_ENTRY_SUMMARY = "Same as: <command> --help";

/** The description the `help` command's own positional takes. */
// Short: the tool summary beside it already says the bare call lists every command, and the
// enum of names is what the schema spends its bytes on.
export const HELP_COMMAND_DESCRIPTION = "Command name; omit lists all";

/** The details body shared by `help control-mcp` and `control-mcp --help` — control-mcp is
 *  dispatched by runApp (entry/cli.ts) before the app.commands lookup, so no AppCommand
 *  carries it, but both help paths must answer from this one declaration (R33-09). */
export const CONTROL_MCP_DETAILS = [
  "stdio JSON-RPC server, same shape as mcp-serve but for this deployment's own",
  "commands instead of OpenClaw's channels — status, backup, secrets, and the",
  "rest, with arguments checked against the same declarations --help reads.",
  "Destructive commands (push, restore, deploy) need confirm: true.",
  "Registered for a client automatically by {clawwright mcp-setup}; not meant to be run",
  "by hand outside of testing.",
].join("\n");

function faceOf(command: AppCommand): { readonly defaultAction?: string; readonly shape: CallShape<CommandArgument> } {
  const entry = specOf(command);
  if (entry === undefined) return { shape: { arguments: command.arguments } };
  const shape = specShape(entry);
  const defaultAction = defaultActionOf(shape);
  return { shape, ...(defaultAction !== undefined ? { defaultAction } : {}) };
}

/** Builds the one registry a surface reads: the deployment's commands, the gate's, and the two
 *  dispatcher entries the tail of `names` (`DISPATCHER_COMMANDS`) names. `help`'s positional
 *  carries the registry as its `commandName` kind (decision N1: checked at parse with a
 *  did-you-mean, never a schema `enum`), so completion, the docs table and the prose checks
 *  read it as any other positional. */
export function commandRegistry(source: {
  readonly deployment: Readonly<Record<string, AppCommand>>;
  readonly gate: readonly GateCommand[];
  readonly appName: string;
}): CommandRegistry {
  const names = [
    ...Object.keys(source.deployment),
    ...source.gate.map((gate) => gate.name),
    ...DISPATCHER_COMMANDS,
  ];
  const origins = new Map<string, string>();
  const claim = (name: string, origin: string): void => {
    if (VERSION_ALIASES.includes(name)) {
      throw new Error(
        `command name "${name}" is the version command's alias — the gate rewrites it to "version" before dispatch, so the command would be unreachable`,
      );
    }
    const first = origins.get(name);
    if (first !== undefined) throw new Error(`command name "${name}" is claimed twice: by ${first} and by ${origin}`);
    origins.set(name, origin);
  };
  for (const name of Object.keys(source.deployment)) claim(name, "the deployment's commands");
  for (const gate of source.gate) claim(gate.name, "a gate command");
  for (const name of DISPATCHER_COMMANDS) claim(name, "the dispatcher (reserved)");
  const helpArgument: CommandArgument = { name: "command", kind: "positional", description: HELP_COMMAND_DESCRIPTION, parse: commandName(names, closestCommand) };
  const entries: RegistryEntry[] = [
    ...Object.entries(source.deployment).map(([name, command]): RegistryEntry => ({
      name, origin: "deployment", summary: command.summary, details: command.details,
      arguments: command.arguments, command,
      ...faceOf(command),
    })),
    ...source.gate.map((gate): RegistryEntry => ({
      name: gate.name, origin: "gate", summary: gate.summary, details: gate.details,
      arguments: gate.arguments, gate, shape: { arguments: gate.arguments ?? [] },
    })),
    {
      name: "control-mcp", origin: "dispatcher",
      summary: `Expose ${source.appName}'s commands as MCP tools, for agents`,
      details: CONTROL_MCP_DETAILS, arguments: [], shape: { arguments: [] },
    },
    {
      name: "help", origin: "dispatcher", summary: HELP_ENTRY_SUMMARY,
      arguments: [helpArgument], shape: { arguments: [helpArgument] },
    },
  ];
  return { entries, names, find: (name) => entries.find((entry) => entry.name === name) };
}

/** The footer lines the two dispatcher commands contribute to every gate's command list:
 *  `control-mcp` and `help <command>` — byte for byte the lines help-render.ts's renderUsage
 *  used to append itself, so a caller composing `[...gateHelp, ...dispatcherHelpLines]` prints
 *  the same screen it did. */
export function dispatcherHelpLines(registry: CommandRegistry): string[] {
  return registry.entries
    .filter((entry) => entry.origin === "dispatcher")
    .map((entry) =>
      helpEntryLine(
        `${entry.name}${(entry.arguments ?? []).filter((argument) => argument.kind === "positional").map((argument) => ` <${argument.name}>`).join("")}`,
        entry.summary,
      ),
    );
}

/** Renders `help [<command>]`; false for an unknown command. Shared by the console
 *  and the MCP `help` tool. `help`/`help help` and the bare flags show the command list. */
export function renderHelp(
  target: string | undefined,
  app: AppDefinition,
  registry: CommandRegistry,
  gateHelp: readonly string[],
): boolean {
  // `help` is not in app.commands; `help help` shows the general list.
  if (target === undefined || target === "--help" || target === "-h" || target === "help") {
    renderUsage(app, [...gateHelp, ...dispatcherHelpLines(registry)]);
    return true;
  }
  // Everything the dispatcher resolves is a registry entry now — a deployment command, a gate
  // command or one of the two dispatcher commands — so there is no control-mcp lookup left to
  // special-case here: its help answers from the entry, like any other.
  const entry = registry.find(target);
  if (entry !== undefined) {
    if (entry.command !== undefined) renderFullCommandHelp(target, entry.command);
    // A gate entry answers through its own help, which appends the effect note the
    // `--help` screen carries — `help remove-app` used to lose it (rf6-fix33). The MCP
    // help tool shares this renderer, so both surfaces read the same body.
    else if (entry.gate !== undefined) gateCommandHelp(entry.gate);
    else renderCommandHelp(target, entry);
    return true;
  }
  reportUnknownCommand(target, registry.names);
  return false;
}

/** The directory-is-there-but-empty refusal: the shared body the advice extends. */
export const NO_APP_TS = "exists but holds no app.ts — if the directory is empty:";

/** The deployment to use when the requested one is missing: the lone deployment under apps/,
 *  but only when nobody named one explicitly (--app or OC_APP); otherwise undefined. */
export function soleDeploymentFallback(explicit: boolean, available: readonly string[]): string | undefined {
  return !explicit && available.length === 1 ? available[0] : undefined;
}

/** The refusal for an unresolved deployment: several with none selected names the ambiguity;
 *  a missing explicit name (or none at all) keeps the "not found" wording. new-app is a gate
 *  command, so its advice never carries this run's `--app`. */
export function missingDeploymentReport(
  explicit: boolean,
  name: string,
  deploymentDir: string,
  available: readonly string[],
  /** The directory is there but holds no app.ts: new-app would refuse it as non-empty. */
  directoryExists = false,
): UserError {
  if (!explicit && available.length > 1) {
    return new UserError(`several deployments (${available.join(", ")}) — pick one with --app <name> or OC_APP`);
  }
  if (directoryExists) {
    return new UserError(emptyDirNote(deploymentDir), {
      advice: [
        command(["new-app", name]),
        manual(`otherwise remove it or pick another name${available.length === 0 ? "" : ` (available: ${available.join(", ")})`}`),
      ],
    });
  }
  return new UserError(`deployment "${name}" ${NOT_FOUND} at ${deploymentDir}`, {
    advice: available.length === 0
      ? [command(["new-app", "<name>"])]
      : [manual(`available: ${available.join(", ")} — pick one with --app <name> (or OC_APP), or create one with:`), command(["new-app", "<name>"])],
  });
}
