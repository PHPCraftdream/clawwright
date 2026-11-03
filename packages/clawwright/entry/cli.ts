// Running an application from the command line.
//
// The framework owns argument dispatch, help text and error reporting; an application only
// declares its commands. Adding a command to an application must not require touching any
// file in framework/ — that is the property this module exists to guarantee.

import { reportError, UserError, CommandFailedError } from "../core/io/log.ts";
import { UnknownArgumentError, tokenize } from "../core/command/index.ts";
import { executeCommand } from "../core/command/execute.ts";
import { serveMcp } from "../integration/mcp/server.ts";
import { commandRegistry, dispatcherHelpLines, refuseUnknownTokens, reportUnknownArgument, reportUnknownCommand, renderHelp, type GateCommand } from "../integration/gate.ts";
import { GROUP_HEADINGS, GROUP_ORDER, destructiveMarker, destructiveSymbol, renderCommandHelp, renderFullCommandHelp, renderUsage } from "../core/io/help-render.ts";
import type { AppDefinition } from "../core/app.ts";

// Re-exported for tools/checks/foundation/cli/help-groups.check.ts, which asserts the console
// listing against the real grouping and wording rather than a copy that could drift from it.
export { GROUP_HEADINGS, GROUP_ORDER, destructiveMarker, destructiveSymbol };

// The help boundary is the gate's (integration/gate.ts); re-exported so this module's callers
// and checks keep one import site.
import { requestsHelp, requestsShortHelp } from "../integration/gate.ts";
export { requestsHelp, requestsShortHelp };


/** Entry point: dispatches argv against an application definition. `gateHelp` is the
 *  gate-specific footer — the gate's own lines (monorepo: --app/new-app; installed: init),
 *  which every entry passes from its gate list; there is no default. */
export async function runApp(
  app: AppDefinition,
  argv: string[],
  gateHelp: string[] = [],
  gateCommands: GateCommand[] = [],
): Promise<number> {
  const [name, ...args] = argv;
  const registry = commandRegistry({ deployment: app.commands, gate: gateCommands, appName: app.name });

  if (name === undefined || name === "-h" || name === "--help") {
    renderUsage(app, [...gateHelp, ...dispatcherHelpLines(registry)]);
    return name === undefined ? 1 : 0;
  }

  // `help` alone behaves like `--help`; `help <command>` is the same lookup `<command>
  // --help` does. Shared with the MCP `help` tool (integration/mcp/server.ts) through
  // renderHelp, so the two never answer the same question differently.
  if (name === "help") {
    // Extra or unknown tokens are refused against the declared positional; a help request
    // (`help --help`, `help status -h`) is answered first, as for every command.
    if (!requestsShortHelp(args) && refuseDispatcherTokens("help", registry, args)) return 1;
    // The positional is read where the tokenizer binds it: `help -- status` is `help status`.
    const target = requestsShortHelp(args)
      ? args[0]
      : tokenize(registry.find("help")?.arguments ?? [], args).entries.find((entry) => entry.argument.name === "command")?.value;
    return renderHelp(typeof target === "string" ? target : undefined, app, registry, gateHelp) ? 0 : 1;
  }

  // Serves the application's commands as MCP tools, so the instance can be driven from a
  // chat client too. --help is checked before starting: the server owns stdio once it runs.
  if (name === "control-mcp") {
    if (requestsShortHelp(args)) {
      // From the registry entry renderHelp reads, so `help control-mcp` and this never answer
      // differently — the same declaration, not a bespoke help printer.
      const entry = registry.find("control-mcp");
      if (entry !== undefined) renderCommandHelp("control-mcp", entry);
      return 0;
    }
    if (refuseDispatcherTokens("control-mcp", registry, args)) return 1;
    // Gate commands travel with the application's — the surface mirrors what the gate
    // can do. gateHelp rides along too, for the MCP `help` tool's no-argument form.
    await serveMcp(app, gateCommands, gateHelp);
    return 0;
  }

  const command = app.commands[name];
  if (command === undefined) {
    reportUnknownCommand(name, registry.names);
    return 1;
  }

  if (requestsHelp(args)) {
    renderFullCommandHelp(name, command);
    return 0;
  }

  // The one pipeline (parse → confirm → prepare → environment → context → run), shared with
  // the MCP surface. Only an argument error is reported here; anything else rethrows so
  // main() reports it — the contract the app-hooks checks rely on.
  const execution = await executeCommand(app, name, { kind: "argv", argv: args }, { surface: "terminal" });
  if (execution.error === undefined) return 0;
  if (execution.error instanceof UnknownArgumentError) {
    reportUnknownArgument(name, execution.error);
    return 1;
  }
  throw execution.error;
}

/** Refuses a token the dispatcher command's declaration has no slot for, in the standard
 *  unknown-argument voice; true when it did. */
function refuseDispatcherTokens(name: string, registry: ReturnType<typeof commandRegistry>, args: readonly string[]): boolean {
  try {
    refuseUnknownTokens(registry.find(name), args);
    return false;
  } catch (error) {
    if (!(error instanceof UnknownArgumentError)) throw error;
    reportUnknownArgument(name, error, registry.find(name)?.origin !== "deployment" ? { deploymentFree: true } : undefined);
    return true;
  }
}

/** The standard answer to a token no declared argument matches — it lives beside its
 *  sibling reportUnknownCommand in integration/gate.ts; re-exported so this module's
 *  callers and checks keep one import site. */
export { reportUnknownArgument };

/** Wraps runApp with the error handling every entry point needs, so an application's own
 *  entry file stays a single call. */
export async function main(
  app: AppDefinition,
  argv: string[],
  gateHelp?: string[],
  gateCommands?: GateCommand[],
): Promise<void> {
  try {
    process.exitCode = await runApp(app, argv, gateHelp ?? [], gateCommands);
  } catch (error) {
    reportError(error);
    // A UserError is an expected, explained failure; anything else is a bug worth a trace.
    if (!(error instanceof UserError) && process.env.OC_DEBUG === "1") {
      console.error(error);
      // spawnLocal shortens a failed command's headline to what failed, not the full argv
      // (a wsl.exe/Compose call can run ~600 chars of plumbing); the argv rides along on
      // the error for exactly this branch.
      const fullCommand = (error as { fullCommand?: unknown }).fullCommand;
      if (typeof fullCommand === "string") console.error(`full command: ${fullCommand}`);
    }
    // A wrapped command's own exit status (host/exec/cli), already clamped to 1..255; every
    // other failure keeps the generic 1.
    process.exitCode = error instanceof CommandFailedError ? error.exitCode : 1;
  }
}
