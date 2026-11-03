// Exposing an application's commands as MCP tools.
//
// Not the bridge to the managed service's own channels — that belongs to the application.
// This server offers *control* of the instance: bootstrap, status, backup, secrets.
//
// The surface is a mirror: what the gate can do from a terminal, a tool call can do.
// Three tiers reach the console and all three are mirrored — the application's own commands
// (app.commands, dispatched in cli.ts); the dispatcher's (help, control-mcp); the gate's,
// which run before a deployment is resolved (check, new-app / init). A command whose
// console behaviour cannot survive being a tool call (it streams, or owns stdio) is
// mirrored in a bounded form declared beside it. What cannot be mirrored at all is listed
// in MCP_EXEMPTIONS below with the reason; tools/checks/mcp-mirror.check.ts fails on
// anything that is neither.
//
// stdout carries JSON-RPC and nothing else. Commands write progress to stderr through the
// log helpers, so that output is captured as the tool result instead of corrupting the
// protocol stream.

import { createInterface } from "node:readline";
import { mcpCommands, type AppCommand, type AppDefinition } from "../../core/app.ts";
import { commandRegistry, renderHelp, type CommandRegistry, type GateCommand } from "../gate.ts";
import { ConfirmationRequiredError } from "../../core/command/errors.ts";
import { CommandFailedError, formatError, maskSecrets } from "../../core/io/log.ts";
import { withOutputSink } from "../../core/io/output.ts";
import { executeBody, executeCommand, type Execution, type CommandIo } from "../../core/command/execute.ts";
import { type CallInput } from "../../core/command/parse/index.ts";
import { toolDescription, inputSchema, STRUCTURED_OUTPUT_SCHEMA, type Declared } from "./schema.ts";
import { maskStructuredOutput, maskStructuredResult, toolEnvelope } from "./call.ts";
import { validate, toArgv } from "./legacy.ts";
import { specOf } from "../../core/command/spec.ts";
import { frameworkVersion } from "../../commands/management/lock.ts";

export * from "./schema.ts";
export * from "./call.ts";
export * from "./legacy.ts";

const PROTOCOL_VERSION = "2025-06-18";

/** Console capabilities that deliberately have no tool, and why. Read by
 *  tools/checks/mcp-mirror.check.ts, so an entry here is a decision on the record.
 *
 *  mcp-serve and control-mcp are the same argument at different heights: a stdio JSON-RPC
 *  server cannot be started by a tool call inside a stdio JSON-RPC server — both would own
 *  the same stdout. `help` is not listed here: it is a tool (see helpTool below), the one
 *  every other tool's shrunk description points at instead of carrying its own `--help`
 *  text whole. */
export const MCP_EXEMPTIONS: Record<string, string> = {
  "mcp-serve": "it is a stdio JSON-RPC server; a client registers it directly (clawwright mcp-setup does), rather than starting it through another one",
  "control-mcp": "it is this server — a tool that starts the server it runs inside answers nothing",
  "--app": "it selects which deployment this server serves, which is settled when the client launches it (mcp-setup writes the flag into .mcp.json); switching mid-session would change what every other tool in the list refers to",
  "version": "answers a human filing a bug report; a tool would only spend the tools/list byte budget",
  "completion": "prints a shell script for a human's own shell profile; a tool call has no shell to register it in, and the byte budget is better spent on tools an agent actually calls",
};

/** Exported so checks pin the `help` tool's summary to the declaration rather than a copy.
 *  Deliberately not the registry `help` entry's summary (integration/gate.ts's
 *  HELP_ENTRY_SUMMARY, "Same as: <command> --help"): that sentence refers to the console
 *  form; this one describes the tool. */
export const HELP_TOOL_SUMMARY = "Full help for one command, or the command list";

/** The `help` tool: not a command, answered through renderHelp like the console's help. Its
 *  argument is the registry's own `help` entry, not a second declaration here — minus the
 *  `choices` list of every command name: tools/list already names every tool, and the enum
 *  would cost about 500 bytes of the byte budget for nothing a client lacks. */
