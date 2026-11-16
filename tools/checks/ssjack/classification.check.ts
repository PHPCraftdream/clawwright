// The observational / refused command lists ssjack receives come from one reviewed table next
// to the registry. This check fails when a command is added without being classified, pins
// the two lists the descriptor carries, and holds the table to what the registry declares:
// an observational command is read-only in every action and flag, a command that exports
// secrets or passes its arguments through to another program is refused.

import { SSJACK_CLASSIFICATION, commandsOf } from "#framework/commands/management/configuration/ssjack-app/classification.ts";
import { isVerbatim, specData, specOf } from "#framework/core/command/index.ts";
import type { ArgumentSpec } from "#framework/core/command/index.ts";
import type { CommandBody } from "#framework/core/command/spec.ts";
import { surfaceRegistry } from "#framework/entry/registry.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

interface Part {
  readonly effect: string;
  readonly resolver: unknown;
  readonly arguments: readonly ArgumentSpec[];
}

/** Every call of the command is a read: each action's effect (else the body's), each flag's,
 *  and no per-call resolver that could raise it. */
function alwaysRead(body: CommandBody): boolean {
  const data = specData(body);
  const parts: readonly Part[] = data.kind === "single"
    ? [{ effect: data.effect, resolver: data.effectOf, arguments: data.arguments }]
    : Object.values(data.actions).map((action) => ({ effect: action.effect ?? data.effect, resolver: action.effectOf, arguments: action.arguments }));
  return parts.every((part) => part.effect === "read" && part.resolver === undefined
    && part.arguments.every((argument) => argument.kind !== "flag" || argument.effect === undefined || argument.effect === "read"));
}

const registry = surfaceRegistry();
const registryNames: readonly string[] = registry.names;

const missing = (names: readonly string[], table: Readonly<Record<string, string>>): string[] => names.filter((name) => !(name in table));
const stale = (names: readonly string[], table: Readonly<Record<string, string>>): string[] => Object.keys(table).filter((name) => !names.includes(name));

// --- a new command cannot ship unclassified -------------------------------------------------------

check("every command of the registry is classified", missing(registryNames, SSJACK_CLASSIFICATION), []);
check("the table names no command the registry lacks", stale(registryNames, SSJACK_CLASSIFICATION), []);
check("the guard reports a command added without a classification", missing([...registryNames, "brand-new"], SSJACK_CLASSIFICATION), ["brand-new"]);
check("the guard reports a classification left behind by a removed command", stale(registryNames.filter((name) => name !== "status"), SSJACK_CLASSIFICATION), ["status"]);
checkTrue("the registry is read in full, deployment commands and the dispatcher's own", registryNames.length > 40 && registryNames.includes("help") && registryNames.includes("control-mcp"));

// --- the two lists, as reviewed ---------------------------------------------------------------------

check("observational commands", commandsOf("observational"), ["completion", "doctor", "help", "inspect", "list", "logs", "plan", "status", "verify", "version"]);
check("refused commands", commandsOf("refused"), ["cli", "control-mcp", "exec", "host", "mcp-creds", "mcp-serve"]);
const refusedNames = commandsOf("refused");
checkTrue("the refusal list holds mcp-serve and control-mcp", refusedNames.includes("mcp-serve") && refusedNames.includes("control-mcp"));
check("no command is both observational and refused", commandsOf("observational").filter((name) => refusedNames.includes(name)), []);

// --- what the registry declares must agree with the table ---------------------------------------------

for (const name of commandsOf("observational")) {
  const entry = registry.find(name);
  const body = entry?.command !== undefined ? specOf(entry.command) : entry?.gate?.body;
  if (entry?.origin === "dispatcher") {
    checkTrue(`${name}: the dispatcher's own command carries no body to read`, body === undefined);
    continue;
  }
  checkTrue(`${name}: read-only in every action and flag, by its declaration`, body !== undefined && alwaysRead(body));
}

// The predicate must be able to say no: these keep a mutating action or flag behind a read base.
for (const name of ["operations", "files", "backup", "secrets", "watch", "expose", "memory", "recipe", "set", "apply", "lock"]) {
  const declared = registry.find(name)?.command;
  const body = declared === undefined ? undefined : specOf(declared);
  checkTrue(`${name}: has a call that is not a read, so it is not observational`, body !== undefined && !alwaysRead(body));
  check(`${name}: is not observational`, commandsOf("observational").includes(name), false);
}

const exporters = registry.entries.filter((entry) => entry.command?.exportsSecrets === true).map((entry) => entry.name);
checkTrue("at least one command exports secrets on purpose", exporters.length > 0);
check("every command that exports secrets is refused", exporters.filter((name) => !refusedNames.includes(name)), []);

const passThrough = registry.entries
  .filter((entry) => entry.command !== undefined && isVerbatim((entry.arguments ?? []) as readonly ArgumentSpec[]))
  .map((entry) => entry.name);
checkTrue("the pass-through commands were found", passThrough.length >= 3);
check("every command that passes its arguments to another program is refused", passThrough.filter((name) => !refusedNames.includes(name)), []);

finish("ssjack classification");
