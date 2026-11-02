// Argv parsing driven by a command's own declared `arguments` (core/app.ts) — the same list
// that already drives help text and the MCP schema — so a flag the declaration knows and the
// CLI parser does not (or the reverse) stops being possible to write by hand.
// The stage-7 token machine (step and its strict/lenient drivers) lives in scan.ts.

import type { CommandArgument } from "#src/core/app.ts";
import {
  ARGUMENT_ERROR_TOKEN, ArgumentError, dieUnknownAction,
  UnknownActionError, UnknownArgumentError,
} from "#src/core/command/errors.ts";
import type { ArgumentRule, ArgumentSpec, ParsedCall, ValueSpec } from "#src/core/command/spec.ts";
import { scopeByAction } from "#src/core/command/view.ts";
import { ValueError, type ValueParser } from "#src/core/values/value.ts";
import { scan } from "./scan.ts";

/** Only for a multi-action command (backup): the action being parsed, and the full
 *  cross-action declaration to check an unrecognized flag against before giving up on it
 *  as wholly unknown — see CommandArgument's own `actions` field. */
export interface ActionScope {
  readonly action: string;
  readonly siblings: readonly CommandArgument[];
}

/** Whether the tokenizer reads a word (before a bare `--`) as a flag or option rather than a
 *  free word — the one rule, for whoever emits argv the tokenizer will read back. */
export function bindsAsFlag(token: string): boolean {
  return token.startsWith("-");
}

/** The refusals the parser prints; checks assert them by name. */
export const APPLIES_TO = "applies to";

export function missingArgumentMessage(prefix: string, label: string): string {
  return `${prefix} needs ${label}`;
}

/** The one voice for a missing required argument: bind's refusal, word for word. */
export function requiredArgumentRefusal(argument: ArgumentSpec, command?: string): string {
  const label = argument.kind === "option" ? `--${argument.name} <${argument.valueName ?? "value"}>`
    : argument.kind === "variadic" ? `<${argument.name}…>`
    : argument.kind === "flag" ? `--${argument.name}`
    : `<${argument.name}>`;
  return command === undefined || command === "" ? `${label} is required` : missingArgumentMessage(command, label);
}

/** One argument's label in a rule's text: `--name`, `<name>`, `<name…>`. */
function ruleLabel(declared: ReadonlyMap<string, ArgumentSpec>, name: string): string {
  const argument = declared.get(name);
  if (argument === undefined || argument.kind === "flag" || argument.kind === "option") return `--${name}`;
  return argument.kind === "variadic" ? `<${name}…>` : `<${name}>`;
}

function groupClause(declared: ReadonlyMap<string, ArgumentSpec>, group: readonly string[]): string {
  return group.map((name) => ruleLabel(declared, name)).join(" and ");
}

function groupsClause(declared: ReadonlyMap<string, ArgumentSpec>, groups: readonly (readonly string[])[]): string {
  return groups.map((group) => groupClause(declared, group)).join(" or ");
}

/** The one voice a rule is refused and printed in. */
export function ruleText(
  rule: ArgumentRule,
  declared: readonly ArgumentSpec[],
  context: BindContext = {},
  options: { mode?: "error" | "help"; case?: "mix" | "incomplete" | "empty"; incomplete?: readonly string[] } = {},
): string {
  const byName = new Map(declared.map((argument) => [argument.name, argument]));
  const prefix = [context.command, context.action].filter((part) => part !== undefined && part !== "").join(" ");
  const lead = prefix === "" ? "" : `${prefix} `;
  const withReason = (text: string): string =>
    options.mode !== "help" && rule.reason !== undefined ? `${text} — ${rule.reason}` : text;
  if (rule.rule === "requires") {
    const list = rule.with.map((name) => ruleLabel(byName, name));
    // any-of reads as a choice ("A, B or C"); the default stays the conjunction ("A and B").
    const clause = rule.any === true
      ? (list.length <= 2 ? list.join(" or ") : `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}`)
      : groupClause(byName, rule.with);
    return withReason(`${ruleLabel(byName, rule.name)} requires ${clause}`);
  }
  if (rule.rule === "conflicts") {
    const members = options.mode === "help"
      ? rule.with
      : options.incomplete ?? rule.with;
    const clause = options.mode === "help"
      ? `any of ${members.length < 3 ? members.map((name) => ruleLabel(byName, name)).join(" or ") : `${members.slice(0, -1).map((name) => ruleLabel(byName, name)).join(", ")} or ${ruleLabel(byName, members[members.length - 1]!)}`}`
      : groupClause(byName, members);
    return withReason(`${ruleLabel(byName, rule.name)} cannot be combined with ${clause}`);
  }
  if (options.mode === "help") return groupsClause(byName, rule.groups);
  if (options.case === "mix") return withReason(`${lead}takes ${groupsClause(byName, rule.groups)}, not both`);
  if (options.case === "incomplete") {
    const group = options.incomplete ?? [];
    return withReason(`${lead}needs ${group.length === 2 ? "both " : ""}${groupClause(byName, group)}`);
  }
  return withReason(`${lead}needs ${groupsClause(byName, rule.groups)}`);
}

