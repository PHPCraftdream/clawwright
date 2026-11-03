// The S2.3 binder table (stage 7): every declared unit walks the same refusals on the
// console's argv path and an MCP tool call's named path — same stage, same refusal text,
// zero contacts — derived from the declarations alone, over the kit deployment fixture.
// Several rows assert FULL refusal texts: the binder's own requiredArgumentRefusal and
// appliesToMessage wordings, and console-vs-named equality. The valid control, the
// reversed-binding rows, and the variadic rows also assert binding parity through a capture
// deployment (property-sweep's captureApp): the bound call the REAL pipeline hands to run —
// values, action, given — must be the same from the console's argv and an MCP named call.
// The variadic rows drive their capture through the capture deployment directly with a VALID
// call (captureApp drops localFacts and pass-throughs prepare), so parity is asserted for
// every eligible variadic unit even when the real pipeline refuses in prepare. Repeated options and a bare
// `--` are argv shapes the named form cannot express, so they are console-only rows. The
// first-refusal row is then answered by a real serveMcp child.
// NOTE (ownProductExpectations exemption): exact-text and exact-binding expectations here
// are covered by the registered negative controls C50–C52 (checks/controls/controls.ts);
// the exemption note below still applies to the dispatch row at the bottom, where the
// console-side value IS the binder's thrown refusal while the guarded surface is the
// server's dispatch: different symbols (server vs binder), the allowed renderer-output case.

import { ArgumentError, appliesToMessage, bindNamed, bindsAsFlag, parseCall, requiredArgumentRefusal, specShape } from "#framework/core/command/index.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { specOf, specData } from "#framework/core/command/spec.ts";
import { toolArguments } from "#framework/integration/mcp/call.ts";
import { check, checkTrue, finish, isolatedAppsRoot } from "#checks/kit/harness.ts";
import {
  app, captureApp, controlFlags, controlValueOf, controlValues, exampleOf, factsOf, fixture, invalidSamplesOf, runCase, runNamed, stages, units,
} from "../pipeline/property/property-sweep.ts";
import type { ArgumentSpec } from "#framework/core/command/index.ts";
import type { CapturedCall, Unit } from "../pipeline/property/property-sweep.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "#checks/kit/spawn.ts";



/** The unit's control values as a named call's arguments, facts settled to their real values. */
function namedControlArgs(unit: Unit): Record<string, unknown> {
  const args: Record<string, unknown> = unit.action === undefined ? {} : { action: unit.action };
  for (const { argument, value } of controlValues(unit)) {
    args[argument.name] = argument.kind === "variadic" ? value : value as string;
  }
  for (const { argument, fact } of factsOf(unit)) {
    const given = controlValues(unit).some((entry) => entry.argument.name === argument)
      || unit.args.some((entry) => entry.name === argument && entry.kind === "positional");
    if (given) args[argument] = controlValueOf(fact);
  }
  for (const flag of controlFlags(unit)) args[flag] = true;
  return args;
}

/** The console twin of `namedControlArgs`: the action word + the values positionally/flagged. */
function controlArgv(unit: Unit, omit?: string): string[] {
  return controlArgvWithout(unit, omit === undefined ? new Set<string>() : new Set([omit]));
}
function controlArgvWithout(unit: Unit, omit: ReadonlySet<string>): string[] {
  const factsByName = new Map(factsOf(unit).map((entry) => [entry.argument, entry.fact]));
  return [
    ...(unit.action === undefined ? [] : [unit.action]),
    ...controlValues(unit).flatMap(({ argument, value }) => {
      if (omit.has(argument.name)) return [];
      const fact = factsByName.get(argument.name);
      if (fact !== undefined) {
        const real = controlValueOf(fact);
        return argument.kind === "variadic" ? Array.from({ length: Array.isArray(value) ? value.length : 1 }, () => real)
          : argument.kind === "positional" ? [real] : [`--${argument.name}`, real];
      }
      return argument.kind === "option" ? [`--${argument.name}`, value as string]
        : Array.isArray(value) ? value : [value];
    }),
    ...controlFlags(unit).filter((flag) => !omit.has(flag)).map((flag) => `--${flag}`),
  ];
}

// S2.5: recipe new/import refuse an existing destination at prepare, and a run-stage call
// really creates it in the fixture's temp root — so the console twin (and any later run of
// the same unit) would hit the already-exists refusal while the first surface reached run.
// The check's fix is fixture state, not names: the parity rows compare bound VALUES across
// surfaces, so the create operands must stay identical — instead, clear the created recipe
// directory after every run so each run of the unit starts from fresh fixture state.
const freshensCreate = (unit: Unit): boolean =>
  unit.command === "recipe" && (unit.action === "new" || unit.action === "import");
