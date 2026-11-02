// Pure Declared-command → JSON-RPC schema transforms for the MCP control server: tool
// description and input schema. Call-side transforms (validation, argv, envelope) live in
// call.ts. server.ts keeps the protocol/I-O loop and re-exports both modules, so external
// importers keep importing from "./server.ts" unchanged.

import type { CommandArgument } from "../../core/app.ts";
import { effectProfile, argumentScopes, type ArgumentScope } from "../../core/command/index.ts";
import type { Effect } from "../../core/command/index.ts";

/** What the functions below need from a command, and all they need: the description a
 *  client reads, and the arguments the schema, the validation and the argv are derived from.
 *  Both an AppCommand and a GateCommand satisfy it — which is the point, since a client is
 *  offered one surface and should not be able to tell which of the two it is calling. */
export type Declared = {
  readonly summary: string;
  /** A gate command's declared effect (an AppCommand's lives in its spec body). */
  readonly effect?: Effect;
  readonly details?: string;
  readonly destructive?: boolean;
  readonly arguments?: CommandArgument[];
  /** Only what `argumentScopes` reads of the declaration (a gate command has none). */
  readonly run?: unknown;
  readonly structured?: boolean;
  readonly readOnly?: boolean;
  readonly readOnlyWhen?: (args: string[]) => boolean;
  readonly changedWhen?: (args: string[]) => boolean;
  readonly requiresConfirmationWhen?: (args: string[]) => boolean;
};

/** One remedy as a tool call: the inverse of the argv an advice spells out. */
export interface ToolStep {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** The advice's own note, when it carries one — the part of the remedy that is not argv. */
  readonly note?: string;
}

/** The envelope every structured tool result carries. A text log is written for a person;
 *  an agent has to read prose and guess whether anything changed — these fields answer
 *  that once, in the same shape for every command that produces them. Only what is known
 *  is filled in: a default that looks like an answer is worse than a gap, since a gap can
 *  be seen. */
export interface StructuredResult {
  /** Command operation id when the command reports one; otherwise a transient tool-call id. */
  readonly operationId: string;
  readonly changed: boolean;
  readonly healthy?: boolean;
  readonly problems: unknown[];
  readonly warnings: unknown[];
  readonly nextActions: string[];
  /** The remedies as tool calls, when the command's document carries them as advice:
   *  `nextSteps` answers "what do I run" without reparsing nextActions' console text. */
  readonly nextSteps: ToolStep[];
  /** The command's own output, whole and unaltered — its JSON document when it emitted
   *  one, its captured text otherwise. The envelope adds to it, never replaces it, so a
   *  caller that wants a field the envelope does not name still has it. */
  readonly result: unknown;
}

/** Declared to clients so the shape is known before a call, not discovered from one. Same
 *  for every structured command — types and required-ness only, since a per-field
 *  description would repeat ~90 bytes on every tool for no gain. Field meanings are in
 *  `help`'s output instead (help-render.ts), reachable once rather than paid for per tool. */
export const STRUCTURED_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    operationId: { type: "string" },
    changed: { type: "boolean" },
    healthy: { type: "boolean" },
    problems: { type: "array" },
    warnings: { type: "array" },
    nextActions: { type: "array", items: { type: "string" } },
    nextSteps: { type: "array" },
    result: {},
  },
  required: ["operationId", "changed", "problems", "warnings", "nextActions", "nextSteps", "result"],
} as const;

/** The tool description: one-line summary plus a pointer to the `help` tool for the full text. */
export const FULL_TEXT_POINTER = "Full text: help command";

/** MCP-specific compact destructive marker: same facts as help-render's destructiveMarker,
 *  but a few bytes shorter on the many-tool payload; the `confirm` property carries the
 *  exact requirement. Always destructive keeps help-render's minimal form; partial keeps
 *  the meaning that confirmation may be required for some actions. */
/** MCP-specific compact marker for a command that is destructive only for some actions:
 *  help-render's `DESTRUCTIVE_SOME` keeps the CLI wording; this shorter form carries the same
 *  meaning on the many-tool payload, and the `confirm` property carries the exact requirement. */
export const MCP_PARTIAL_MARKER = " (may require confirm)";

function mcpDestructiveMarker(command: Declared): string {
  const { destructive, alwaysDestroys } = effectProfile(command);
  if (!destructive) return "";
  return alwaysDestroys ? " (destructive)" : MCP_PARTIAL_MARKER;
}

export function toolDescription(name: string, command: Declared): string {
  const summary = `${command.summary}${mcpDestructiveMarker(command)}`;
  // The `help` tool IS the full text, so it alone carries no pointer to itself.
  return name === "help" ? summary : `${summary}\n${FULL_TEXT_POINTER}=${name}`;
}

/** True when the description only restates the argument name (exact or after "the/a/an"). */
function isTrivialDescription(name: string, description: string): boolean {
  const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const normalizedName = normalize(name);
  const normalizedDescription = normalize(description).replace(/^(the|a|an) /, "");
  return normalizedDescription === normalizedName;
}

/** The argument description in the MCP schema: the declared summary when there is one and the
 *  declared description otherwise, whole, plus the names of the actions a multi-action
 *  command's argument belongs to. No cut, no dropped parenthetical and no `(value: <…>)`
 *  tail — `help <command>` carries the full text, and a client that wants more asks for it. */
export function schemaArgumentDescription(argument: CommandArgument, scopes?: readonly ArgumentScope[]): string | undefined {
  if (isTrivialDescription(argument.name, argument.description)) return undefined;
  // The actions of a multi-action command that describe this argument differently: one clause
  // per text, each naming its own actions — the composed parts `argumentsView` joins.
  if (scopes !== undefined) {
    // Identical clause text across actions collapses into one clause naming the union of
    // actions (order of first appearance), so repeated prose is not paid per action.
    const clauses: { text: string; actions: string[] }[] = [];
    for (const scope of scopes) {
      const text = scope.summary ?? scope.description;
      const found = clauses.find((clause) => clause.text === text);
      if (found === undefined) clauses.push({ text, actions: [...scope.actions] });
      else for (const action of scope.actions) if (!found.actions.includes(action)) found.actions.push(action);
    }
    return clauses.map((clause) => `${clause.text} (${clause.actions.join(", ")})`).join("; ");
  }
  const actions = argument.actions === undefined ? "" : ` (${argument.actions.join(", ")})`;
  return `${argument.summary ?? argument.description}${actions}`;
}

/** JSON Schema for a command, derived from its declared arguments. */
export function inputSchema(command: Declared): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const argument of command.arguments ?? []) {
    const description = schemaArgumentDescription(argument, argumentScopes(command, argument.name));
    properties[argument.name] = argument.kind === "variadic"
      ? { type: "array", items: { type: "string" }, description }
      : {
        type: argument.kind === "flag" ? "boolean" : "string",
        description,
        ...(argument.choices === undefined ? {} : { enum: [...argument.choices] }),
      };
    if (argument.required === true) required.push(argument.name);
  }

  // A destructive command needs an explicit confirmation: a tool call is far easier to
  // trigger by accident than a typed command line. The distinction comes from the effect
  // profile, like every other surface: alwaysDestroys has no safe form, so confirm is
  // required, not just declared.
  const { destructive, alwaysDestroys } = effectProfile(command);
  if (destructive) {
    properties.confirm = {
      type: "boolean",
      description: alwaysDestroys ? "Required: destroys state" : "Confirm destructive action",
    };
    if (alwaysDestroys) required.push("confirm");
  }

  return { type: "object", properties, required };
}