export function helpTool(registry: CommandRegistry): Declared {
  const entry = registry.find("help");
  if (entry === undefined) throw new Error("the registry has no help entry");
  const argument = (entry.arguments ?? []).map((declared) => ({ ...declared, choices: undefined }));
  return { summary: HELP_TOOL_SUMMARY, arguments: argument, readOnly: true };
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/** Runs a command through the shared pipeline with its output captured, so the caller sees
 *  it as the tool result and stdout stays a pure JSON-RPC stream. A failure returns rather
 *  than throws, carrying what the command had already said — losing those lines would leave
 *  a tool call with only the last sentence of a story it could otherwise tell in full. The
 *  Execution rides along: a parse/confirm refusal is answered like a validate refusal, and
 *  the facts drive the envelope. */
async function captureRun(
  app: AppDefinition,
  name: string,
  input: CallInput,
  confirmed: boolean,
  io?: Pick<CommandIo, "transport" | "observe">,
): Promise<{ output: string; machineOutput?: string; failure?: string; execution: Execution }> {
  const chunks: string[] = [];
  const emitted: string[] = [];

  return withOutputSink(
    (chunk) => {
      chunks.push(chunk);
    },
    async () => {
      const execution = await executeCommand(app, name, input, { surface: "mcp", confirmed, ...io });
      if (execution.error === undefined) {
        return { output: chunks.join("").trim(), machineOutput: emitted.join("").trim() || undefined, execution };
      }
      const error = execution.error;
      const failure = formatError(error);
      return { output: chunks.join("").trim(), machineOutput: emitted.join("").trim() || undefined, failure, execution };
    },
    (chunk) => { emitted.push(chunk); },
  );
}

/** The same capture as captureRun, for a gate command (design D6): the one pipeline
 *  (executeBody) on a named call — the binder binds the arguments, the confirm stage owes
 *  its refusal, and a non-zero ExitCode is the run-stage failure, exactly like the process
 *  verdict it replaces. */
async function captureGateBody(
  name: string,
  command: GateCommand,
  input: CallInput,
  confirmed: boolean,
): Promise<{ output: string; failure?: string; execution: Execution }> {
  const chunks: string[] = [];

  return withOutputSink(
    (chunk) => {
      chunks.push(chunk);
    },
    async () => {
      const execution = await executeBody(name, command.body, input, { surface: "mcp", confirmed });
      const output = chunks.join("").trim();
      if (execution.error === undefined) return { output, execution };
      const failure = execution.stage === "run" && execution.error instanceof CommandFailedError
        ? `${name} failed (exit ${execution.error.exitCode})`
        : formatError(execution.error);
      return { output, failure, execution };
    },
  );
}

function send(response: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

// A tools/call id lands here the moment `notifications/cancelled` answers it early — the
// call keeps running to completion (no clean abort; the instance lock protects state
// either way) but its own eventual reply is dropped instead of sent twice.
const cancelledIds = new Set<number | string>();

function reply(id: number | string | undefined, result: unknown): void {
  if (id === undefined) return;
  if (cancelledIds.delete(id)) return;
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: number | string | undefined, code: number, message: string): void {
  if (id === undefined) return;
  if (cancelledIds.delete(id)) return;
  send({ jsonrpc: "2.0", id, error: { code, message: maskSecrets(message) } });
}

async function handleInitialize(id: number | string | undefined, app: AppDefinition): Promise<void> {
  reply(id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: `${app.name}-control`, version: (await frameworkVersion()) ?? "unknown" },
  });
}

/** The schema as sent in tools/list: an empty `required` is the JSON Schema default, so it is
 *  not spelled out (saves bytes on every tool without a required argument). */
function wireSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { required, ...rest } = schema;
  return Array.isArray(required) && required.length === 0 ? rest : schema;
}

function handleToolsList(id: number | string | undefined, tools: [string, AppCommand][], gateTools: GateCommand[], help: Declared): void {
  reply(id, {
    tools: [
      ...tools.map(([name, command]) => ({
        name,
        description: toolDescription(name, command),
        inputSchema: wireSchema(inputSchema(command)),
        // Declared from the command's own metadata alone — a structured tool answers every
        // action in the envelope, so one honest schema covers all of them.
        ...(command.structured === true ? { outputSchema: STRUCTURED_OUTPUT_SCHEMA } : {}),
      })),
      ...gateTools.map((command) => ({
        name: command.name,
        description: toolDescription(command.name, command),
        inputSchema: wireSchema(inputSchema(command)),
      })),
      {
        name: "help",
        description: help.summary,
        inputSchema: wireSchema(inputSchema(help)),
      },
    ],
  });
}

