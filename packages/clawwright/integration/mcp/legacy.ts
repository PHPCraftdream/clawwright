// The legacy named→argv bridge for callers that still take argv (gate commands, the help
// tool) — the only place named becomes argv.

import { bindsAsFlag, choicesRefusal, requiredArgumentRefusal, specOf, specShape, type ArgumentSpec } from "../../core/command/index.ts";
import type { CommandArgument } from "../../core/app.ts";
import { argumentScopeRefusal, selectAction, type SelectedUnit } from "../../core/command/parse/index.ts";
import type { Declared } from "./schema.ts";

/** Checks tool arguments against the declaration. The client's schema is a courtesy, not a
 *  guarantee: anything may arrive on this stream, and a command's own parser sees argv, not
 *  types. For a spec command only the SHAPE is checked here — unknown property and value
 *  types, and which positionals the chosen action declares (a JSON caller names them, the
 *  console positions them); choices, required and value grammars are the parser's, one
 *  stage later, so they are refused in one voice with the console. The action — or the
 *  refusal of an unknown one — comes from selectAction (core/command/parse.ts), one voice
 *  with the console. Returns the problems,
 *  empty when the call is acceptable. `context.name` is the tool's command word, for the
 *  refusals that name it (required arguments). */
export function validate(command: Declared, args: Record<string, unknown>, context: { name?: string } = {}): string[] {
  const declared = new Map((command.arguments ?? []).map((argument) => [argument.name, argument]));
  // specOf keys on the console run function: a gate command's argv-run is never in it.
  const spec = specOf(command as { readonly run?: unknown });
  const problems: string[] = [];

  for (const [name, value] of Object.entries(args)) {
    if (name === "confirm") continue;

    const argument = declared.get(name);
    if (argument === undefined) {
      problems.push(`unknown argument: ${name}`);
      continue;
    }
    if (argument.kind === "flag") {
      if (typeof value !== "boolean") problems.push(`${name} takes true or false`);
      continue;
    }
    if (argument.kind === "variadic") {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) {
        problems.push(`${name} takes a list of non-empty strings`);
      }
      continue;
    }
    if (typeof value !== "string") {
      problems.push(`${name} takes a string`);
      continue;
    }
    if (spec === undefined && argument.choices !== undefined && !argument.choices.includes(value)) {
      problems.push(choicesRefusal(argument as ArgumentSpec, argument.choices, value));
    }
  }

  if (spec !== undefined) {
    const shape = specShape(spec);
    let chosen: SelectedUnit;
    try {
      chosen = selectAction(shape, { kind: "named", args }, context.name ?? "");
    } catch (error) {
      // The one action selection: an unknown or missing action is refused here in the
      // console's own words — never a silent fallback into the default action's slice.
      return [(error as Error).message];
    }
    const chosenAction = chosen.selected.name ?? "";
    const own = chosen.slice.filter((argument) => argument.kind === "positional");
    const given = (argument: CommandArgument | ArgumentSpec): boolean => {
      const value = args[argument.name];
      return value !== undefined && value !== "";
    };
    // A JSON caller addresses positionals BY NAME where the console addresses them by
    // POSITION inside the chosen action's own slice: one another action declares is
    // refused (the parser's applies-to voice), and one given past an absent earlier
    // slot is refused in the binder's required voice — toArgv emits by position, so
    // either would land in a slot the caller never named.
    const prefix = [context.name, chosenAction].filter((part) => part !== undefined && part !== "").join(" ");
    for (const argument of declared.values()) {
      if (argument.kind !== "positional" || argument.name === "action") continue;
      if (!given(argument) || own.some((entry) => entry.name === argument.name)) continue;
      const refusal = argumentScopeRefusal(argument, chosenAction);
      if (refusal !== undefined) problems.push(refusal);
    }
    const firstGiven = own.findIndex(given);
    if (firstGiven > 0) problems.push(requiredArgumentRefusal(own[0], prefix));
    // toArgv puts a variadic after a bare `--`, where the tokenizer would fill a missing
    // positional from its first word: with a variadic given, a required positional must be too.
    const variadicGiven = [...declared.values()].some((argument) => {
      const value = args[argument.name];
      return argument.kind === "variadic" && Array.isArray(value) && value.length > 0;
    });
    if (variadicGiven) {
      for (const argument of declared.values()) {
        if (argument.kind !== "positional" || argument.required !== true) continue;
        const value = args[argument.name];
        if (value === undefined || value === "") problems.push(requiredArgumentRefusal(argument as ArgumentSpec, prefix));
      }
    }
    return problems;
  }

  for (const argument of declared.values()) {
    if (argument.required !== true) continue;
    const value = args[argument.name];
    if (value === undefined || value === "") problems.push(requiredArgumentRefusal(argument as ArgumentSpec, context.name));
  }

  return problems;
}

