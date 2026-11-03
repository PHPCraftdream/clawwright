// Per-action views of a multi-action command's declaration.

import type { CommandArgument } from "#src/core/app.ts";
import { specData, specOf, type ArgumentRule, type ArgumentSpec, type CommandBody } from "#src/core/command/spec.ts";
import type { ValueKind } from "#src/core/values/kind.ts";

/** A spec's public face: the kind never leaks — a choice kind shows its list, any other kind
 *  is itself a ValueParser and shows as `parse`, exactly as the legacy declarations did. A
 *  flag carries no value, so it passes through as declared. */
function toCommandArgument(argument: ArgumentSpec): CommandArgument {
  if (argument.kind === "flag") return argument as CommandArgument;
  const { value, ...rest } = argument as ArgumentSpec & { value: ValueKind<never> };
  return { ...rest, ...(value.choices !== undefined ? { choices: value.choices } : { parse: value }) } as CommandArgument;
}

/** One multi-action command's flags/options from what each action's own parser accepts:
 *  `actions` is derived (absent when every action takes it), so completion, --help and the MCP
 *  schema cannot offer a flag the chosen action rejects. First declaration of a name wins;
 *  slices must not set `actions` themselves. Positionals are not scoped; per-action variadics
 *  are surfaced by `argumentsView` below.
 *  When the slices describe one name differently (set's `--name`: the set for build/validate,
 *  the object for forget), the descriptions are composed with their own action lists instead
 *  of the first one silently standing for every action (R31-03). */
export function scopeByAction(slices: Readonly<Record<string, readonly CommandArgument[]>>): CommandArgument[] {
  const all = Object.keys(slices);
  const merged = new Map<string, { argument: CommandArgument; actions: string[] }>();
  for (const action of all) {
    for (const argument of slices[action]) {
      if (argument.kind !== "flag" && argument.kind !== "option") continue;
      let entry = merged.get(argument.name);
      if (entry === undefined) merged.set(argument.name, entry = { argument, actions: [] });
      if (!entry.actions.includes(action)) entry.actions.push(action);
    }
  }
  return [...merged.values()].map(({ argument, actions }) => {
    const parts = argumentParts(slices, argument.name);
    return {
      ...argument,
      ...(parts === undefined ? {} : {
        description: parts.map((part) => `${part.description} (${part.actions.join(", ")})`).join("; "),
        ...(parts.every((part) => part.summary !== undefined) ? { summary: parts.map((part) => `${part.summary} (${part.actions.join(", ")})`).join("; ") } : { summary: undefined }),
      }),
      ...(actions.length === all.length ? {} : { actions }),
    };
  });
}

/** One flag/option's text for the actions of a multi-action command that describe it
 *  differently, with the actions that carry it. */
export interface ArgumentScope {
  readonly actions: readonly string[];
  readonly description: string;
  readonly summary?: string;
}

/** Per-action texts of one flag/option of a multi-action command when its actions describe it
 *  differently; undefined otherwise — a gate command has no body, so no scopes either. */
export function argumentScopes(command: { readonly run?: unknown }, name: string): readonly ArgumentScope[] | undefined {
  const entry = specOf(command);
  if (entry === undefined) return undefined;
  const data = specData(entry);
  if (data.kind === "single") return undefined;
  const slices = Object.fromEntries(Object.entries(data.actions).map(([action, slice]) => [action, slice.arguments]));
  return argumentParts(slices, name);
}

/** A multi-action command's actions with their declared summaries, in declaration order;
 *  undefined for a single-action command or one without a body. */
export function actionSummaries(command: { readonly run?: unknown }): readonly { readonly name: string; readonly summary: string }[] | undefined {
  const entry = specOf(command);
  if (entry === undefined) return undefined;
  const data = specData(entry);
  if (data.kind === "single") return undefined;
  return Object.entries(data.actions).map(([name, slice]) => ({ name, summary: slice.summary }));
}

/** One unit of a body that declares argument rules: the command itself, or one action. */
export interface ArgumentRulesView {
  readonly action?: string;
  readonly rules: readonly ArgumentRule[];
  /** The unit's own declared arguments — the labels a rule's text names. */
  readonly arguments: readonly ArgumentSpec[];
}

/** The declared argument rules of a command, per unit; undefined when none are declared
 *  (a gate command has no body, so none either). */
export function argumentRules(command: { readonly run?: unknown }): readonly ArgumentRulesView[] | undefined {
  const entry = specOf(command);
  if (entry === undefined) return undefined;
  const data = specData(entry);
  if (data.kind === "single") {
    return data.rules === undefined || data.rules.length === 0
      ? undefined
      : [{ rules: data.rules, arguments: data.arguments }];
  }
  const units = Object.entries(data.actions)
    .filter(([, slice]) => slice.rules !== undefined && slice.rules.length > 0)
    .map(([action, slice]) => ({ action, rules: slice.rules!, arguments: slice.arguments }));
  return units.length === 0 ? undefined : units;
}