function freshen(unit: Unit): void {
  if (!freshensCreate(unit)) return;
  rmSync(join(fixture.root, "recipes", unit.action === "new" ? "control-new" : "control-import"),
    { recursive: true, force: true });
}

const wordsOf = (message: string): readonly string[] => message.split(" ");
const hasEvery = (words: readonly string[], tokens: readonly string[]): boolean =>
  tokens.every((token) => words.includes(token));

let cases = 0;
const requiredPositionalOf = (unit: Unit): ArgumentSpec | undefined =>
  unit.args.find((argument) => argument.kind === "positional" && argument.required === true);
const variadicOf = (unit: Unit): ArgumentSpec | undefined =>
  unit.args.find((argument) => argument.kind === "variadic");
const optionOf = (unit: Unit): ArgumentSpec | undefined =>
  unit.args.find((argument) => argument.kind === "option");
const shapeOf = (command: string): ReturnType<typeof specShape> | undefined => {
  const entry = specOf(openclawCommands[command]);
  return entry === undefined ? undefined : specShape(entry);
};

// 1. The valid control: the named call reaches run without contacting the target, and the
// console twin stops at the same stage.
for (const unit of units) {
  const named = await runNamed(unit.command, namedControlArgs(unit), app, { confirmed: true });
  freshen(unit);
  stages.control(`${unit.label}: named control reaches run`, named.execution.stage);
  // A run-stage control legitimately reads the target through the recording transport —
  // the zero-contact claim is the refusal rows' (property.check's own convention).
  if (named.execution.stage !== "run") {
    check(`${unit.label}: the named control never contacts the target`, named.contacts, []);
  }
  if (named.execution.stage === "run") {
    const terminal = await runCase(unit.command, controlArgv(unit), "terminal");
    freshen(unit);
    check(`${unit.label}: the console control reaches the same stage`, terminal.execution.stage, named.execution.stage);
    // The same control call on both paths, each against its OWN capture app (a run may call
    // further commands, so entries are never matched by order across paths).
    const argvCaptured: CapturedCall[] = [];
    const namedCaptured: CapturedCall[] = [];
    await runCase(unit.command, controlArgv(unit), "terminal", captureApp(argvCaptured));
    freshen(unit);
    await runNamed(unit.command, namedControlArgs(unit), captureApp(namedCaptured));
    freshen(unit);
    const argvEntry = argvCaptured.find((entry) => entry.command === unit.command);
    const namedEntry = namedCaptured.find((entry) => entry.command === unit.command);
    checkTrue(`${unit.label}: the capture saw both bound calls`, argvEntry !== undefined && namedEntry !== undefined);
    if (argvEntry !== undefined && namedEntry !== undefined) {
      check(`${unit.label}: the pipeline binds the same values on both paths`, namedEntry.values, argvEntry.values);
      check(`${unit.label}: the pipeline binds the same given on both paths`, namedEntry.given, argvEntry.given);
      check(`${unit.label}: the pipeline binds the same action on both paths`, namedEntry.action, argvEntry.action);
    }
  }
  cases += 1;
}

// 1b. Refusal order follows the declaration, not the caller's key order: with two
// shape-valid-but-invalid values given in REVERSED key order, pass 1 accepts both shapes
// and pass 2's declaration-order conversion refuses the FIRST DECLARED argument.
let reversed = 0;
let reversedBindings = 0;
// The only allowed inapplicable reasons for a reversed-binding capture row.
const INAPPLICABLE_REASONS = ["the swapped pair shares a conflicts/oneOf rule",
  "a required control value shares a rule with a swapped argument",
  "a required trigger flag changes the effect (the confirm gate)"] as const;