/** Whether the declared argument is present in the bound values. */
function isGiven(argument: ArgumentSpec | undefined, values: Record<string, unknown>): boolean {
  if (argument === undefined) return false;
  if (argument.kind === "flag") return values[argument.name] === true;
  if (argument.kind === "variadic") return (values[argument.name] as string[]).length > 0;
  return values[argument.name] !== undefined;
}

/** The declaration's cross-field rules against the bound values, in declaration order. */
export function enforceRules(
  declared: readonly ArgumentSpec[],
  rules: readonly ArgumentRule[] | undefined,
  values: Record<string, unknown>,
  context: BindContext = {},
): void {
  if (rules === undefined) return;
  const byName = new Map(declared.map((argument) => [argument.name, argument]));
  for (const rule of rules) {
    if (rule.rule === "requires") {
      if (!isGiven(byName.get(rule.name), values)) continue;
      const given = rule.with.map((name) => isGiven(byName.get(name), values));
      const satisfied = rule.any === true ? given.some((entry) => entry) : given.every((entry) => entry);
      if (!satisfied) {
        throw new ArgumentError(ARGUMENT_ERROR_TOKEN, ruleText(rule, declared, context), rule.name);
      }
      continue;
    }
    if (rule.rule === "conflicts") {
      if (!isGiven(byName.get(rule.name), values)) continue;
      const other = rule.with.find((name) => isGiven(byName.get(name), values));
      if (other !== undefined) {
        throw new ArgumentError(ARGUMENT_ERROR_TOKEN, ruleText(rule, declared, context, { case: "mix", incomplete: [other] }), rule.name);
      }
      continue;
    }
    const touched = rule.groups.filter((group) => group.some((name) => isGiven(byName.get(name), values)));
    if (touched.length > 1) {
      throw new ArgumentError(ARGUMENT_ERROR_TOKEN, ruleText(rule, declared, context, { case: "mix" }), touched[1].find((name) => isGiven(byName.get(name), values))!);
    }
    if (touched.length === 1) {
      const group = touched[0];
      if (!group.every((name) => isGiven(byName.get(name), values))) {
        throw new ArgumentError(ARGUMENT_ERROR_TOKEN, ruleText(rule, declared, context, { case: "incomplete", incomplete: group }), group.find((name) => !isGiven(byName.get(name), values))!);
      }
      continue;
    }
    if (rule.required === true) {
      throw new ArgumentError(ARGUMENT_ERROR_TOKEN, ruleText(rule, declared, context, { case: "empty" }), rule.groups[0][0]);
    }
  }
}

/** The one voice for an argument another action owns — both surfaces' own spelling. */
export function appliesToMessage(name: string, actions: readonly string[], action: string): string {
  return `${name} ${APPLIES_TO} ${formatActions(actions)}, not \`${action}\``;
}
function formatActions(actions: readonly string[]): string {
  return actions.map((name) => `\`${name}\``).join(", ");
}

/** The one decision of which action owns a declared argument, and the one refusal when
 *  none does: the derived `actions` list on the argument (absent: every action of the
 *  shape owns it). The tokenizer refuses the dashed token it saw with it, the MCP validate
 *  the JSON property - the same sentence, each surface wording of the argument. */
