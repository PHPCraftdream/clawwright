// Call-side transforms for the MCP control server: tool-argument extraction, the
// structured-output envelope and its masking. Split out of schema.ts, which keeps the tool
// description and input schema; server.ts re-exports both modules. The legacy named→argv
// bridge lives in legacy.ts.

import { maskSecrets, UserError } from "../../core/io/log.ts";
import * as commandBinding from "../../core/command/index.ts";
import type { CallShape } from "../../core/command/index.ts";
import type { CallFacts } from "../../core/command/effect.ts";
import type { Execution } from "../../core/command/execute.ts";
import type { Advice, CommandAdvice } from "../../core/io/invocation/advice.ts";
import { renderCurrentAdviceRows } from "../../core/io/invocation/render.ts";
import type { Declared, StructuredResult, ToolStep } from "./schema.ts";

function isWarning(problem: unknown): boolean {
  return (problem as { severity?: unknown } | null)?.severity === "warning";
}

/** The stages before `run`: a refusal there changed nothing. An unknown or omitted stage is
 *  not on this list, so it keeps the conservative answer (the command's own facts). */
export const PRE_RUN_STAGES: ReadonlySet<string> = new Set(["parse", "confirm", "prepare"]);

function changedFact(command: Declared, fields: { changed?: unknown }, args: string[], execution?: Execution): boolean {
  if (execution !== undefined) {
    if (execution.stage === "parse" || execution.stage === "confirm" || execution.stage === "prepare") return false;
    if (execution.stage === "environment" || execution.stage === "context") return execution.environmentWrote === true;
    if (execution.facts !== undefined) {
      if (execution.facts.changed !== undefined) return execution.facts.changed;
      if (execution.facts.effect === "read") return false;
    }
    return typeof fields.changed === "boolean" ? fields.changed : true;
  }
  return command.changedWhen?.(args) ?? (command.readOnly === true ? false : (typeof fields.changed === "boolean" ? fields.changed : true));
}

/** The tool-argument record for a command's own argv — the inverse of toArgv: the command
 *  word is stripped, the action word lands in the derived `action` positional, a flag
 *  becomes true, an option or positional its string, a variadic its array. Undefined when
 *  the argv does not parse against the declaration — a step is never guessed. */
export function toolArguments(command: Declared, argv: readonly string[]): Record<string, unknown> | undefined {
  if (argv.length === 0) return undefined;
  try {
    const body = commandBinding.specOf(command as { readonly run?: unknown });
    const shape = body === undefined ? { arguments: command.arguments ?? [] } as CallShape : commandBinding.specShape(body);
    return commandBinding.inverseCall(shape, argv.slice(1), argv[0]);
  } catch {
    return undefined;
  }
}

/** The only advice a step can be built from: a clawwright one for this deployment. A
 *  shell or manual step, and an advice naming another deployment explicitly, are not. */
function localAdvice(advice: Advice): CommandAdvice | undefined {
  if (advice.kind !== "clawwright" || advice.app !== undefined) return undefined;
  return advice;
}

/** The envelope's nextSteps: the clawwright advices a document carries, matched against the
 *  tools this server serves. A shell or manual step, an advice naming another deployment
 *  explicitly, and anything without a matching tool are skipped — not guessed. */
export function toolSteps(next: readonly Advice[], lookup: (name: string) => Declared | undefined): ToolStep[] {
  const steps: ToolStep[] = [];
  for (const advice of next) {
    const local = localAdvice(advice);
    if (local === undefined) continue;
    const [tool] = local.argv;
    if (typeof tool !== "string") continue;
    const command = lookup(tool);
    if (command === undefined) continue;
    const args = toolArguments(command, local.argv);
    if (args === undefined) continue;
    steps.push({ tool, arguments: args, ...(local.note === undefined ? {} : { note: local.note }) });
  }
  return steps;
}

/** The structured `next` field a document carries, narrowed to real advice values. */
function adviceList(value: unknown): Advice[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Advice => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const advice = entry as { kind?: unknown; argv?: unknown; text?: unknown; shell?: unknown };
    if (advice.kind === "clawwright") return Array.isArray(advice.argv) && advice.argv.every((word) => typeof word === "string");
    if (advice.kind === "manual") return typeof advice.text === "string";
    if (advice.kind === "shell") return typeof advice.text === "string" && (advice.shell === "posix" || advice.shell === "cmd" || advice.shell === "pwsh");
    return false;
  });
}