for (const unit of units) {
  // A shape-valid sample is a non-empty string that is not dash-shaped — a wrong JSON shape
  // would refuse in the caller-ordered pass 1 (not pass 2's conversion, which this row
  // pins), and a dash token can't ride a console positional/option value at all.
  const shapeValid = (argument: ArgumentSpec): string | undefined =>
    invalidSamplesOf(argument).find((sample) => sample !== "" && !bindsAsFlag(sample));
  const eligible = unit.args.flatMap((argument) => {
    if (argument.kind !== "option" && argument.kind !== "positional") return [];
    // A fact-bearing argument keeps its real control value — an example would fail prepare.
    if (factsOf(unit).some((fact) => fact.argument === argument.name)) return [];
    const sample = shapeValid(argument);
    return sample === undefined ? [] : [{ argument, sample }];
  });
  if (eligible.length < 2) continue;
  const [{ argument: a, sample: sa }, { argument: b, sample: sb }] = eligible;
  const named = await runNamed(unit.command, {
    ...(unit.action === undefined ? {} : { action: unit.action }),
    [b.name]: sb,
    [a.name]: sa,
  }, app, { confirmed: true });
  const argv = [
    ...(unit.action === undefined ? [] : [unit.action]),
    ...eligible.slice(0, 2).flatMap(({ argument, sample }): string[] => argument.kind === "option"
      ? [`--${argument.name}`, sample]
      : [sample]),
  ];
  const terminal = await runCase(unit.command, argv, "terminal");
  cases += 1;
  reversed += 1;
  stages.case(`${unit.label} reversed [${b.name}, ${a.name}]`, named.execution.stage, named.execution.error);
  stages.case(`${unit.label} reversed [${b.name}, ${a.name}]`, terminal.execution.stage, terminal.execution.error);
  check(`${unit.label}: reversed key order still stops at parse (named)`, named.execution.stage, "parse");
  check(`${unit.label}: reversed key order still stops at parse (console)`, terminal.execution.stage, "parse");
  checkTrue(`${unit.label}: the first DECLARED argument is the one refused (named)`,
    named.execution.error instanceof ArgumentError && (named.execution.error as ArgumentError).argument === a.name);
  checkTrue(`${unit.label}: the first DECLARED argument is the one refused (console)`,
    terminal.execution.error instanceof ArgumentError && (terminal.execution.error as ArgumentError).argument === a.name);
  check(`${unit.label}: reversed key order reads the same on both paths`,
    (named.execution.error as Error | undefined)?.message, (terminal.execution.error as Error | undefined)?.message);
  check(`${unit.label}: the reversed-order refusal never contacts the target`, named.contacts, []);
  check(`${unit.label}: the reversed-order refusal never contacts the target (console)`, terminal.contacts, []);
  // A BINDING row with reversed named keys (example values, so both paths reach run):
  // `given` must stay in the slice's declaration order on both paths regardless of key order.
  // The unit's OTHER control values ride along, so nothing else goes missing at parse — and
  // every positional must be among the swapped arguments, or the argv slots would scramble.
  if (!unit.args.filter((argument) => argument.kind === "positional")
    .every((positional) => eligible.some((entry) => entry.argument.name === positional.name))) continue;
  const swapped = new Set(eligible.map(({ argument }) => argument.name));
  // Two names share a grammar rule when a conflicts rule names one and withs the other, or
  // when both sit anywhere in the same oneOf rule (groups together or apart).
  const sharesRule = (x: string, y: string): boolean => unit.rules.some((rule) =>
    rule.rule === "conflicts" ? (rule.name === x && rule.with.includes(y)) || (rule.name === y && rule.with.includes(x))
      : rule.rule === "oneOf" ? rule.groups.some((group) => group.includes(x)) && rule.groups.some((group) => group.includes(y))
      : false);
  // Inapplicable rows skip the capture with a reason from the listed set — the swap itself
  // or a required control value would refuse at parse on both paths and say nothing about binding.
  const pairShare = sharesRule(a.name, b.name);
  const requiredShare = controlValues(unit).some(({ argument }) =>
    (argument.kind === "positional" || argument.kind === "option" || argument.kind === "variadic") && argument.required === true
    && ![a.name, b.name].includes(argument.name) && (sharesRule(argument.name, a.name) || sharesRule(argument.name, b.name)));
  // A `requires` rule with a trigger flag: a swapped argument in the rule's `with`, or a
  // swapped rule name, rides with its trigger flag present, or the example call refuses at
  // parse (the property sweep's pair-rule companion). A trigger that changes the effect
  // would raise the MCP confirm gate on the named path — such rows are inapplicable instead.
  const requiredTriggerRules = unit.rules.filter((rule): rule is Extract<typeof rule, { rule: "requires" }> =>
    rule.rule === "requires" && rule.any === undefined
    && eligible.some(({ argument }) => argument.name === rule.name || rule.with.includes(argument.name)));
  const triggersOf = (rule: { readonly name: string; readonly with: readonly string[] }): ArgumentSpec[] =>
    unit.args.filter((trigger) => trigger.kind === "flag"
      && (trigger.name === rule.name
        || (rule.with.includes(trigger.name) && eligible.some(({ argument }) => argument.name === rule.name))));
  const effectfulTrigger = requiredTriggerRules.some((rule) => {
    const found = triggersOf(rule);
    return found.length === 0 || found.some((trigger) => (trigger as { effect?: string }).effect !== undefined);
  });
  const triggers = effectfulTrigger ? [] : requiredTriggerRules.flatMap((rule) => triggersOf(rule));
  if (pairShare || requiredShare || effectfulTrigger) {
    const reason = pairShare ? INAPPLICABLE_REASONS[0]
      : requiredShare ? INAPPLICABLE_REASONS[1]
      : INAPPLICABLE_REASONS[2];
    checkTrue(`${unit.label}: inapplicable (${reason})`, INAPPLICABLE_REASONS.includes(reason));
    continue;
  }
  const argvCaptured: CapturedCall[] = [];
  const namedCaptured: CapturedCall[] = [];
  // The capture call must be VALID — a value sharing a conflicts/oneOf rule with the swapped
  // pair would refuse at parse on both paths and the row would say nothing about binding;
  // the derivation is the variadic row's.
  const conflicting = new Set(controlValues(unit)
    .map(({ argument }) => argument.name)
    .filter((name) => !swapped.has(name)
      && (sharesRule(name, a.name) || sharesRule(name, b.name))));
  // Swapped arguments that share a rule with an earlier one stay out of the call (it would refuse at parse).
  const included = eligible.reduce<typeof eligible>((kept, entry) =>
    kept.some((other) => sharesRule(entry.argument.name, other.argument.name)) ? kept : [...kept, entry], []);
  const bindArgv = [
    // The capture app passes prepare through, so the consent flags a real prepare asks for stay out.
    ...controlArgvWithout(unit, new Set([...swapped, ...conflicting, ...controlFlags(unit)])),
    ...included.flatMap(({ argument }): string[] => argument.kind === "option"
      ? [`--${argument.name}`, exampleOf(argument)]
      : [exampleOf(argument)]),
    ...triggers.map((trigger) => `--${trigger.name}`),
  ];
  const bindArgs = namedControlArgs(unit);
  for (const name of [...swapped, ...conflicting, ...controlFlags(unit)]) delete bindArgs[name];
  const bindNamedArgs = {
    ...bindArgs,
    [b.name]: exampleOf(b),
    [a.name]: exampleOf(a),
    ...Object.fromEntries(included.slice(2).map(({ argument }) => [argument.name, exampleOf(argument)])),
    ...Object.fromEntries(triggers.map((trigger) => [trigger.name, true])),
  };
  await runCase(unit.command, bindArgv, "terminal", captureApp(argvCaptured));
  freshen(unit);
  await runNamed(unit.command, bindNamedArgs, captureApp(namedCaptured));
  freshen(unit);
  const bindArgvEntry = argvCaptured.find((entry) => entry.command === unit.command);
  const bindNamedEntry = namedCaptured.find((entry) => entry.command === unit.command);
  checkTrue(`${unit.label}: the reversed-binding capture saw both bound calls`,
    bindArgvEntry !== undefined && bindNamedEntry !== undefined);
  if (bindArgvEntry !== undefined && bindNamedEntry !== undefined) {
    check(`${unit.label}: reversed keys bind the same values`, bindNamedEntry!.values, bindArgvEntry!.values);
    check(`${unit.label}: reversed keys bind the same given (declaration order)`, bindNamedEntry!.given, bindArgvEntry!.given);
    reversedBindings += 1;
  }
}
checkTrue("reversed-order rows derived from the declarations", reversed > 0);
checkTrue("reversed-key-order binding rows derived from the declarations", reversedBindings > 0);