export function argumentScopeRefusal(argument: ArgumentSpec | CommandArgument, action: string, label?: string): string | undefined {
  const actions = (argument as { actions?: readonly string[] }).actions;
  return actions !== undefined && !actions.includes(action) ? appliesToMessage(label ?? argument.name, actions, action) : undefined;
}

/** One value per declared argument, keyed by its name: flag true once seen, option its
 *  value, positional its token, variadic every remaining token in order; otherwise absent. */
export type ParsedArgs = Record<string, string | boolean | string[] | undefined>;


/** One token read against a declaration: the argument it belongs to and its text (`true` for a flag). */
export interface TokenEntry {
  readonly argument: CommandArgument;
  readonly value: string | true;
}

export interface Tokens {
  /** Every entry in typing order; a variadic contributes one entry per token. */
  readonly entries: readonly TokenEntry[];
  /** Flags and options, every occurrence, in typing order. */
  readonly given: readonly string[];
  /** True once a bare `--` ended the options (a `--` an option swallowed as its value is not one). */
  readonly optionsEnded: boolean;
}

/** Syntactic parsing only: which declared argument each token belongs to, and whether every
 *  token belongs to one. Throws UnknownArgumentError on an undeclared flag/option (naming
 *  the nearest declared one, or — given `scope` — the other action it belongs to), on
 *  `--flag=value` for a boolean flag, and on a bare token with no positional/variadic slot
 *  left. Dies as `--<name> needs a value` when an option is the last token or the next one
 *  is itself a declared flag/option (so a missing value can't swallow the next real
 *  argument — `--opt=-x`'s inline form still takes anything literally), and on a repeated
 *  `--opt`. A bare `--` ends option parsing.
 *
 *  `verbatimTail` (a declared variadic): the first token that is no declared flag/option and
 *  fills no free positional slot starts the variadic, and everything after it is literal.
 *
 *  `refuse` (a declaration's own refusals): a token the tokenizer reads as an argument or a
 *  word — never one it bound as an option's value or took into a verbatim tail — that matches
 *  a key is refused with that reason, ahead of any unknown-argument refusal for it.
 *
 *  Does not enforce `required`, `choices`, or an option's value shape beyond the above —
 *  `bind` does. */
export function tokenize(
  declared: readonly CommandArgument[],
  argv: readonly string[],
  scope?: ActionScope,
  verbatimTail = false,
  refuse?: Readonly<Record<string, string>>,
): Tokens {
  return scan(declared, argv, scope, verbatimTail, refuse, false);
}

/** What a lenient scan knows: the tokens read, and the option left waiting for its value
 *  when argv ended on it. */
export interface Scanned extends Tokens {
  readonly pending?: CommandArgument;
}

/** tokenize for a partly typed line (completion): the same reading, but a token the parser
 *  would refuse is skipped instead of thrown, and an option takes the next word as its value
 *  even when it is a declared flag. */
export function tokenizeLenient(declared: readonly CommandArgument[], argv: readonly string[], verbatimTail = false): Scanned {
  return scan(declared, argv, undefined, verbatimTail, undefined, true);
}

/** The record parseDeclaredArgs returns: a flag is true once seen, a variadic its tokens. */
function toParsedArgs(entries: readonly TokenEntry[]): ParsedArgs {
  const result: ParsedArgs = {};
  for (const { argument, value } of entries) {
    if (argument.kind === "variadic") {
      // Each element goes through the declared element kind when one is present.
      const element = argument.value !== undefined
        ? convert(argument as ValueSpec<"option">, value as string) as string
        : value as string;
      const list = result[argument.name] as string[] | undefined;
      if (list === undefined) result[argument.name] = [element];
      else list.push(element);
    } else if (argument.kind !== "flag" && argument.parse !== undefined) {
      result[argument.name] = convert(argument as ValueSpec<"option">, value as string) as string;
    } else result[argument.name] = value;
  }
  return result;
}

/** Syntactic parsing against `declared` — see `tokenize`; `required`, `choices` and value
 *  shapes stay with each command, against the record this returns. */
export function parseDeclaredArgs(declared: readonly CommandArgument[], argv: readonly string[], scope?: ActionScope): ParsedArgs {
  return toParsedArgs(tokenize(declared, argv, scope).entries);
}