/** Builds the envelope from what a structured command emitted. Returns undefined when the
 *  output is not the single JSON document promised — the text result still stands, so a
 *  broken promise degrades rather than turning a working call into an error. */
export function structuredResult(command: Declared, output: string, operationId: string, args: string[] = [], facts?: CallFacts, lookup?: (name: string) => Declared | undefined): StructuredResult | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (payload === null || typeof payload !== "object") return undefined;

  const fields = payload as { operationId?: unknown; healthy?: unknown; problems?: unknown; nextActions?: unknown; next?: unknown; changed?: unknown };
  const problems = Array.isArray(fields.problems) ? fields.problems : [];
  const commandOperationId = typeof fields.operationId === "string" && fields.operationId !== ""
    ? fields.operationId
    : operationId;

  return {
    operationId: commandOperationId,
    // A read-only command changes nothing by declaration. Anything else defaults to
    // "changed" when unsaid: an unneeded re-check costs less than a skipped one that was needed.
    changed: facts === undefined ? changedFact(command, fields, args) : changedFact(command, fields, args, { stage: "run", reachedRun: true, facts }),
    healthy: typeof fields.healthy === "boolean" ? fields.healthy : undefined,
    problems,
    warnings: problems.filter(isWarning),
    nextActions: Array.isArray(fields.nextActions) ? fields.nextActions.filter((entry): entry is string => typeof entry === "string") : [],
    nextSteps: toolSteps(adviceList(fields.next), lookup ?? (() => undefined)),
    result: payload,
  };
}

/** The envelope a structured tool call returns, whatever the action emitted.
 *  structuredResult keeps the command's own JSON document when emitted; every other
 *  successful output (progress text, a log tail) is wrapped in the same shape instead of
 *  returned bare, since the tool declares one outputSchema for all its actions. A text
 *  action's envelope stays silent where a structured one speaks — no healthy, no problems,
 *  no nextActions — a gap can be seen, a guess cannot be trusted. */
export function toolEnvelope(command: Declared, output: string, machineOutput: string | undefined, operationId: string, args: string[] = [], execution?: Execution, lookup?: (name: string) => Declared | undefined, error?: unknown): StructuredResult {
  const structured = structuredResult(command, machineOutput ?? output, operationId, args, execution?.facts, lookup);
  if (structured !== undefined) return { ...structured, changed: changedFact(command, structured.result !== null && typeof structured.result === "object" ? structured.result as { changed?: unknown } : {}, args, execution) };
  // A refusal that never emitted a document still carries its remedy (rf6-fix30): the thrown
  // UserError's advice becomes nextActions/nextSteps, so an MCP client sees the same next
  // step the console's arrow line spells.
  const advice = error instanceof UserError ? error.advice : [];
  return {
    operationId,
    changed: changedFact(command, {}, args, execution),
    problems: [],
    warnings: [],
    nextActions: [...new Set(advice.flatMap(renderCurrentAdviceRows).map(maskSecrets))],
    nextSteps: toolSteps(advice, lookup ?? (() => undefined)),
    result: machineOutput ?? output,
  };
}

/** Masks credential values in a structured error without changing its shape. */
function maskStructuredValue(value: unknown): unknown {
  if (typeof value === "string") return maskSecrets(value);
  if (Array.isArray(value)) return value.map(maskStructuredValue);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    const used = new Set<string>();
    for (const [key, entry] of Object.entries(value)) {
      const base = maskSecrets(key);
      let maskedKey = base;
      let suffix = 2;
      while (used.has(maskedKey)) maskedKey = `${base}#${suffix++}`;
      used.add(maskedKey);
      result[maskedKey] = maskStructuredValue(entry);
    }
    return result;
  }
  return value;
}

/** Masks all nested credential values and keys in a structured error. */
export function maskStructuredResult(result: StructuredResult): StructuredResult {
  return maskStructuredValue(result) as StructuredResult;
}

/** Replaces the command's machine JSON inside captured progress text with its masked form. */
export function maskStructuredOutput(output: string, machineOutput: string | undefined, result: StructuredResult): string {
  if (machineOutput === undefined) return maskSecrets(output);
  const safePayload = JSON.stringify(maskStructuredValue(result.result));
  if (safePayload === undefined) return maskSecrets(output);
  if (!output.includes(machineOutput)) return maskSecrets(output);
  return maskSecrets(output.split(machineOutput).join(safePayload));
}