// The multi-action commands, derived from the declarations (no per-command lists).
const multiShapes = new Map<string, ReturnType<typeof specShape>>();
for (const [command, declaration] of Object.entries(openclawCommands)) {
  const entry = specOf(declaration);
  if (entry === undefined) continue;
  const data = specData(entry);
  if (data.kind !== "multi") continue;
  multiShapes.set(command, specShape(entry));
}

// 2. Unknown action, on both paths, in the console's words.
for (const [command] of multiShapes) {
  const word = "outside-the-actions";
  const terminal = await runCase(command, [word], "terminal");
  const named = await runNamed(command, { action: word });
  cases += 1;
  stages.case(`${command} ${word}`, terminal.execution.stage, terminal.execution.error);
  stages.case(`${command} ${word}`, named.execution.stage, named.execution.error);
  check(`${command} ${word}: the console call is refused as an unknown action`, terminal.execution.stage, "parse");
  check(`${command} ${word}: the named call is refused as an unknown action with the console's words`,
    (named.execution.error as Error | undefined)?.message, (terminal.execution.error as Error | undefined)?.message);
  checkTrue(`${command} ${word}: the refusal is in the unknown-action voice`,
    hasEvery(wordsOf((terminal.execution.error as Error).message), ["unknown", "action:", "(expected"]));
  check(`${command} ${word}: the console refusal never contacts the target`, terminal.contacts, []);
  check(`${command} ${word}: the named refusal never contacts the target`, named.contacts, []);
}