/** The distinct texts the actions of a multi-action body's slices declare for one flag/option,
 *  each with the actions that carry it; undefined when every action describes it the same way
 *  (one text standing for all of them, as before). The one place the per-action split is known:
 *  the view composes it, and help-render.ts and the MCP schema read the parts instead of
 *  parsing the composed text apart again. */
function argumentParts(slices: Readonly<Record<string, readonly CommandArgument[]>>, name: string): readonly ArgumentScope[] | undefined {
  const byDescription = new Map<string, { readonly description: string; readonly actions: string[]; readonly summary?: string }>();
  for (const action of Object.keys(slices)) {
    for (const argument of slices[action]) {
      if (argument.name !== name) continue;
      const key = `${argument.description}\u0000${argument.summary ?? ""}`;
      const found = byDescription.get(key);
      if (found === undefined) byDescription.set(key, { description: argument.description, actions: [action], summary: argument.summary });
      else if (!found.actions.includes(action)) found.actions.push(action);
    }
  }
  if (byDescription.size <= 1) return undefined;
  return [...byDescription.values()].map(({ description, actions, summary }) => ({
    actions, description, ...(summary === undefined ? {} : { summary }),
  }));
}

/** What `arguments` shows for a body. A single action: its arguments as declared. A multi-action
 *  command: the positional `action` (choices in declaration order, required without a default
 *  action), the actions' positionals merged by name (first declaration, scoped to the actions that
 *  declare them, described per action when they differ, required only when every action requires
 *  it), then the actions' variadics merged the same way but scoped
 *  like flags (`actions` when only some actions declare them), then flags and options through
 *  scopeByAction in "default action first, then declaration order" — `required` only when every
 *  action requires it.
 *  A name described differently by the actions gets a `summary` composed like its description,
 *  only when every part declares one. */
export function argumentsView(body: CommandBody): readonly CommandArgument[] {
  const data = specData(body);
  if (data.kind === "single") return data.arguments.map(toCommandArgument);

  const declared = Object.keys(data.actions);
  const order = data.defaultAction === undefined ? declared : [data.defaultAction, ...declared.filter((name) => name !== data.defaultAction)];
  const slices = Object.fromEntries(order.map((name) => [name, data.actions[name].arguments]));
  const everyAction = (match: (argument: ArgumentSpec) => boolean, name: string): boolean =>
    order.every((action) => slices[action].some((argument) => argument.name === name && match(argument)));

  const action: CommandArgument = {
    name: "action",
    description: data.action.description,
    ...(data.action.summary === undefined ? {} : { summary: data.action.summary }),
    kind: "positional",
    choices: declared,
    ...(data.defaultAction === undefined ? { required: true } : {}),
  };

  const positionals = new Map<string, ArgumentSpec>();
  for (const name of order) {
    for (const argument of slices[name]) {
      if (argument.kind === "positional" && !positionals.has(argument.name)) positionals.set(argument.name, argument);
    }
  }
  const merged = [...positionals.values()].map((argument): CommandArgument => {
    const { required: _required, ...rest } = argument as ArgumentSpec & { required?: boolean };
    const declaring = order.filter((action) => slices[action].some((other) => other.kind === "positional" && other.name === argument.name));
    const parts = argumentParts(slices, argument.name);
    return toCommandArgument({
      ...rest,
      ...(parts === undefined ? {} : { description: parts.map((part) => `${part.description} (${part.actions.join(", ")})`).join("; ") }),
      ...(everyAction((other) => (other as { required?: boolean }).required === true, argument.name) ? { required: true } : {}),
      ...(declaring.length === order.length ? {} : { actions: declaring }),
    } as ArgumentSpec);
  });

  const variadics = new Map<string, { argument: ArgumentSpec; actions: string[] }>();
  for (const name of order) {
    for (const argument of slices[name]) {
      if (argument.kind !== "variadic") continue;
      let entry = variadics.get(argument.name);
      if (entry === undefined) variadics.set(argument.name, entry = { argument, actions: [] });
      if (!entry.actions.includes(name)) entry.actions.push(name);
    }
  }
  const mergedVariadics: CommandArgument[] = [...variadics.values()].map(({ argument, actions }) => toCommandArgument({
    ...argument,
    ...(actions.length === order.length ? {} : { actions }),
  }));

  const scoped = scopeByAction(slices).map((argument): CommandArgument => {
    const { required: _required, summary: _summary, ...rest } = argument as CommandArgument & { required?: boolean; summary?: string };
    const parts = argumentParts(slices, argument.name);
    const summary = parts === undefined
      ? argument.summary
      : parts.every((part) => part.summary !== undefined)
        ? parts.map((part) => `${part.summary} (${part.actions.join(", ")})`).join("; ")
        : undefined;
    return toCommandArgument({
      ...rest,
      ...(summary === undefined ? {} : { summary }),
      ...(everyAction((other) => (other as { required?: boolean }).required === true, argument.name) ? { required: true } : {}),
    } as ArgumentSpec);
  });
  return [action, ...merged, ...mergedVariadics, ...scoped];
}