export function labelOf(argument: ArgumentSpec): string {
  return argument.kind === "positional" ? `<${argument.name}>` : `--${argument.name}`;
}

/** The refusal of a value outside a declared `choices` list, in the parser's voice — shared
 *  with the MCP validate of gate commands (integration/mcp/call.ts), which refuses the same
 *  wrong value so both surfaces word the refusal alike. */
export function choicesRefusal(argument: ArgumentSpec, choices: readonly string[], value: string): string {
  return `${labelOf(argument)} takes one of ${choices.join(", ")}, not "${value}"`;
}

export function joinClause(label: string, clause: string): string {
  return clause.startsWith(":") ? `${label}${clause}` : `${label} ${clause}`;
}

/** One typed value from its text: the declared kind is the grammar (its choices list refuses
 *  before parse). A gate command's declaration is the PUBLIC CommandArgument, whose
 *  `parse`/`choices` carriers stay (they are ValueParsers, not spec fields) — those legacy
 *  branches below serve that public type only; a spec body cannot express them. */
function convert(argument: ValueSpec<"option"> | ValueSpec<"positional">, raw: string): unknown {
  const label = labelOf(argument);
  const kind = argument.value;
  if (kind !== undefined) {
    if (kind.choices !== undefined) {
      // Today's order and wording: empty is "needs a value", an outsider the choices refusal.
      if (raw === "") throw new ArgumentError(ARGUMENT_ERROR_TOKEN, `${label} needs a value`, argument.name);
      if (!kind.choices.includes(raw)) throw new ArgumentError(ARGUMENT_ERROR_TOKEN, choicesRefusal(argument, kind.choices, raw), argument.name);
      return raw;
    }
    try {
      return kind.parse(raw);
    } catch (error) {
      if (error instanceof ValueError) throw new ArgumentError(ARGUMENT_ERROR_TOKEN, joinClause(label, error.clause), argument.name);
      throw error;
    }
  }
  const legacy = argument as unknown as { parse?: ValueParser<unknown>; choices?: readonly string[] };
  if (legacy.parse !== undefined) {
    try {
      return legacy.parse.parse(raw);
    } catch (error) {
      if (error instanceof ValueError) throw new ArgumentError(ARGUMENT_ERROR_TOKEN, joinClause(label, error.clause), argument.name);
      throw error;
    }
  }
  if (raw === "") throw new ArgumentError(ARGUMENT_ERROR_TOKEN, `${label} needs a value`, argument.name);
  if (legacy.choices !== undefined && !legacy.choices.includes(raw)) {
    throw new ArgumentError(ARGUMENT_ERROR_TOKEN, choicesRefusal(argument, legacy.choices, raw), argument.name);
  }
  return raw;
}

export interface BindContext {
  /** Names the call in a missing-argument refusal: `set forget needs --kind <kind>`. */
  readonly command?: string;
  readonly action?: string;
}

/** Typed values from tokens: the given values in typing order (so the first bad one is the
 *  one reported), then the missing required arguments in declaration order. A flag is false
 *  and a variadic [] when absent. */
export function bind(declared: readonly ArgumentSpec[], tokens: Tokens, context: BindContext = {}): Record<string, unknown> {
  const byName = new Map(declared.map((argument) => [argument.name, argument]));
  const values: Record<string, unknown> = {};
  for (const argument of declared) {
    if (argument.kind === "flag") values[argument.name] = false;
    else if (argument.kind === "variadic") values[argument.name] = [];
  }
  for (const { argument: token, value } of tokens.entries) {
    const argument = byName.get(token.name)!;
    if (argument.kind === "flag") values[argument.name] = true;
    else if (argument.kind === "variadic") {
      // A variadic's declared element kind converts each element like an option would.
      (values[argument.name] as unknown[]).push(convert(argument as unknown as ValueSpec<"option">, value as string));
    }
    else values[argument.name] = convert(argument, value as string);
  }
  for (const argument of declared) {
    if (argument.kind !== "variadic" || argument.count === undefined) continue;
    const taken = (values[argument.name] as string[]).length;
    // An empty variadic is "not given" — its absence is a rule's or a required argument's
    // to refuse, not the count's.
    if (taken > 0 && taken !== argument.count) {
      throw new ArgumentError(ARGUMENT_ERROR_TOKEN, `<${argument.name}…> takes exactly ${argument.count} values, not ${taken}`, argument.name);
    }
  }
  const prefix = [context.command, context.action].filter((part) => part !== undefined && part !== "").join(" ");
  for (const argument of declared) {
    if (argument.kind === "flag" || argument.required !== true) continue;
    const absent = argument.kind === "variadic" ? (values[argument.name] as string[]).length === 0 : values[argument.name] === undefined;
    if (!absent) continue;
    throw new ArgumentError(ARGUMENT_ERROR_TOKEN, requiredArgumentRefusal(argument, prefix), argument.name);
  }
  return values;
}