// 3. The bare call: the default action on both paths, or the needs-an-action refusal.
for (const [command, shape] of multiShapes) {
  const terminal = await runCase(command, [], "terminal");
  const named = await runNamed(command, {});
  cases += 1;
  stages.case(`${command} (bare)`, terminal.execution.stage, terminal.execution.error);
  stages.case(`${command} (bare)`, named.execution.stage, named.execution.error);
  check(`${command}: the bare named call reaches the console's stage`, named.execution.stage, terminal.execution.stage);
  const reached = (stage: string): boolean => stage === "parse";
  if (reached(terminal.execution.stage) && reached(named.execution.stage)) {
    check(`${command}: the bare call never contacts the target`, named.contacts, []);
    check(`${command}: the console bare call never contacts the target`, terminal.contacts, []);
  }
  if (shape.defaultAction === undefined) {
    check(`${command}: the bare call stops at the parse stage`, terminal.execution.stage, "parse");
    check(`${command}: the bare named call is refused with the console's words`,
      (named.execution.error as Error | undefined)?.message, (terminal.execution.error as Error | undefined)?.message);
    checkTrue(`${command}: the refusal is in the needs-an-action voice`,
      hasEvery(wordsOf((terminal.execution.error as Error).message), ["needs", "an", "action:"]));
  }
}

// 3b. A non-string action is refused with the JSON-shape voice — never a silent default-action fall.
let actionTypeRows = 0;
for (const [command, shape] of multiShapes) {
  if (shape.defaultAction === undefined) continue;
  for (const bad of [7, [], {}, null, true, false] as const) {
    const named = await runNamed(command, { action: bad });
    cases += 1;
    actionTypeRows += 1;
    stages.case(`${command} {action: ${JSON.stringify(bad)}}`, named.execution.stage, named.execution.error);
    check(`${command}: a non-string action stops at the parse stage`, named.execution.stage, "parse");
    check(`${command}: a non-string action names the action argument`, (named.execution.error as { argument?: string }).argument, "action");
    checkTrue(`${command}: a non-string action is refused with the shape voice`,
      hasEvery(wordsOf((named.execution.error as Error | undefined)?.message ?? ""), ["action", "takes", "a", "string"]));
    check(`${command}: a non-string action never contacts the target`, named.contacts, []);
  }
}
checkTrue("action-type rows derived from the declarations", actionTypeRows > 0);

// 4. A missing required positional reads the same on both paths.
for (const unit of units) {
  const missing = requiredPositionalOf(unit);
  if (missing === undefined) continue;
  const named = await runNamed(unit.command, (() => {
    const args = namedControlArgs(unit);
    delete args[missing.name];
    return args;
  })());
  const terminal = await runCase(unit.command, controlArgv(unit, missing.name), "terminal");
  cases += 1;
  stages.case(`${unit.label} (no <${missing.name}>)`, named.execution.stage, named.execution.error);
  // A later positional or the variadic slides into the emptied argv slot — an argv shape
  // the named form cannot express, so the one-text claim only holds when nothing can slide.
  const slides = variadicOf(unit) !== undefined
    || unit.args.some((argument) => argument.kind === "positional"
      && unit.args.indexOf(argument) > unit.args.indexOf(missing));
  check(`${unit.label}: dropping <${missing.name}> stops at parse (named)`, named.execution.stage, "parse");
  if (!slides) {
    check(`${unit.label}: dropping <${missing.name}> stops at parse (console)`, terminal.execution.stage, "parse");
    check(`${unit.label}: dropping <${missing.name}> reads the same on both paths`,
      (named.execution.error as Error | undefined)?.message, (terminal.execution.error as Error | undefined)?.message);
  } else {
    const prefix = [unit.command, unit.action].filter(Boolean).join(" ");
    check(`${unit.label}: the named missing-argument refusal is the binder's own`,
      (named.execution.error as Error | undefined)?.message, requiredArgumentRefusal(missing, prefix));
  }
  checkTrue(`${unit.label}: dropping <${missing.name}> stops before run on both paths`,
    named.execution.stage !== "run" && terminal.execution.stage !== "run");
  check(`${unit.label}: dropping <${missing.name}> never contacts the target`, named.contacts, []);
  check(`${unit.label}: dropping <${missing.name}> never contacts the target (console)`, terminal.contacts, []);
}