/** Turns tool arguments back into the argv the command already knows how to parse.
 *  Positionals come first, in the chosen action's own order (the order its
 *  parsers read them in); options use inline binding so even a value naming another
 *  option stays literal. */
export function toArgv(command: Declared, args: Record<string, unknown>): string[] {
  const declared = command.arguments ?? [];
  const spec = specOf(command as { readonly run?: unknown });
  // The one action selection: the chosen unit's own slice drives the positional order and
  // the confirmation flags; there is no second default-action fallback here.
  const chosen = spec === undefined ? undefined : selectAction(specShape(spec), { kind: "named", args });
  const slice = chosen?.slice ?? declared;
  const positional: string[] = [];
  const named: string[] = [];
  // Appended after everything else: these are the arguments of another program, and
  // anything of ours mixed in among them would be read as theirs.
  const trailing: string[] = [];
  // The action word rides the merged view's derived `action` positional — the one
  // positional the merged view contributes; every real positional is emitted below
  // from the chosen unit's own slice, in its own order, never the merged view.
  if (chosen?.selected.name !== undefined) {
    const action = args.action;
    if (action !== undefined && action !== false && action !== "") positional.push(String(action));
  }
  for (const argument of declared) {
    if (argument.kind === "positional") continue;
    const value = args[argument.name];
    if (value === undefined || value === false || value === "") continue;
    if (argument.kind === "variadic") {
      if (Array.isArray(value)) trailing.push(...value.map(String));
    } else if (argument.kind === "flag") named.push(`--${argument.name}`);
    else named.push(`--${argument.name}=${String(value)}`);
  }
  for (const argument of slice) {
    if (argument.kind !== "positional") continue;
    const value = args[argument.name];
    if (value === undefined || value === "" || value === false) continue;
    positional.push(String(value));
  }

  // A spec command's confirmation-set flags ride the confirmation instead of the caller,
  // read back from the action the call selects (the action word, or the body's default) —
  // never another action's flags.
  if (spec !== undefined && args.confirm === true) {
    for (const argument of slice ?? []) {
      if (argument.kind === "flag" && (argument as { setByConfirm?: boolean }).setByConfirm === true && !named.includes(`--${argument.name}`)) named.push(`--${argument.name}`);
    }
  }

  // A dash-leading positional value must reach the pipeline the way the console receives
  // `cmd -- -x`: a bare `--` before the FIRST such positional, every named argument of ours
  // before that `--`, and the positional tail (later positionals, then the variadic trailing
  // values) after it — the kind's leading-dash policy, one owner on both surfaces, is what
  // refuses it at parse. Without a dash-leading positional the output is unchanged.
  const guarded = positional.findIndex((value) => bindsAsFlag(value));
  if (guarded === -1) return [...positional, ...named, ...(trailing.length === 0 ? [] : ["--", ...trailing])];
  return [...positional.slice(0, guarded), ...named, "--", ...positional.slice(guarded), ...trailing];
}