/** Whether the declared variadic is a pass-through one (`verbatim: true`). */
export function isVerbatim(declared: readonly ArgumentSpec[]): boolean {
  return declared.some((argument) => argument.kind === "variadic" && argument.verbatim === true);
}

/** The parse-relevant part of a command: its arguments, or per-action arguments. */
export interface CallShape<A extends CommandArgument = ArgumentSpec> {
  readonly arguments?: readonly A[];
  readonly refuse?: Readonly<Record<string, string>>;
  readonly rules?: readonly ArgumentRule[];
  readonly actions?: Readonly<Record<string, { readonly arguments?: readonly A[]; readonly refuse?: Readonly<Record<string, string>>; readonly rules?: readonly ArgumentRule[] }>>;
  readonly defaultAction?: string;
}

// The normalized call form (stage 7 S2.2): ONE selection of the action — or of the single
// unit — from either surface's input shape, and only here (with slice, rules, refuse, scope),
// so no caller grows a second default-action fallback or unknown-action wording.

/** How a call reaches the parser: the console's argv, or an MCP tool call's named input. */
export type CallInput =
  | { readonly kind: "argv"; readonly argv: readonly string[] }
  | { readonly kind: "named"; readonly args: Readonly<Record<string, unknown>> };

/** `name` is undefined only for a single-unit shape; `how` says which rule picked it. */
export interface SelectedAction {
  readonly name: string | undefined;
  readonly how: "single" | "typed" | "named" | "default";
}

/** The declaration unit a call selects — never a merged view. */
export interface SelectedUnit<A extends CommandArgument = ArgumentSpec> {
  readonly selected: SelectedAction;
  /** The unit's own declared arguments, in declaration order. */
  readonly slice: readonly A[];
  readonly rules?: readonly ArgumentRule[];
  /** Exact argv tokens the unit refuses ahead of tokenizing. */
  readonly refuse?: Readonly<Record<string, string>>;
  /** The actions' flags and options, scoped per action — the applies-to diagnostics' source. */
  readonly siblings: readonly CommandArgument[];
  /** argv input: the tokens after the action word; named input: []. */
  readonly rest: readonly string[];
}

/** The one wording of an unknown action, shared by every surface. */
export function unknownActionMessage(action: string, names: readonly string[]): string {
  return `unknown action: ${action} (expected ${names.join(", ")})`;
}

/** The one wording of a call that names no action a shape without a default accepts. */
export function needsActionMessage(command: string, names: readonly string[]): string {
  return `${command === "" ? "" : `${command} `}needs an action: ${names.join(", ")}`;
}

/** The one action selection. argv: the first word, when it is a bare word — known → `typed`,
 *  unknown → the console's unknown-action refusal (even when a default exists); no word, or
 *  one starting with `-` → the default action with the whole argv, else the needs-an-action
 *  refusal. Named: a non-empty string `action` is read like that word (`named` when known);
 *  absent, empty or not a string → the default, else the refusal — an MCP caller never
 *  silently lands in the default action's slice by misspelling the action. */