/** The `help` tool call: not an AppCommand or a GateCommand, so it never reaches the
 *  `tools`/`gateTools` lookup in handleToolsCall. */
async function handleHelpTool(
  id: number | string | undefined,
  args: Record<string, unknown>,
  app: AppDefinition,
  gateHelp: string[],
  registry: CommandRegistry,
): Promise<void> {
  const problems = validate(helpTool(registry), args);
  if (problems.length > 0) {
    reply(id, {
      isError: true,
      content: [{ type: "text", text: maskSecrets(`help: ${problems[0]}`) }],
    });
    return;
  }
  const target = typeof args.command === "string" && args.command !== "" ? args.command : undefined;
  const chunks: string[] = [];
  let rendered = true;
  await withOutputSink((chunk) => { chunks.push(chunk); }, async () => {
    // The loop and the console's `help` read the same registry, so a tool call and a typed
    // `help <command>` answer byte for byte alike — and fail alike: an unknown target is an
    // error result here, as the console's exit 1 is there.
    rendered = renderHelp(target, app, registry, gateHelp);
  });
  const output = chunks.join("").trim();
  reply(id, {
    ...(rendered ? {} : { isError: true }),
    content: [{ type: "text", text: output === "" ? "(no output)" : maskSecrets(output) }],
  });
}

/** A tool name not found among the app's own commands: the gate's own list, or -32602. */
async function handleGateToolCall(
  id: number | string | undefined,
  name: string,
  args: Record<string, unknown>,
  gateTools: GateCommand[],
): Promise<void> {
  const gateCommand = gateTools.find((command) => command.name === name);
  if (gateCommand === undefined) {
    replyError(id, -32602, `unknown tool: ${name}`);
    return;
  }
  // The one pipeline (design D6): the binder refuses the call from the declaration, and the
  // confirm stage owes the same refusal a deployment command's does — before anything runs.
  const { output, failure, execution } = await captureGateBody(name, gateCommand, { kind: "named", args }, args.confirm === true);
  if (execution.error !== undefined && (execution.stage === "parse" || execution.stage === "confirm")) {
    reply(id, { isError: true, content: [{ type: "text", text: maskSecrets((execution.error as Error).message) }] });
    return;
  }
  // The mask follows the answer, not the exit status: a healthy gate command's output gets
  // the same treatment as its failure.
  reply(id, {
    ...(failure === undefined ? {} : { isError: true }),
    content: [{
      type: "text",
      text: maskSecrets(failure === undefined
        ? (output === "" ? "(no output)" : output)
        : (output === "" ? failure : `${output}\n\n${failure}`)),
    }],
  });
}