// 5. A positional another action owns never binds into the named call — the applies-to voice.
for (const unit of units) {
  const shape = multiShapes.get(unit.command);
  if (shape === undefined || unit.action === undefined) continue;
  const own = shape.actions![unit.action].arguments ?? [];
  const foreign = (openclawCommands[unit.command].arguments ?? [])
    .filter((argument) => argument.kind === "positional" && argument.name !== "action")
    .find((argument) => !own.some((candidate) => candidate.name === argument.name));
  if (foreign === undefined) continue;
  const named = await runNamed(unit.command, { action: unit.action, [foreign.name]: exampleOf(foreign as ArgumentSpec) });
  cases += 1;
  stages.case(`${unit.label} + foreign <${foreign.name}>`, named.execution.stage, named.execution.error);
  check(`${unit.label}: a positional of another action never binds into the named call`, named.execution.stage, "parse");
  check(`${unit.label}: a positional of another action never binds into the named call`, named.contacts, []);
  const words = wordsOf((named.execution.error as Error).message);
  const owners = (foreign as { actions?: readonly string[] }).actions ?? Object.keys(shape.actions!);
  check(`${unit.label}: a positional of another action never binds into the named call — the applies-to voice keeps the positional label`, words.slice(0, 3), [`<${foreign.name}>`, "applies", "to"]);
  check(`${unit.label}: the foreign-positional refusal is the binder's own`,
    (named.execution.error as Error | undefined)?.message, appliesToMessage(`<${foreign.name}>`, owners, unit.action));
}

// 5b. A flag/option another action owns refuses in the same applies-to words on both paths.
let foreignFlagPairs = 0;
for (const unit of units) {
  const shape = multiShapes.get(unit.command);
  if (shape === undefined || unit.action === undefined) continue;
  const merged = openclawCommands[unit.command].arguments ?? [];
  if (!merged.some((argument) => (argument as { actions?: readonly string[] }).actions !== undefined)) continue;
  const own = shape.actions![unit.action].arguments ?? [];
  const foreign = merged
    .filter((argument) => (argument.kind === "flag" || argument.kind === "option")
      && ((argument as { actions?: readonly string[] }).actions ?? []).includes(unit.action!) === false)
    .find((argument) => !own.some((candidate) => candidate.name === argument.name));
  if (foreign === undefined) continue;
  const example = exampleOf(foreign as ArgumentSpec);
  const terminal = await runCase(unit.command, [unit.action, `--${foreign.name}`, example], "terminal");
  const named = await runNamed(unit.command, { action: unit.action, [foreign.name]: example });
  cases += 1;
  stages.case(`${unit.label} + foreign --${foreign.name}`, terminal.execution.stage, terminal.execution.error);
  stages.case(`${unit.label} + foreign --${foreign.name}`, named.execution.stage, named.execution.error);
  const terminalMessage = (terminal.execution.error as Error | undefined)?.message ?? "";
  const namedMessage = (named.execution.error as Error | undefined)?.message ?? "";
  if (!hasEvery(wordsOf(terminalMessage), ["applies", "to"]) || !hasEvery(wordsOf(namedMessage), ["applies", "to"])) continue;
  check(`${unit.label}: a foreign --${foreign.name} reads the same on both paths`, namedMessage, terminalMessage);
  foreignFlagPairs += 1;
}
checkTrue("foreign-flag pairs derived from the declarations were checked in full text", foreignFlagPairs > 0);