export function selectAction<A extends CommandArgument>(shape: CallShape<A>, input: CallInput, command = ""): SelectedUnit<A> {
  if (shape.actions === undefined) {
    return {
      selected: { name: undefined, how: "single" },
      slice: shape.arguments ?? [],
      ...(shape.rules === undefined ? {} : { rules: shape.rules }),
      ...(shape.refuse === undefined ? {} : { refuse: shape.refuse }),
      siblings: [],
      rest: input.kind === "argv" ? input.argv : [],
    };
  }
  const actions = shape.actions;
  const names = Object.keys(actions);
  // Own properties only: the map is Object.fromEntries, so a plain read would accept
  // Object.prototype members (constructor, toString, __proto__) as declared actions.
  const known = new Set(names);
  const siblings = scopeByAction(Object.fromEntries(names.map((name) => [name, actions[name].arguments ?? []])));
  const chosen = (name: string, how: SelectedAction["how"], rest: readonly string[]): SelectedUnit<A> => {
    const own = actions[name];
    return {
      selected: { name, how },
      slice: own.arguments ?? [],
      ...(own.rules === undefined ? {} : { rules: own.rules }),
      ...(own.refuse === undefined ? {} : { refuse: own.refuse }),
      siblings,
      rest,
    };
  };
  const fallback = (): SelectedUnit<A> | undefined =>
    shape.defaultAction === undefined
      ? undefined
      : chosen(shape.defaultAction, "default", input.kind === "argv" ? input.argv : []);
  const refuseNoAction = (): never => {
    throw new UnknownActionError(needsActionMessage(command, names), "action");
  };
  if (input.kind === "named") {
    const word = input.args.action;
    if (word !== undefined && word !== "" && typeof word !== "string") {
      throw new ArgumentError(ARGUMENT_ERROR_TOKEN, `action takes a string`, "action");
    }
    if (typeof word === "string" && word !== "") {
      if (!known.has(word)) dieUnknownAction(word, unknownActionMessage(word, names), names, "action");
      return chosen(word, "named", []);
    }
    return fallback() ?? refuseNoAction();
  }
  const [first, ...rest] = input.argv;
  if (first !== undefined && !first.startsWith("-")) {
    if (!known.has(first)) dieUnknownAction(first, unknownActionMessage(first, names), names, "action");
    return chosen(first, "typed", rest);
  }
  return fallback() ?? refuseNoAction();
}

/** argv → ParsedCall. With `actions`, `argv[0]` naming an action picks it; no word (or one
 *  starting with `-`) takes `defaultAction` with the whole argv, and without one is refused;
 *  any other word is an unknown action. A flag that another action declares is refused as
 *  belonging to it. The action selection itself is selectAction's (this file, above). */
export function parseCall(shape: CallShape, argv: readonly string[], command = ""): ParsedCall<Record<string, unknown>> {
  return bindArgv(shape, argv, command).call;
}

/** Strict argv → named input: retain raw strings for MCP, not the kinds' converted values.
 *  Selection, tokenization, kinds, required arguments and rules are parseCall's own path. */
export function inverseCall(shape: CallShape, argv: readonly string[], command = ""): Record<string, unknown> {
  const { call, tokens } = bindArgv(shape, argv, command);
  const raw: ParsedArgs = {};
  for (const { argument, value } of tokens.entries) {
    if (argument.kind === "variadic") {
      const list = raw[argument.name] as string[] | undefined;
      if (list === undefined) raw[argument.name] = [value as string];
      else list.push(value as string);
    } else raw[argument.name] = value;
  }
  return { ...(call.action === undefined ? {} : { action: call.action }), ...raw };
}

function bindArgv(shape: CallShape, argv: readonly string[], command: string): { call: ParsedCall<Record<string, unknown>>; tokens: Tokens } {
  const chosen = selectAction(shape, { kind: "argv", argv }, command);
  const declared = chosen.slice;
  const action = chosen.selected.name;
  const context: BindContext = action === undefined ? { command } : { command, action };
  const tokens = tokenize(declared, chosen.rest, action === undefined ? undefined : { action, siblings: chosen.siblings }, isVerbatim(declared), chosen.refuse);
  const values = bind(declared, tokens, context);
  enforceRules(declared, chosen.rules, values, context);
  return { call: { values, ...(action === undefined ? {} : { action }), given: tokens.given }, tokens };
}

/** The one binder for both surfaces (argv via parseCall, named here): ONE check order, and
 *  the first refusal throws. The unknown/foreign and JSON-shape refusals run first, in the
 *  caller's property order; the values then convert in the selected slice's declaration
 *  order. The named form is narrower — "" or false is "not given", no repeats, no `--` and
 *  no refuse tokens — so only each value's JSON shape is checked here. */