async function handleAppToolCall(
  id: number | string | undefined,
  app: AppDefinition,
  name: string,
  command: AppCommand,
  args: Record<string, unknown>,
  lookup: (name: string) => Declared | undefined,
  io?: Pick<CommandIo, "transport" | "observe">,
): Promise<void> {
  // A declared body binds by name through the console's own binder. A command without a
  // body — a stub server's run-replaced command, a hand-written AppCommand — still parses
  // argv, so it goes through the legacy named→argv bridge (integration/mcp/legacy.ts),
  // validate's shape check first, exactly the pre-binder path.
  const legacy = specOf(command) === undefined;
  let problems: string[] = [];
  if (legacy) problems = validate(command as Declared, args, { name });
  if (problems.length > 0) {
    reply(id, { isError: true, content: [{ type: "text", text: maskSecrets(problems[0] ?? "") }] });
    return;
  }
  const argv = legacy ? toArgv(command as Declared, args) : undefined;
  try {
    const confirmed = args.confirm === true;
    const { output, machineOutput, failure, execution } = await captureRun(
      app, name, legacy ? { kind: "argv", argv: argv! } : { kind: "named", args }, confirmed, io,
    );

    // A parse or confirmation refusal answers like a validate refusal: a bare tool error with
    // the parser's (or confirmation phrase's) own text, no envelope — the call never ran.
    if (execution.error !== undefined && (execution.stage === "parse" || execution.stage === "confirm")) {
      const message = execution.error instanceof ConfirmationRequiredError
        ? execution.error.message
        : (execution.error as Error).message;
      reply(id, { isError: true, content: [{ type: "text", text: maskSecrets(message) }] });
      return;
    }

    // Built from the output alone, never output plus failure text: a command that reports
    // findings and then fails on them (doctor does) still emitted a valid document, and
    // that is what the caller needs most in exactly that case. A structured command wraps
    // EVERY action's output in its declared envelope — text included — so the schema stays
    // true of each response rather than of the actions someone remembered to list. The
    // pipeline's facts (effect, changedWhen) drive `changed`.
    const structured = command.structured === true
      // the envelope's argv is legacy provenance only (a spec command's changedFact reads
      // the pipeline facts, never argv)
      ? toolEnvelope(command, output, machineOutput, `${name}-${Date.now().toString(36)}`, legacy ? argv! : [], execution, lookup, execution.error)
      : undefined;
    // Redaction is not an error-path courtesy: a successful diagnostic prints the same
    // logs, hook output and machine JSON a failure would have, so registered values are
    // masked here too. The one exception is declared on the command (mcp-creds): its
    // success is a deliberate reveal. A failure keeps the mask even there.
    const deliberate = command.exportsSecrets === true;
    const responseStructured = structured === undefined || (deliberate && failure === undefined)
      ? structured
      : maskStructuredResult(structured);

    if (failure === undefined) {
      reply(id, {
        content: [{
          type: "text",
          text: output === "" ? "(no output)" : (deliberate ? output : maskSecrets(output)),
        }],
        ...(responseStructured === undefined ? {} : { structuredContent: responseStructured }),
      });
      return;
    }

    // The command's own output first, then why it stopped — the order a console shows
    // them in, reading as an explanation rather than a bare verdict.
    const failureOutput = structured === undefined ? output : maskStructuredOutput(output, machineOutput, structured);
    reply(id, {
      isError: true,
      content: [{
        type: "text",
        text: maskSecrets(failureOutput === "" ? failure : `${failureOutput}\n\n${failure}`),
      }],
      ...(responseStructured === undefined ? {} : { structuredContent: responseStructured }),
    });
  } catch (error) {
    // Left for what captureRun cannot catch: a failure while building the sink itself.
    const message = formatError(error);
    reply(id, { isError: true, content: [{ type: "text", text: message }] });
  }
}

async function handleToolsCall(
  request: JsonRpcRequest,
  app: AppDefinition,
  tools: [string, AppCommand][],
  gateTools: GateCommand[],
  gateCommands: GateCommand[],
  gateHelp: string[],
  lookup: (name: string) => Declared | undefined,
  registry: CommandRegistry,
  io?: Pick<CommandIo, "transport" | "observe">,
): Promise<void> {
  const params = request.params ?? {};
  // Never String(params.name ?? "") — an object whose toString is not callable (e.g.
  // {"toString": null}) makes String() throw, and nothing here catches it: the whole
  // process would exit, answering neither this request nor any queued after it.
  const name = typeof params.name === "string" ? params.name : "";
  const args = (params.arguments ?? {}) as Record<string, unknown>;

  // Not an AppCommand or a GateCommand — the dispatcher's own alias (see entry/cli.ts) —
  // so it is handled here rather than through the `tools`/`gateTools` lookup below.
  if (name === "help") {
    await handleHelpTool(request.id, args, app, gateHelp, registry);
    return;
  }

  const entry = tools.find(([toolName]) => toolName === name);
  if (entry === undefined) {
    await handleGateToolCall(request.id, name, args, gateTools);
    return;
  }

  const [, command] = entry;
  await handleAppToolCall(request.id, app, name, command, args, lookup, io);
}