// 6. A variadic given as a JSON array reads like the argv tail.
const variadicUnits = units.filter((unit) => {
  const variadic = variadicOf(unit);
  return variadic !== undefined && (variadic as { required?: boolean }).required !== true;
});
let variadicCaptures = 0;
for (const unit of units) {
  const variadic = variadicOf(unit);
  if (variadic === undefined || (variadic as { required?: boolean }).required === true) continue;
  const count = (variadic as { count?: number }).count ?? 1;
  const tail = Array.from({ length: count }, () => exampleOf(variadic));
  const named = await runNamed(unit.command, { ...namedControlArgs(unit), [variadic.name]: tail }, app, { confirmed: true });
  freshen(unit);
  const terminal = await runCase(unit.command, [...controlArgv(unit), ...tail], "terminal");
  freshen(unit);
  cases += 1;
  stages.case(`${unit.label} + <${variadic.name}…>`, named.execution.stage, named.execution.error);
  check(`${unit.label}: <${variadic.name}…> as a JSON array reads like the argv tail`, named.execution.stage, terminal.execution.stage);
  if (named.execution.stage !== "run") {
    check(`${unit.label}: <${variadic.name}…> as a JSON array never contacts the target`, named.contacts, []);
  }
  // The variadic capture parity is asserted through the CAPTURE deployment for every eligible
  // unit with a valid call: captureApp drops localFacts and pass-throughs prepare, so the unit
  // reaches run even when the real pipeline's prepare refusal (stage parity above) stops it.
  {
    // The capture call must be VALID: a oneOf rule over the variadic (e.g. set diff's
    // [artifacts] vs [from, to]) forbids the control values riding along, so the capture
    // drops every control value that shares a oneOf group with the variadic — derived.
    const oneOfOverVariadic = unit.rules.flatMap((rule) =>
      rule.rule === "oneOf" && rule.groups.some((group) => group.includes(variadic.name)) ? [rule] : []);
    const conflicting = new Set(oneOfOverVariadic
      .flatMap((rule) => rule.groups.flat())
      .filter((name) => name !== variadic.name));
    const captureArgs = namedControlArgs(unit);
    for (const name of conflicting) delete captureArgs[name];
    const argvCaptured: CapturedCall[] = [];
    const namedCaptured: CapturedCall[] = [];
    await runCase(unit.command, [...controlArgvWithout(unit, conflicting), ...tail], "terminal", captureApp(argvCaptured));
    freshen(unit);
    await runNamed(unit.command, { ...captureArgs, [variadic.name]: tail }, captureApp(namedCaptured));
    freshen(unit);
    const argvEntry = argvCaptured.find((entry) => entry.command === unit.command);
    const namedEntry = namedCaptured.find((entry) => entry.command === unit.command);
    checkTrue(`${unit.label}: the variadic capture saw both bound calls`, argvEntry !== undefined && namedEntry !== undefined);
    if (argvEntry !== undefined && namedEntry !== undefined) {
      const argvValues = argvEntry.values[variadic.name];
      const namedValues = namedEntry.values[variadic.name];
      check(`${unit.label}: <${variadic.name}…> binds the same values on the captured paths`, namedValues, argvValues);
      checkTrue(`${unit.label}: <${variadic.name}…> binds an array of the declared count with every tail element`,
        Array.isArray(argvValues) && argvValues.length === count
        && argvValues.every((element) => element !== undefined && tail.includes(String(element))));
      check(`${unit.label}: <${variadic.name}…> binds the same given on the captured paths`, namedEntry.given, argvEntry.given);
      check(`${unit.label}: <${variadic.name}…> binds the same action on the captured paths`, namedEntry.action, argvEntry.action);
      variadicCaptures += 1;
    }
  }
}
checkTrue("variadic capture rows derived from the declarations completed the capture pair", variadicCaptures > 0);
checkTrue("variadic units derived from the declarations", variadicUnits.length > 0);

// 7. A repeated option is refused on the console path — the named form has no repeat to express.
for (const unit of units) {
  const option = optionOf(unit);
  if (option === undefined) continue;
  const lead = unit.action === undefined ? [] : [unit.action];
  const positionals = controlValues(unit)
    .filter(({ argument }) => argument.kind === "positional")
    .flatMap(({ argument }) => [exampleOf(argument)]);
  const terminal = await runCase(unit.command,
    [...lead, ...positionals, `--${option.name}`, "x", `--${option.name}`, "y"], "terminal");
  cases += 1;
  stages.case(`${unit.label} --${option.name} twice`, terminal.execution.stage, terminal.execution.error);
  check(`${unit.label}: --${option.name} twice is refused on the console path`, terminal.execution.stage, "parse");
  check(`${unit.label}: --${option.name} twice never contacts the target`, terminal.contacts, []);
  checkTrue(`${unit.label}: --${option.name} twice is named twice-given`,
    hasEvery(wordsOf((terminal.execution.error as Error).message), ["given", "more", "than", "once"]));
}

