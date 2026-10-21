// Stage 7 S2.5: the prepare-stage half of the pipeline property sweep, split from
// property.check.ts for the source layout's line cap. Two classes:
//
//   - a kind whose resolve owns the local fact refuses its prepare-stage sample at the
//     prepare stage — an ArgumentError naming the argument, ZERO transport contacts, on
//     both surfaces (the valid controls in property.check.ts reach run);
//   - an ArgumentError cannot be built in a run phase (the constructor's token is private
//     to core/command), so one reaching the pipeline's run stage through a nested
//     runOnContext is raised as the LateArgumentError — stage still "run", text preserved.

import { ArgumentError, LateArgumentError, commandBody, materializeCommands, runOnContext, specOf } from "#framework/core/command/index.ts";
import { missingRecipeRefusal } from "#framework/core/values/plan.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import type { ArgumentSpec } from "#framework/core/command/index.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { app, controlValues, factsOf, fixture, prepareSamplesOf, resolveControlValueOf, runCase, runNamed, stages, units } from "./property-sweep.ts";

let cases = 0;

{
  let prepareCases = 0;
  for (const unit of units) {
    const lead = unit.action === undefined ? [] : [unit.action];
    for (const argument of unit.args) {
      for (const invalid of prepareSamplesOf(argument)) {
        if (invalid === "") continue; // the named surface's "not given" rule
        // Valid operands everywhere else; partners the rules refuse alongside the target are
        // dropped, a requires-trigger flag is raised, and a oneOf group is completed.
        const given = new Map(controlValues(unit).map((entry) => [entry.argument.name, entry]));
        given.set(argument.name, { argument, value: argument.kind === "variadic" ? Array.from({ length: (argument as { count?: number }).count ?? 1 }, () => invalid) : invalid });
        // A fact whose `unless` companion is given does not apply (accept's <recipe> names one
        // inside the --set artifact) — the companion is dropped so the resolve is exercised.
        for (const declared of factsOf(unit)) {
          if (declared.argument === argument.name && declared.unless !== undefined) given.delete(declared.unless);
        }
        const flags: ArgumentSpec[] = [];
        for (const rule of unit.rules) {
          if (rule.rule === "conflicts") {
            if (rule.name === argument.name) for (const name of rule.with) given.delete(name);
            if (rule.with.includes(argument.name)) given.delete(rule.name);
          } else if (rule.rule === "requires" && rule.any === undefined && rule.with.includes(argument.name)) {
            const trigger = unit.args.find((other) => other.name === rule.name && other.kind === "flag");
            if (trigger !== undefined) flags.push(trigger);
          } else if (rule.rule === "oneOf") {
            const own = rule.groups.find((names) => names.includes(argument.name));
            for (const group of rule.groups) {
              if (group === own) continue;
              for (const name of group) given.delete(name);
            }
            if (own !== undefined) {
              for (const name of own) {
                if (given.has(name)) continue;
                const other = unit.args.find((entry) => entry.name === name);
                if (other === undefined || other.kind === "flag") continue;
                given.set(name, { argument: other, value: other.kind === "variadic" ? Array.from({ length: (other as { count?: number }).count ?? 1 }, () => resolveControlValueOf(other)) : resolveControlValueOf(other) });
              }
            }
          }
        }
        const entries = [...given.values()];
        const operands = entries.filter((entry) => entry.argument.kind === "positional" || entry.argument.kind === "variadic").flatMap((entry) => Array.isArray(entry.value) ? entry.value : [entry.value as string]);
        const optionPairs = entries.filter((entry) => entry.argument.kind === "option").flatMap((entry) => [`--${entry.argument.name}`, entry.value as string]);
        const flagTokens = flags.map((trigger) => `--${trigger.name}`);
        // Everything after the first token of a verbatim tail is literal, so our own flags and options go first there.
        const verbatimTail = unit.args.some((entry) => entry.kind === "variadic" && (entry as { verbatim?: boolean }).verbatim === true);
        const argv = verbatimTail ? [...lead, ...flagTokens, ...optionPairs, ...operands] : [...lead, ...operands, ...flagTokens, ...optionPairs];
        const label = `${unit.label}: ${argument.kind === "option" ? `--${argument.name}` : argument.kind === "variadic" ? `<${argument.name}…>` : `<${argument.name}>`} ${JSON.stringify(invalid)} refused at prepare`;
        const terminal = await runCase(unit.command, argv, "terminal");
        cases += 1;
        prepareCases += 1;
        stages.case(label, terminal.execution.stage, terminal.execution.error);
        check(`${label}: console stops at the prepare stage`, terminal.execution.stage, "prepare");
        checkTrue(`${label}: console error is an ArgumentError`, terminal.execution.error instanceof ArgumentError);
        check(`${label}: console error names the argument`, (terminal.execution.error as ArgumentError).argument, argument.name);
        check(`${label}: console never contacts the target`, terminal.contacts, []);

        const mcpArgs: Record<string, unknown> = {
          ...(unit.action === undefined ? {} : { action: unit.action }),
          ...Object.fromEntries(entries.filter((entry) => entry.argument.kind === "option" || entry.argument.kind === "positional").map((entry) => [entry.argument.name, entry.value])),
          ...Object.fromEntries(entries.filter((entry) => entry.argument.kind === "variadic").map((entry) => [entry.argument.name, entry.value])),
          ...Object.fromEntries(flags.map((trigger) => [trigger.name, true])),
        };
        const mcp = await runNamed(unit.command, mcpArgs, app, { confirmed: true });
        cases += 1;
        stages.case(label, mcp.execution.stage, mcp.execution.error);
        check(`${label}: MCP stops at the prepare stage`, mcp.execution.stage, "prepare");
        checkTrue(`${label}: MCP error is an ArgumentError`, mcp.execution.error instanceof ArgumentError);
        check(`${label}: MCP error names the argument`, (mcp.execution.error as ArgumentError).argument, argument.name);
        check(`${label}: MCP never contacts the target`, mcp.contacts, []);
      }
    }
  }
  checkTrue("the property check derived prepare-stage cases from the kinds' resolve samples", prepareCases > 0);
}

{
  const late = materializeCommands({
    late: {
      ...commandBody({
        effect: "read",
        arguments: [],
        run: async (on) => {
          await runOnContext(specOf(openclawCommands.recipe!)!, on, ["verify", "absent-recipe"], "recipe");
        },
      }),
      summary: "late", group: "low-level",
    },
  }).late!;
  const lateApp: AppDefinition = { name: "late-fixture", description: "fixture", commands: { late } };
  const outcome = await runCase("late", [], "terminal", lateApp);
  cases += 1;
  stages.case("late: a nested argument refusal escaping run", outcome.execution.stage, outcome.execution.error);
  check("late: the stage is still run", outcome.execution.stage, "run");
  checkTrue("late: the error is a LateArgumentError", outcome.execution.error instanceof LateArgumentError);
  check("late: the refusal's text is preserved", (outcome.execution.error as Error).message, missingRecipeRefusal("absent-recipe"));
  check("late: the target was never contacted", outcome.contacts, []);
}


checkTrue("the prepare-stage property check derived cases from the kinds' resolve samples", cases > 0);
await fixture.dispose();
stages.print("pipeline: property — prepare-stage refusals and the late-argument invariant");
finish("pipeline: property — prepare-stage refusals and the late-argument invariant");