export async function serveMcp(app: AppDefinition, gateCommands: GateCommand[] = [], gateHelp: string[] = [], io?: Pick<CommandIo, "transport" | "observe">): Promise<void> {
  const tools = mcpCommands(app);
  // Presented as one list: a client sees what the deployment can do, not which layer
  // dispatches what. Kept apart here only because they are invoked differently — a gate
  // command takes no Context, having to run before there is one.
  const gateTools = gateCommands.filter((command) => MCP_EXEMPTIONS[command.name] === undefined);
  // One registry for the whole surface: the tools/list entry, the `help` tool and the help
  // answers all read the same entries.
  const registry = commandRegistry({ deployment: app.commands, gate: gateCommands, appName: app.name });

  // The tools nextSteps can name: what this server serves, app commands and gate commands
  // alike — the one surface a client called, so a remedy names a tool it can actually call.
  const served = new Map<string, Declared>([
    ...tools.map(([name, command]): [string, Declared] => [name, command as Declared]),
    ...gateTools.map((command): [string, Declared] => [command.name, command as unknown as Declared]),
  ]);
  const lookup = (name: string): Declared | undefined => served.get(name);

  const lines = createInterface({ input: process.stdin });

  // captureRun's output sink (core/io/output.ts) is one process-global slot, so two
  // tools/call runs executing at once would interleave into each other's captured text.
  // Every tools/call is chained onto this queue instead — one command runs at a time —
  // while every other method (ping, tools/list, initialize, cancellation) is answered
  // straight from the loop below and never waits behind it.
  let callQueue: Promise<unknown> = Promise.resolve();
  const inFlightCallIds = new Set<number | string>();

  for await (const line of lines) {
    if (line.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Answered with a null id, as JSON-RPC requires: the request that failed to parse
      // has no id to answer with.
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }

    // `null`, a number, a string, an array — all valid JSON, none a JSON-RPC request. Left
    // unchecked, `request.method` below throws on `null` and crashes the whole loop, so
    // every request still waiting on a response gets nothing back.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as { method?: unknown }).method !== "string") {
      const id = (parsed as { id?: unknown })?.id;
      const validId = typeof id === "string" || typeof id === "number" ? id : null;
      send({ jsonrpc: "2.0", id: validId, error: { code: -32600, message: "invalid request" } });
      continue;
    }

    const request = parsed as JsonRpcRequest;

    switch (request.method) {
      case "initialize":
        await handleInitialize(request.id, app);
        break;

      case "notifications/initialized":
        // Notification: no response expected.
        break;

      case "ping":
        reply(request.id, {});
        break;

      case "tools/list":
        handleToolsList(request.id, tools, gateTools, helpTool(registry));
        break;

      case "tools/call": {
        const id = request.id;
        if (id !== undefined) inFlightCallIds.add(id);
        // Not awaited: queuing (not blocking) this call keeps the loop free to read and
        // answer the next line — a ping, a cancellation, another tools/list.
        callQueue = callQueue
          .then(() => {
            // Cancelled while still queued: never start it.
            if (id !== undefined && cancelledIds.delete(id)) return undefined;
            return handleToolsCall(request, app, tools, gateTools, gateCommands, gateHelp, lookup, registry, io);
          })
          .catch((error) => {
            // handleToolsCall answers its own failures; this only guards a throw from
            // dispatch itself so one bad call cannot break every call queued behind it.
            replyError(id, -32603, error instanceof Error ? error.message : String(error));
          })
          .finally(() => {
            if (id !== undefined) inFlightCallIds.delete(id);
          });
        break;
      }

      case "notifications/cancelled": {
        // Notification: no reply to this message itself. Answers the CALL it names
        // instead, immediately, without waiting for it — see cancelledIds above.
        const requestId = (request.params ?? {}).requestId;
        if (
          (typeof requestId === "string" || typeof requestId === "number")
          && inFlightCallIds.has(requestId)
          && !cancelledIds.has(requestId)
        ) {
          cancelledIds.add(requestId);
          send({
            jsonrpc: "2.0",
            id: requestId,
            result: { isError: true, content: [{ type: "text", text: "cancelled" }] },
          });
        }
        break;
      }

      default:
        replyError(request.id, -32601, `method not found: ${request.method}`);
    }
  }

  // stdin closed; the last queued tools/call may still be running (every link already
  // catches its own rejection above, so this never throws). The caller's own await of
  // serveMcp() must answer for it too, not return while it is still in flight.
  await callQueue;
}
