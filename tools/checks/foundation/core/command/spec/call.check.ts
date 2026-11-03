// The normalized call form (stage 7 S2.2), table-driven over every command that declares
// actions, derived from the declarations alone. For every action: the console parse asserts
// the SELECTED action's name, the binder binds the named call, toArgv names the action
// first (legacy), and the rendered help's action-choices list is exactly the declared set.
// A positional another action owns, an unknown action and a bare call are refused with one
// text — the console's — and the refusal texts are judged structurally (voice tokens
// spelled here, never the product formatter's own constants). validate/toArgv are legacy;
// the named surface binds through bindNamed — one order of checks, one first refusal, the
// console's words. The unknown-action cases are then answered by the real named MCP
// dispatch (a real serveMcp over the real declarations), and an Object.prototype member is
// never a declared action.

import {
  UnknownActionError, bindNamed, parseCall, selectAction, specShape,
} from "#framework/core/command/index.ts";
import { toArgv } from "#framework/integration/mcp/legacy.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { specOf, specData } from "#framework/core/command/spec.ts";
import { renderCommandHelp } from "#framework/core/io/help-render.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, checkTrue, finish, isolatedAppsRoot } from "#checks/kit/harness.ts";
import { exampleOf, fixture, runCase, runNamed, stages } from "#checks/foundation/core/command/pipeline/property/property-sweep.ts";
import type { ArgumentSpec, CallShape } from "#framework/core/command/index.ts";
import { runProcess } from "#checks/kit/spawn.ts";

const Q = String.fromCharCode(96);

/** The unknown-action voice, spelled here as tokens: the word, every expected name, no
 *  formatter constant. The did-you-mean suffix, when present, only adds text. */
function unknownActionVoice(word: string, names: readonly string[], message: string): boolean {
  return ["unknown", "action:", "(expected"].every((token) => message.includes(token))
    && message.includes(word)
    && names.every((name) => message.includes(name))
    && message.endsWith(")");
}

/** The needs-an-action voice, likewise. */
function needsActionVoice(command: string, names: readonly string[], message: string): boolean {
  return ["needs", "an", "action:"].every((token) => message.includes(token))
    && message.indexOf(command) === 0
    && names.every((name) => message.includes(name));
}

/** The applies-to voice: the property, the token pair, every owner and the chosen action,
 *  each backticked by the formatter but judged here as plain containment. */
function appliesToVoice(argument: string, owners: readonly string[], action: string, message: string): boolean {
  return message.includes(argument)
    && ["applies", "to"].every((token) => message.includes(token))
    && owners.every((owner) => message.includes(Q + owner + Q))
    && message.includes(Q + action + Q);
}

