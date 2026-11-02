// A destructive gate command's MCP tool call owes the same confirmation a deployment
// command's confirm stage enforces: the schema declares `confirm` (derived from the declared
// effect), the call is refused with ConfirmationRequiredError's own text BEFORE the command
// runs, and `confirm: true` lets it through. Driven through the real serveMcp over real
// stdio (a fixture gate command stands in for remove-app, so the check touches only its own
// temp directory on any host).
//
// Also pins the two `help` summaries: the MCP `help` TOOL's (HELP_TOOL_SUMMARY) and the
// registry `help` entry's (HELP_ENTRY_SUMMARY) — one surface, one sentence each, asserted
// against what the surfaces actually render.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "#checks/kit/spawn.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import { CONFIRM_REQUIRED } from "#framework/core/command/index.ts";
import { effectNote } from "#framework/core/io/help-render.ts";
import { effectProfile } from "#framework/core/command/index.ts";
import { commandRegistry, dispatcherHelpLines, HELP_ENTRY_SUMMARY, gateCommandHelp } from "#framework/integration/gate.ts";
import { HELP_TOOL_SUMMARY, helpTool } from "#framework/integration/mcp/server.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { checkoutGate, installedGate } from "#framework/entry/registry.ts";

// --- the two help summaries, each single-sourced ----------------------------------------------

{
  const registry = commandRegistry({ deployment: openclawCommands, gate: [], appName: "fixture" });
  check("the MCP help tool's summary is HELP_TOOL_SUMMARY, not a hand copy", helpTool(registry).summary, HELP_TOOL_SUMMARY);
  const entry = registry.find("help");
  checkTrue("the registry help entry's summary is HELP_ENTRY_SUMMARY", entry?.summary === HELP_ENTRY_SUMMARY);
  check("the command list renders HELP_ENTRY_SUMMARY", dispatcherHelpLines(registry).some((line) => line.includes(HELP_ENTRY_SUMMARY)), true);
}

// --- the destructive gate command over real stdio ----------------------------------------------

const root = await mkdtemp(join(tmpdir(), "clawwright-gate-confirm-"));
const EOL = "\n";
try {
  const marker = join(root, "removed.marker");
  const moduleUrl = (name: string) => new URL(`../../../../../packages/clawwright/${name}.ts`, import.meta.url).href;
  const script = `
    const { serveMcp } = await import(${JSON.stringify(moduleUrl("integration/mcp/server"))});
    const { checkoutGate, installedGate } = await import(${JSON.stringify(moduleUrl("entry/registry"))});
    const { commandBody } = await import(${JSON.stringify(moduleUrl("core/command/spec"))});
    const { materializeGate } = await import(${JSON.stringify(moduleUrl("integration/gate"))});
    const { effectProfile } = await import(${JSON.stringify(moduleUrl("core/command/index"))});
    const kinds = await import(${JSON.stringify(moduleUrl("core/values/kinds"))});
    const { writeFile } = await import("node:fs/promises");
    const destructive = (command) => effectProfile(command).destructive;
    const checkout = checkoutGate().filter(destructive);
    const installed = installedGate(${JSON.stringify(root)}).filter(destructive);
    const gates = [...new Map([...checkout, ...installed].map((command) => [command.name, command])).values()];
    await serveMcp(
      { name: "fixture", description: "fixture", commands: {} },
      [...gates, materializeGate({
        name: "remove-fixture",
        summary: "Delete the fixture's marker",
        body: commandBody({
          needs: "nothing",
          effect: "destroy",
          arguments: [
            { name: "name", description: "Fixture name", kind: "positional", required: true, value: kinds.text("fixture name") },
            { name: "yes", description: "Perform the removal", kind: "flag" },
          ],
          run: async () => { await writeFile(${JSON.stringify(marker)}, "removed" + String.fromCharCode(10)); return 0; },
        }),
      })],
    );
  `;
  const serverScript = join(root, "server.mjs");
  await writeFile(serverScript, script, "utf8");

  const run = async (requests: unknown[]): Promise<Record<string, unknown>[]> => {
    const result = await runProcess(process.execPath, [serverScript], { cwd: root, input: requests.map((request) => JSON.stringify(request)).join(EOL) + EOL });
    if (result.code !== 0) process.stderr.write(`fixture server exited ${result.code}: ${result.stderr}`);
    checkTrue("the fixture server ran", result.code === 0);
    return result.stdout.split(EOL).filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  const markerState = async (): Promise<string | undefined> => {
    try { return await readFile(marker, "utf8"); } catch { return undefined; }
  };

  // The refusal, alone in its own server run: zero side effects is observable only before
  // the confirmed call could have written anything.
  const [listedReply] = await run([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
  const listed = ((listedReply?.result as { tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }> } | undefined)?.tools ?? [])
    .find((tool) => tool.name === "remove-fixture");
  checkTrue("tools/list declares confirm for the destructive gate command", listed?.inputSchema?.properties?.confirm !== undefined);
  checkTrue("and it is required, the command having no read form", listed?.inputSchema?.required?.includes("confirm") === true);

  const gateCommands = [...new Map([...checkoutGate(), ...installedGate(root)].filter((command) => effectProfile(command).destructive).map((command) => [command.name, command])).values()];
  const gateNames = gateCommands.map((command) => command.name);
  const consoleHelp = new Map<string, string>();
  for (const command of gateCommands) {
    let rendered = "";
    await withOutputSink((chunk) => { rendered += chunk; }, async () => gateCommandHelp(command));
    consoleHelp.set(command.name, rendered.trim());
  }
  const helpReplies = await run([
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "help", arguments: { command: "remove-fixture" } } },
      ...gateNames.map((command, index) => ({ jsonrpc: "2.0", id: 20 + index, method: "tools/call", params: { name: "help", arguments: { command } } })),
    ]);
  const helpReply = helpReplies.find((item) => item.id === 4);
  const helpResult = helpReply?.result as { content?: Array<{ text?: string }> } | undefined;
  const mcpHelpWords = (helpResult?.content?.[0]?.text ?? "").split(" ");
  checkTrue("the MCP help tool preserves the gate command effect note", mcpHelpWords.includes("This") && mcpHelpWords.includes("destroys") && mcpHelpWords.includes("state."));
  for (const [index, command] of gateNames.entries()) {
    const reply = helpReplies.find((item) => item.id === 20 + index);
    const result = reply?.result as { content?: Array<{ text?: string }> } | undefined;
    const text = result?.content?.[0]?.text ?? "";
    checkTrue(`MCP help renders gate command ${command}`, text.includes(command));
    const commandDeclaration = gateCommands[index];
    if (commandDeclaration !== undefined) {
      check(`MCP and console help agree for ${command}`, text, consoleHelp.get(command));
      const note = effectNote(commandDeclaration);
      if (note !== undefined) checkTrue(`MCP help preserves ${command} effect note`, text.includes(note));
    }
  }

  const [refusedReply] = await run([{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "remove-fixture", arguments: { name: "fixture" } } }]);
  const refused = refusedReply?.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
  checkTrue("the call without confirm is an error result", refused?.isError === true);
  checkTrue("in ConfirmationRequiredError's own voice", refused?.content?.[0]?.text?.includes(CONFIRM_REQUIRED) === true);
  checkTrue("and the command never ran — zero side effects", await markerState() === undefined);

  const [confirmedReply] = await run([{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "remove-fixture", arguments: { name: "fixture", confirm: true } } }]);
  const confirmed = confirmedReply?.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
  checkTrue("confirm: true lets the call through", confirmed?.isError !== true);
  checkTrue("and the command ran", await markerState() === "removed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}

finish("mcp: gate confirm");