// 8. A bare `--` ends the options on the console path: an invalid dash-shaped token after
// it refuses with the parser's own text, a valid one binds into the tail slot. The named
// form has no `--`; the value kinds own any dash refusal (property.check).
let tailBound = false;
for (const unit of units) {
  const slot = variadicOf(unit) ?? unit.args.find((argument) => argument.kind === "positional");
  if (slot === undefined) continue;
  const firstPositional = unit.args.find((argument) => argument.kind === "positional");
  const invalid = firstPositional === undefined ? undefined
    : invalidSamplesOf(firstPositional).find((sample) => bindsAsFlag(sample));
  if (invalid !== undefined) {
    const argv = [...controlArgv(unit), "--", invalid];
    const terminal = await runCase(unit.command, argv, "terminal");
    cases += 1;
    stages.case(`${unit.label} -- ${invalid}`, terminal.execution.stage, terminal.execution.error);
    check(`${unit.label}: -- before an invalid dash token stops at parse`, terminal.execution.stage, "parse");
    let direct: string | undefined;
    try {
      parseCall(shapeOf(unit.command)!, argv, unit.command);
    } catch (error) {
      direct = (error as Error).message;
    }
    check(`${unit.label}: -- before an invalid dash token refuses with the parser's own text`,
      (terminal.execution.error as Error | undefined)?.message, direct);
  }
  const token = "--looks-like-a-flag";
  const argv = [...controlArgv(unit), "--", token];
  let direct: string | undefined;
  try {
    parseCall(shapeOf(unit.command)!, argv, unit.command);
  } catch (error) {
    direct = (error as Error).message;
  }
  const terminal = await runCase(unit.command, argv, "terminal");
  cases += 1;
  stages.case(`${unit.label} -- ${token}`, terminal.execution.stage, terminal.execution.error);
  if (direct !== undefined) {
    check(`${unit.label}: -- + ${token} stops at parse with the parser's own text`, terminal.execution.stage, "parse");
    check(`${unit.label}: -- + ${token} refuses with the parser's own text`,
      (terminal.execution.error as Error | undefined)?.message, direct);
  } else {
    check(`${unit.label}: -- + ${token} runs`, terminal.execution.stage, "run");
    // A run-stage call legitimately reads the target through the recording transport.
    const args = toolArguments(openclawCommands[unit.command], argv);
    if (args !== undefined) {
      const bound = slot.kind === "variadic" ? (args[slot.name] as readonly string[] | undefined)?.slice(-1)[0] : args[slot.name];
      check(`${unit.label}: ${token} bound into the tail slot`, bound, token);
      tailBound = tailBound || bound === token;
    }
  }
}
checkTrue("at least one `--` unit asserted the token bound into its tail slot", tailBound);

checkTrue("the binder table derived cases from the declarations", cases > 0);

// First refusal only: a named call with two problems is answered with the binder's ONE
// refusal — the console-side value here is the binder's own thrown text, the guarded surface
// the real server's dispatch (the allowed renderer-output case; see the header note).
const dispatch = (() => {
  for (const [command, shape] of multiShapes) {
    for (const [action, slice] of Object.entries(shape.actions!)) {
      const required = (slice.arguments ?? []).find((argument) => argument.kind === "positional" && argument.required === true);
      if (required === undefined) continue;
      const foreign = (openclawCommands[command].arguments ?? [])
        .filter((argument) => argument.kind === "positional" && argument.name !== "action")
        .find((argument) => !(slice.arguments ?? []).some((candidate) => candidate.name === argument.name));
      if (foreign === undefined) continue;
      const args = { action, [foreign.name]: exampleOf(foreign as ArgumentSpec), "no-such-property": "x" };
      let single: string | undefined;
      try {
        bindNamed(shape, { kind: "named", args }, command);
      } catch (error) {
        single = (error as Error).message;
      }
      return { command, args, single };
    }
  }
  return undefined;
})();
checkTrue("the first-refusal dispatch case was derived from the declarations", dispatch !== undefined && dispatch.single !== undefined);
if (dispatch !== undefined && dispatch.single !== undefined) {
  const moduleUrl = (name: string): string => new URL("../../../../../../packages/clawwright/" + name + ".ts", import.meta.url).href;
  const script = [
    "const { serveMcp } = await import(" + JSON.stringify(moduleUrl("integration/mcp/server")) + ");",
    "const { openclawCommands } = await import(" + JSON.stringify(moduleUrl("commands/interface/index")) + ");",
    "await serveMcp({ name: 'binder-table-dispatch', commands: openclawCommands });",
  ].join("\n");
  const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: dispatch.command, arguments: dispatch.args } });
  const apps = await isolatedAppsRoot("binder-dispatch");
  const result = await runProcess(process.execPath, ["--input-type=module", "-e", script], { cwd: apps.root, input: request + "\n", timeoutMs: 180000 })
    .finally(() => apps.dispose());
  checkTrue("the dispatch server finished", !result.timedOut && result.code === 0);
  const line = result.stdout.split("\n").find((candidate) => candidate.trim() !== "");
  const text = line === undefined ? undefined : (JSON.parse(line) as { result?: { content?: Array<{ text?: string }> } }).result?.content?.[0]?.text;
  check("the named dispatch reports the first refusal only", text, dispatch.single);
}

await fixture.dispose();
stages.print("core/command: binder table");
finish("core/command: binder table — one binder for the console's argv and an MCP call's names");