/** The binder's first refusal, if any, for a named call. */
function binderRefusal(shape: CallShape, args: Record<string, unknown>, command: string): Error | undefined {
  try {
    bindNamed(shape, { kind: "named", args }, command);
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

// The real named MCP dispatch: one serveMcp child over the real declarations; every
// unknown-action case is sent as a named tools/call and the bare error text is compared
// with the console's.
interface DispatchCase { readonly command: string; readonly word: string; readonly message: string }
const dispatchCases: DispatchCase[] = [];
let tables = 0;

for (const [command, declaration] of Object.entries(openclawCommands)) {
  const entry = specOf(declaration);
  checkTrue(`${command} is a declared body`, entry !== undefined);
  if (entry === undefined) continue;
  const shape = specShape(entry!);
  if (shape.actions === undefined) continue;
  const data = specData(entry!);
  if (data.kind !== "multi") continue;
  const names = Object.keys(data.actions);
  tables += 1;

  // Help agrees on the action set: the action positional's choices line is the declared
  // actions in declaration order, every word is offered, and an undeclared word is not.
  let help = "";
  await withOutputSink((chunk) => { help += chunk; }, async () => { renderCommandHelp(command, declaration); });
  check(`${command}: help's action choices are the declared actions`, help.includes("[" + names.join("|") + "]"), true);
  for (const action of names) {
    check(`${command}: help offers the action ${Q}${action}${Q}`, help.includes(action), true);
    const slice = data.actions[action].arguments;
    const positionals = slice.filter((argument) => argument.kind === "positional");

    // Typed: the console parse asserts the selected action's NAME (a successful parse
    // that selected anything else fails); MCP validate accepts the named call; the argv
    // named dispatch would build names the action first.
    let call: ReturnType<typeof parseCall> | undefined;
    let parseError: unknown;
    try {
      call = parseCall(shape, [action, ...positionals.map(exampleOf)], command);
    } catch (error) {
      parseError = error;
    }
    if (parseError !== undefined) {
      checkTrue(`${command} ${action}: the console refusal is not about the action`,
        !(parseError instanceof UnknownActionError) && (parseError as { argument?: string }).argument !== "action");
    } else {
      check(`${command} ${action}: the console parse selects the action`, call!.action, action);
    }
    let consoleBare: string | undefined;
    try { parseCall(shape, [action], command); } catch (error) { consoleBare = (error as Error).message; }
    check(`${command} ${action}: the bare named call reads as the console's bare call`, binderRefusal(shape, { action }, command)?.message, consoleBare);
    check(`${command} ${action}: MCP argv names the action first`, toArgv(declaration, { action }), [action]);

    // A positional another action owns is one refusal, in the applies-to voice spelled
    // from the declaration's own owner lists — never bound into the slot.
    const foreign = (declaration.arguments ?? [])
      .filter((argument) => argument.kind === "positional" && argument.name !== "action")
      .find((argument) => !positionals.some((own) => own.name === argument.name));
    if (foreign !== undefined) {
      const owners = (foreign as { actions?: readonly string[] }).actions ?? names;
      const refusal = binderRefusal(shape, { action, [foreign.name]: exampleOf(foreign as ArgumentSpec) }, command);
      checkTrue(`${command} ${action}: the foreign positional is refused, once`, refusal !== undefined);
      checkTrue(`${command} ${action}: the foreign-positional refusal is in the applies-to voice`,
        refusal !== undefined && appliesToVoice(foreign.name, owners, action, refusal.message));
    }
  }

  // Default action and bare call. With a default: the bare console call and the bare named
  // call select it by NAME, and validate accepts the bare call. Without one: both surfaces
  // refuse with the one needs-an-action voice.
  if (shape.defaultAction !== undefined) {
    check(`${command}: the bare console call selects the declared default action`, parseCall(shape, [], command).action, shape.defaultAction);
    check(`${command}: the bare named call selects the default`, selectAction(shape, { kind: "named", args: {} }, command).selected, { name: shape.defaultAction, how: "default" });
    check(`${command}: the binder binds the bare named call`, binderRefusal(shape, {}, command), undefined);
  } else {
    let consoleMessage = "";
    try {
      parseCall(shape, [], command);
    } catch (error) {
      consoleMessage = (error as Error).message;
    }
    let namedMessage = "";
    try {
      selectAction(shape, { kind: "named", args: {} }, command);
    } catch (error) {
      namedMessage = (error as Error).message;
    }
    checkTrue(`${command}: the bare console call is refused in the needs-an-action voice`, needsActionVoice(command, names, consoleMessage));
    checkTrue(`${command}: the bare named call is refused in the same voice`, needsActionVoice(command, names, namedMessage));
    check(`${command}: the bare named call is refused with the console's words`, binderRefusal(shape, {}, command)?.message, consoleMessage);
  }

  // Unknown action: the console refusal is the parse stage with no target contact, in the
  // unknown-action voice; MCP validate refuses with the console's words as its ONLY
  // problem, whatever else the call carries (the console's own order: the action word
  // comes first, so an unknown action outranks an unknown property); and help offers the
  // word to nobody.
  const word = "outside-the-actions";
  if (!names.includes(word)) {
    const terminal = await runCase(command, [word], "terminal");
    stages.case(`${command} ${word}`, terminal.execution.stage, terminal.execution.error);
    check(`${command} ${word}: the console refusal is the parse stage`, terminal.execution.stage, "parse");
    checkTrue(`${command} ${word}: an UnknownActionError`, terminal.execution.error instanceof UnknownActionError);
    const message = (terminal.execution.error as Error).message;
    checkTrue(`${command} ${word}: the console refusal is in the unknown-action voice`, unknownActionVoice(word, names, message));
    check(`${command} ${word}: unknown action refuses with the console's words`, binderRefusal(shape, { action: word }, command)?.message, message);
    check(`${command} ${word}: an unknown property beside it changes nothing`, binderRefusal(shape, { action: word, "no-such-property": "x" }, command)?.message, message);
    const mcp = await runCase(command, [word], "mcp");
    stages.case(`${command} ${word}`, mcp.execution.stage, mcp.execution.error);
    check(`${command} ${word}: the MCP argv pipeline answers the console text`, (mcp.execution.error as Error | undefined)?.message, message);
    check(`${command} ${word}: the refusal never reaches the target`, mcp.contacts, []);
    const named = await runNamed(command, { action: word });
    stages.case(`${command} ${word}`, named.execution.stage, named.execution.error);
    check(`${command} ${word}: the named pipeline answers the console text`, (named.execution.error as Error | undefined)?.message, message);
    check(`${command} ${word}: the named call never reaches the target`, named.contacts, []);
    checkTrue(`${command} ${word}: help offers no such action`, !help.includes(word));
    dispatchCases.push({ command, word, message });
  }
}
checkTrue("the call-form check derived cases from the declarations", tables > 0);

// Object.prototype members are not actions, on either surface: the declared map is
// Object.fromEntries, so selection must test own properties (C10's mutation).
for (const [command, declaration] of Object.entries(openclawCommands)) {
  const entry = specOf(declaration);
  if (entry === undefined) continue;
  const shape = specShape(entry);
  if (shape.actions === undefined) continue;
  const data = specData(entry);
  if (data.kind !== "multi") continue;
  const names = Object.keys(data.actions);
  for (const word of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    if (names.includes(word)) continue;
    const terminal = await runCase(command, [word], "terminal");
    stages.case(`${command} ${word}`, terminal.execution.stage, terminal.execution.error);
    check(`${command} ${word}: prototype name is refused as an unknown action`, terminal.execution.stage, "parse");
    checkTrue(`${command} ${word}: prototype name is an UnknownActionError`, terminal.execution.error instanceof UnknownActionError);
    const message = (terminal.execution.error as Error).message;
    checkTrue(`${command} ${word}: prototype name refusal is in the unknown-action voice`, unknownActionVoice(word, names, message));
    check(`${command} ${word}: prototype name refused with the console's words`, binderRefusal(shape, { action: word }, command)?.message, message);
  }
  break; // the class is one declaration model: the first multi command carries the table
}

// The real named MCP dispatch answers every unknown-action case with the console's text.
if (dispatchCases.length > 0) {
  const moduleUrl = (name: string): string => new URL("../../../../../../packages/clawwright/" + name + ".ts", import.meta.url).href;
  const script = [
    "const { serveMcp } = await import(" + JSON.stringify(moduleUrl("integration/mcp/server")) + ");",
    "const { openclawCommands } = await import(" + JSON.stringify(moduleUrl("commands/interface/index")) + ");",
    "await serveMcp({ name: 'call-form-dispatch', commands: openclawCommands });",
  ].join("\n");
  const requests = dispatchCases.map((dispatchCase, index) => JSON.stringify({
    jsonrpc: "2.0", id: index + 1, method: "tools/call", params: { name: dispatchCase.command, arguments: { action: dispatchCase.word } },
  }));
  const apps = await isolatedAppsRoot("call-dispatch");
  const result = await runProcess(process.execPath, ["--input-type=module", "-e", script], { cwd: apps.root, input: requests.join("\n") + "\n", timeoutMs: 180000 })
    .finally(() => apps.dispose());
  checkTrue("the dispatch server finished", !result.timedOut && result.code === 0);
  if (result.timedOut || result.code !== 0) process.stderr.write(["dispatch server stderr:", result.stderr, ""].join(String.fromCharCode(10)));
  const byId = new Map(result.stdout.split("\n").filter((line) => line.trim() !== "").map((line) => {
    const response = JSON.parse(line) as { id?: number };
    return [response.id, response];
  }));
  for (const [index, dispatchCase] of dispatchCases.entries()) {
    const response = byId.get(index + 1) as { result?: { content?: Array<{ text?: string }> } } | undefined;
    const text = response?.result?.content?.[0]?.text;
    check(`${dispatchCase.command} ${dispatchCase.word}: the named MCP dispatch answers the console text`, text, dispatchCase.message);
  }
}

await fixture.dispose();
stages.print("core/command: call form");
finish("core/command: call form — one action selection for console, MCP and help");