export function bindNamed(
  shape: CallShape,
  input: Extract<CallInput, { kind: "named" }>,
  command = "",
  options: { confirmed?: boolean } = {},
): ParsedCall<Record<string, unknown>> {
  const chosen = selectAction(shape, input, command);
  const declared = chosen.slice;
  const action = chosen.selected.name;
  const context: BindContext = action === undefined ? { command } : { command, action };
  const byName = new Map(declared.map((argument) => [argument.name, argument]));
  const entries: TokenEntry[] = [];
  const given: string[] = [];
  // Pass 1 — caller's own property order: the unknown/foreign refusals and the JSON-shape
  // checks stay first, the first bad one the one reported. Entries are recorded, not pushed.
  const recorded = new Map<string, { argument: CommandArgument; value: string | true; readonly values?: readonly string[] }>();
  for (const [name, value] of Object.entries(input.args)) {
    if (name === "confirm" || (name === "action" && shape.actions !== undefined)) continue;
    const argument = byName.get(name);
    if (argument === undefined) {
      const sibling = chosen.siblings.find((candidate) => candidate.name === name);
      if (sibling !== undefined) {
        const label = sibling.kind === "positional" ? `<${name}>` : `--${name}`;
        throw new ArgumentError(ARGUMENT_ERROR_TOKEN, argumentScopeRefusal(sibling, action ?? "", label)!, name);
      }
      // A positional of another action: the siblings list carries only flags and options
      // (scopeByAction), so its owners are derived from the shape's own action slices here.
      const owners = shape.actions === undefined
        ? []
        : Object.keys(shape.actions).filter((unit) => (shape.actions![unit].arguments ?? []).some((candidate) => candidate.name === name));
      if (owners.length > 0) {
        const foreign = Object.values(shape.actions!).flatMap((unit) => unit.arguments ?? []).find((candidate) => candidate.name === name)!;
        const label = foreign.kind === "positional" ? `<${name}>` : `--${name}`;
        throw new ArgumentError(ARGUMENT_ERROR_TOKEN, appliesToMessage(label, owners, action ?? ""), name);
      }
      throw new UnknownArgumentError(`unknown argument: ${name}`, name);
    }
    if (argument.kind === "flag") {
      if (typeof value !== "boolean") throw new ArgumentError(ARGUMENT_ERROR_TOKEN, `${name} takes true or false`, name);
      // false is "not given" — the same absence the tokenizer's argv form produces.
      if (!value) continue;
      recorded.set(name, { argument, value: true });
      continue;
    }
    if (argument.kind === "variadic") {
      if (!(Array.isArray(value) && value.every((element) => typeof element === "string" && element !== ""))) {
        throw new ArgumentError(ARGUMENT_ERROR_TOKEN, `${name} takes a list of non-empty strings`, name);
      }
      recorded.set(name, { argument, value: true, values: value });
      continue;
    }
    if (typeof value !== "string") throw new ArgumentError(ARGUMENT_ERROR_TOKEN, `${name} takes a string`, name);
    if (value === "") continue;
    recorded.set(name, { argument, value });
  }
  // Pass 2 — the selected slice's declaration order: entries (one per variadic element) in
  // declaration order; `given` is flags and options only (parseCall's tokens.given).
  for (const argument of declared) {
    const record = recorded.get(argument.name);
    if (record === undefined) continue;
    if (record.values !== undefined) {
      for (const element of record.values) entries.push({ argument, value: element });
      continue;
    }
    entries.push({ argument, value: record.value });
    if (argument.kind === "flag" || argument.kind === "option") given.push(argument.name);
  }
  // A confirmed MCP call rides the same set-by-confirm flags the confirm stage injects.
  if (options.confirmed === true) {
    for (const argument of declared) {
      if (argument.kind !== "flag" || argument.setByConfirm !== true || given.includes(argument.name)) continue;
      entries.push({ argument, value: true });
      given.push(argument.name);
    }
  }
  const tokens: Tokens = { entries, given, optionsEnded: false };
  const values = bind(declared, tokens, context);
  enforceRules(declared, chosen.rules, values, context);
  return { values, ...(action === undefined ? {} : { action }), given };
}
