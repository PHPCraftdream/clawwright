// Checks that a malformed JSON-RPC line does not take down the whole MCP server.
// `null`, a number, a string and an array are all valid JSON but not a JSON-RPC request —
// JSON.parse accepts them, and reading `.method` off `null` used to throw uncaught,
// crashing the process before a later, well-formed request ever got a reply. This spawns
// the real server over real stdio, the same way tools/checks/deploy.check.ts stands in for
// a server that isn't reachable: process survival is not observable through a direct
// function call.
// A scratch deployment is created and removed for the duration: control-mcp only needs
// apps/<name>/app.ts to exist (initialize and the malformed lines never reach a command
// that would need a bootstrapped instance), and the check must not depend on whichever
// deployment happens to already be on this machine.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createName } from "#framework/core/values/names.ts";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "#framework/integration/deployment/scaffold.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { MCP_EXEMPTIONS, STRUCTURED_OUTPUT_SCHEMA, inputSchema, structuredResult, toolDescription } from "#framework/integration/mcp/server.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { callFactsFor, CONFIRM_REQUIRED, specOf, specShape, bindNamed } from "#framework/core/command/index.ts";
import { FULL_TEXT_POINTER, MCP_PARTIAL_MARKER } from "#framework/integration/mcp/schema.ts";

const IMPORT_NOTE = "imported recipe", NOTES_TEXT = "plain notes", progressMasked = "progress mentions ***", gateMasked = "gate says ***";
import { useLinuxHost } from "#checks/foundation/hygiene/linux-host.ts";
import { check, finish, isolatedAppsRoot, requires } from "#checks/kit/harness.ts";
import { runProcess, type ProcessResult } from "#checks/kit/spawn.ts";

useLinuxHost();

// A confirmed call takes the instance lock through the local transport's mkdir/mv, and mcp-creds
// reads a real compose project: hosts without GNU userland (macOS, a stock Windows runner) or
// docker skip those groups through requires() instead of failing them.

const lines = [
  "null",
  "42",
  '"just a string"',
  "[]",
  "{}", // an object, but no method
  '{"jsonrpc":"2.0","id":9,"method":"initialize"}',
  '{"jsonrpc":"2.0","id":10,"method":"tools/list"}',
];

function runServer(name: string, input: string): Promise<ProcessResult> {
  return runProcess(
    process.execPath,
    ["--experimental-strip-types", resolve(monorepoRoot, "tools", "clawwright.ts"), "--app", name, "control-mcp"],
    { cwd: apps.root, input: `${input}\n` },
  );
}

/** The same stdio exchange, against a script that builds its own app in-process (the
 *  progress/mcp-structured-progress check's harness): for a sweep that needs a command declaration
 *  whose stack-bound actions cannot run here. The declaration under test is real; only the
 *  bytes the command emits are stood in for. */
function runScript(script: string, input: string): Promise<ProcessResult> {
  return runProcess(process.execPath, ["--input-type=module", "-e", script], { cwd: apps.root, input: `${input}\n` });
}

const deploymentName = `mcp-check-${randomBytes(4).toString("hex")}`;

// One isolated apps root for every deployment this file creates (the file has no single
// top-level try, so it lives at module scope and is disposed just before finish()).
const apps = await isolatedAppsRoot("mcp-server");

const mainSection = async (): Promise<void> => {
  try {
    await createApp(createName("deployment", deploymentName));

  // A real `recipe import` round trip: one of the plain-text actions, driven end to end.
  const importSource = resolve(apps.root, deploymentName, "fixture-source");
  await mkdir(importSource, { recursive: true });
  await writeFile(resolve(importSource, "recipe.json"), JSON.stringify({ description: "Import probe" }), "utf8");
  lines.push(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "recipe", arguments: { action: "import", name: importSource, confirm: true } } }));
  lines.push(JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "apply", arguments: { set: resolve(importSource, "missing-artifact"), confirm: true } } }));

  const result = await runServer(deploymentName, lines.join("\n"));
  const responses = result.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  check("the process does not crash on malformed input", result.code, 0);
  check("one response per line, including the malformed ones", responses.length, lines.length);
  check(
    "every malformed line gets a JSON-RPC invalid-request error, not silence",
    responses.slice(0, 5).every((r) => (r.error as { code?: number } | undefined)?.code === -32600),
    true,
  );

  const initReply = responses.find((r) => r.id === 9);
  check(
    "the well-formed request sent afterward still gets answered",
    (initReply?.result as { serverInfo?: unknown } | undefined)?.serverInfo !== undefined,
    true,
  );

  // The mirror includes the gate's own commands, which are dispatched before a deployment
  // exists and so are not part of app.commands. This runs through the monorepo gate, whose
  // list is check + new-app.
  const listed = responses.find((r) => r.id === 10);
  const toolNames = ((listed?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? [])
    .map((tool) => tool.name);

  check("the gate's check command is offered as a tool", toolNames.includes("check"), true);
  check("so is new-app", toolNames.includes("new-app"), true);
  check("the deployment's own commands are still there beside them", toolNames.includes("status"), true);
  check(
    "nothing on the exemption list is offered",
    Object.keys(MCP_EXEMPTIONS).some((name) => toolNames.includes(name)),
    false,
  );

  // A plain-text action answers in the declared envelope too, with the command's own
  // output carried as its result — the case the declaration used to lie about.
  const imported = responses.find((r) => r.id === 11)?.result as
    | { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> }
    | undefined;
  check("recipe import succeeds over MCP", imported?.isError, undefined);
  check("recipe import answers in the declared envelope", imported?.structuredContent !== undefined, true);
  check("recipe import reports that it changed something", imported?.structuredContent?.changed, true);
  check("recipe import keeps its own text beside the envelope", String(imported?.content?.[0]?.text ?? "").includes(IMPORT_NOTE), true);

  const applyFailure = responses.find((r) => r.id === 12)?.result as { isError?: boolean; structuredContent?: { changed?: boolean } } | undefined;
  check("apply missing artifact is a tool error", applyFailure?.isError, true);
  check("apply failure before run reports changed false", applyFailure?.structuredContent?.changed, false);

  // --- structured results are declared, so a client knows the shape before calling -------

  const tools = (listed?.result as { tools?: Array<{ name: string; outputSchema?: unknown }> } | undefined)?.tools ?? [];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  check("a structured command declares its output schema", byName.get("inspect")?.outputSchema !== undefined, true);
  check("so does doctor", byName.get("doctor")?.outputSchema !== undefined, true);
  // The other twenty tools are unchanged: adding an envelope to the two that produce one
  // must not quietly promise a shape the rest do not return.
  check("a command that returns a log does not claim one", byName.get("status")?.outputSchema, undefined);
  check("the recipe tool declares one envelope schema for every action", byName.get("recipe")?.outputSchema !== undefined, true);
  check("and it is the envelope schema itself", byName.get("recipe")?.outputSchema, STRUCTURED_OUTPUT_SCHEMA);
  check("nor does a gate command", byName.get("check")?.outputSchema, undefined);
  } finally {
    await rm(resolve(apps.root, deploymentName), { recursive: true, force: true });
  }
};

// Mixed command groups gate only mutating actions. This keeps the MCP contract safe when a
// caller selects `recipe remove --volumes`, while list remains callable without a confirmation.
const recipeSection = async (): Promise<void> => {
  const recipeDeployment = `mcp-check-recipe-${randomBytes(4).toString("hex")}`;
  const recipeLines = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recipe", arguments: { action: "remove", name: "demo", volumes: true } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recipe", arguments: { action: "remove", name: "demo", volumes: true, confirm: false } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recipe", arguments: { action: "list" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "recipe", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/list" },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "help", arguments: { command: "recipe" } } },
  ].map((request) => JSON.stringify(request)).join("\n");

  try {
    await createApp(createName("deployment", recipeDeployment));
    const result = await runServer(recipeDeployment, recipeLines);
    const responses = result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const byId = new Map(responses.map((response) => [response.id, response]));
    const textOf = (id: number): string => String(((byId.get(id)?.result as { content?: Array<{ text?: string }> } | undefined)?.content ?? [])[0]?.text ?? "");

    // Captured (isCaptured() — every MCP call is) always answers `list` in JSON, whether or
    // not --json was asked for; an empty catalog is {recipes:[],bundles:[],broken:[]}, not
    // the text path's "no recipes yet".
    const isEmptyRecipeCatalog = (text: string): boolean => {
      try {
        const parsed = JSON.parse(text) as { recipes?: unknown; bundles?: unknown; broken?: unknown };
        return Array.isArray(parsed.recipes) && parsed.recipes.length === 0
          && Array.isArray(parsed.bundles) && parsed.bundles.length === 0
          && Array.isArray(parsed.broken) && parsed.broken.length === 0;
      } catch {
        return false;
      }
    };

    check("recipe MCP calls keep the server alive", result.code, 0);
    check("recipe remove without confirm is rejected", textOf(1).includes(CONFIRM_REQUIRED), true);
    check("recipe remove with confirm false is rejected", textOf(2).includes(CONFIRM_REQUIRED), true);
    check("read-only recipe list remains available without confirmation", isEmptyRecipeCatalog(textOf(3)), true);
    check("bare recipe with no action runs the list default instead of demanding confirmation", isEmptyRecipeCatalog(textOf(5)), true);

    const recipeTool = (((byId.get(4)?.result as { tools?: Array<{ name: string; description?: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }> } | undefined)?.tools ?? [])
      .find((tool) => tool.name === "recipe"));
    check("recipe MCP schema leaves conditional confirmation optional", (recipeTool?.inputSchema?.required ?? []).includes("confirm"), false);
    check("recipe MCP schema exposes confirmation", recipeTool?.inputSchema?.properties?.confirm !== undefined, true);
    check("recipe MCP description explains conditional confirmation", recipeTool?.description?.includes(MCP_PARTIAL_MARKER), true);
    check("declaration and generated description agree", toolDescription("recipe", openclawCommands.recipe!).includes(MCP_PARTIAL_MARKER) && toolDescription("recipe", openclawCommands.recipe!) === recipeTool?.description, true);
    const required = (inputSchema(openclawCommands.recipe!).required as string[] | undefined) ?? [];
    check("declaration and generated schema agree", required.includes("confirm"), false);
    check("bare recipe arguments are read-only for MCP gating", callFactsFor(openclawCommands.recipe!, []).effect, "read");
    check("recipe list remains read-only for MCP gating", callFactsFor(openclawCommands.recipe!, ["list"]).effect, "read");
    check("recipe status remains read-only for MCP gating", callFactsFor(openclawCommands.recipe!, ["status", "probe"]).effect, "read");
  check("recipe logs remains read-only for MCP gating", callFactsFor(openclawCommands.recipe!, ["logs", "probe"]).effect, "read");
  check("recipe verify is mutating for MCP gating like onboard", callFactsFor(openclawCommands.recipe!, ["verify", "probe"]).effect, "destroy");
  check("recipe onboard is mutating for MCP gating", callFactsFor(openclawCommands.recipe!, ["onboard", "probe"]).effect, "destroy");
  check("recipe diagnose is mutating for MCP gating, same reason as verify", callFactsFor(openclawCommands.recipe!, ["diagnose", "probe"]).effect, "destroy");
  const recipeProperties = inputSchema(openclawCommands.recipe!).properties as Record<string, { enum?: string[] }> | undefined;
  const recipeActionSchema = recipeProperties?.action;
  const recipePointer = `${FULL_TEXT_POINTER}=recipe`;
  check(
    "recipe MCP schema documents import/new/verify/onboard/diagnose actions",
    recipeActionSchema?.enum,
    ["list", "import", "new", "check", "verify", "onboard", "diagnose", "install", "trial", "remove", "inspect", "recover", "migrate", "retire-legacy", "status", "logs", "pin", "run"],
  );
  check("recipe's short MCP description points at the help tool instead", toolDescription("recipe", openclawCommands.recipe!).includes(recipePointer), true);
    check("the help tool explains recipe's app-owned hooks in full", textOf(6).includes("prepare.ts"), true);
    check("recipe install remains destructive for MCP gating", callFactsFor(openclawCommands.recipe!, ["install", "probe"]).effect, "destroy");
    check("recipe remove remains destructive for MCP gating", callFactsFor(openclawCommands.recipe!, ["remove", "probe"]).effect, "destroy");

    const setSchema = inputSchema(openclawCommands.set!);
    check("set MCP schema leaves conditional confirmation optional", (setSchema.required as string[]).includes("confirm"), false);
    check("set MCP description explains conditional confirmation", toolDescription("set", openclawCommands.set!).includes(MCP_PARTIAL_MARKER), true);
    check("set build is mutable without confirmation", callFactsFor(openclawCommands.set!, ["build"]).effect, "change");
    check("set try remains destructive for MCP gating", callFactsFor(openclawCommands.set!, ["try", "--set", "x.tar.gz"]).effect, "destroy");
    check("lock check is read-only for MCP gating", callFactsFor(openclawCommands.lock!, ["--check"]).effect, "read");
    check("lock write remains mutable for MCP gating", callFactsFor(openclawCommands.lock!, []).effect, "change");
  } finally {
    await rm(resolve(apps.root, recipeDeployment), { recursive: true, force: true });
  }
};

//
// The declaration used to carry only action and name, so the dispatcher's third positional —
// the rename — could not be expressed at all (the natural arguments shape was answered with
// "unknown argument: source"), and name's description called it the destination while the
// dispatcher read it as the source. Positionals are emitted in declaration order and an
// absent one is skipped, so new-name sits directly after name: with it the argv grows to
// the three-positional form, without it the two-positional one — the two forms the CLI
// accepts and the dispatcher destructures as [action, name, ...rest].
{
  const recipeCommand = openclawCommands.recipe!;
  const recipeShape = specShape(specOf(recipeCommand)!);
  const binds = (args: Record<string, unknown>) => { try { bindNamed(recipeShape, { kind: "named", args }, "recipe"); return true; } catch { return false; } };
  const plain = { action: "import", name: "fixture-source", confirm: true };
  check("import without a rename binds clean", binds(plain), true);
  const renamed = { action: "import", name: "fixture-source", "new-name": "renamed", confirm: true };
  check("import with a rename binds clean", binds(renamed), true);
  check("the schema documents the rename for clients", (inputSchema(recipeCommand).properties as Record<string, unknown>)["new-name"] !== undefined, true);
}

// A structured read-only command reports changed:false, while the corresponding write remains
// gated and reports changed:true after an explicit confirmation.
const lockSection = async (): Promise<void> => {
  const lockDeployment = `mcp-check-lock-${randomBytes(4).toString("hex")}`;
  const lockLines = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lock", arguments: { check: true, json: true } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lock", arguments: { json: true, confirm: true } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "inspect", arguments: { json: true } } },
    { jsonrpc: "2.0", id: 4, method: "tools/list" },
  ].map((request) => JSON.stringify(request)).join("\n");

  try {
    await createApp(createName("deployment", lockDeployment));
    const result = await runServer(lockDeployment, lockLines);
    const responses = result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const byId = new Map(responses.map((response) => [response.id, response]));
    const structured = (id: number): { changed?: boolean; nextActions?: unknown; nextSteps?: unknown } | undefined =>
      (byId.get(id)?.result as { structuredContent?: { changed?: boolean; nextActions?: unknown; nextSteps?: unknown } } | undefined)?.structuredContent;

    check("lock check is callable without confirmation", byId.get(1)?.error, undefined);
    check("lock check reports changed false", structured(1)?.changed, false);
    check("confirmed lock write succeeds", byId.get(2)?.error, undefined);
    check("lock write reports changed true", structured(2)?.changed, true);

    // The envelope's remedies travel twice — console strings beside the tool form the client
    // can call, matched against the tools this server actually serves (design 1.4). The
    // inspect line beside it dies before its document on an unbootstrapped app and takes the
    // empty-remedy fallback, so the lock check is the call asserted here.
    const servedTools = new Set(((((byId.get(4)?.result as { tools?: Array<{ name: string }> } | undefined)?.tools) ?? []).map((tool) => tool.name)));
    const toolNamesServe = (name: string): boolean => servedTools.has(name);
    const envelope = structured(1);
    const actions = Array.isArray(envelope?.nextActions) ? (envelope?.nextActions as unknown[]) : [];
    const steps = Array.isArray(envelope?.nextSteps) ? (envelope?.nextSteps as { tool?: unknown; arguments?: unknown }[]) : [];
    check("lock session (lock --check): console remedies are present", actions.length > 0 && actions.every((entry) => typeof entry === "string"), true);
    check("lock session (lock --check): the remedies also travel as tool steps", steps.length > 0, true);
    check(
      "lock session (lock --check): every step names a tool this server serves",
      steps.every((step) => typeof step.tool === "string" && toolNamesServe(step.tool) && typeof step.arguments === "object" && step.arguments !== null && !Array.isArray(step.arguments)),
      true,
    );
  } finally {
    await rm(resolve(apps.root, lockDeployment), { recursive: true, force: true });
  }
};

// verify.ts is an app-owned hook invoked with the full Context — the same access prepare.ts
// gets, and prepare may mutate the target. Being named "verify" is not evidence it is
// read-only, so until something the framework itself verified says otherwise, the call
// demands confirm: true like onboard does, and the envelope may not report changed:false on
// the strength of the action's name alone.
const verifySection = (): Promise<void> => requires("gnu-userland", "recipe verify and onboard over MCP", async () => {
  const verifyDeployment = `mcp-check-verify-${randomBytes(4).toString("hex")}`;
  const recipeDir = resolve(apps.root, verifyDeployment, "recipes", "probe");
  const verifyLines = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recipe", arguments: { action: "verify", name: "probe" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "recipe", arguments: { action: "verify", name: "probe", confirm: true } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "recipe", arguments: { action: "onboard", name: "probe", confirm: true } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "recipe", arguments: { action: "list" } } },
  ].map((request) => JSON.stringify(request)).join("\n");

  try {
    await createApp(createName("deployment", verifyDeployment));
    // The confirmed verify is the one call here that reaches a lock-taking command, so the data
    // directory — and with it the instance lock's home beside it — is kept inside the scratch app
    // rather than the scaffold's /srv default, which a check has no business needing write access
    // to. Spelled as the target sees the path: through wsl.exe a drive-letter path would be a
    // relative one, so the drive maps to its /mnt mount; where the transport is local the resolved
    // path is already a plain POSIX one and passes through unchanged. The finally below removes it
    // with the rest of the app.
    const envPath = resolve(apps.root, verifyDeployment, ".env");
    const dataDir = resolve(apps.root, verifyDeployment, "data");
    const drive = /^([A-Za-z]):[\\/](.*)$/.exec(dataDir);
    const targetDataDir = drive === null ? dataDir : `/mnt/${drive[1].toLowerCase()}/${drive[2].replaceAll("\\", "/")}`;
    await writeFile(
      envPath,
      (await readFile(envPath, "utf8")).replace(/^OC_DATA_DIR=.*$/m, `OC_DATA_DIR=${targetDataDir}`),
      "utf8",
    );
    await mkdir(recipeDir, { recursive: true });
    await writeFile(resolve(recipeDir, "recipe.json"), JSON.stringify({ description: "Verify gating probe" }), "utf8");
    await writeFile(resolve(recipeDir, "verify.ts"), "export async function verify() { return { ok: true, problems: [] }; }\n", "utf8");
    await writeFile(resolve(recipeDir, "onboard.ts"), "export async function onboard() { return { ok: true, steps: [\"dashboard ready\"] }; }\n", "utf8");
    const result = await runServer(verifyDeployment, verifyLines);
    const responses = result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const byId = new Map(responses.map((response) => [response.id, response]));
    const textOf = (id: number): string => String(((byId.get(id)?.result as { content?: Array<{ text?: string }> } | undefined)?.content ?? [])[0]?.text ?? "");

    check("recipe verify without confirm is refused like onboard", textOf(1).includes(CONFIRM_REQUIRED), true);
    check("the refusal is a tool error reply", (byId.get(1)?.result as { isError?: boolean } | undefined)?.isError, true);
    check("confirmed recipe verify succeeds", byId.get(2)?.error, undefined);
    const structured = (byId.get(2)?.result as { structuredContent?: { changed?: boolean } } | undefined)?.structuredContent;
    // The hook's own JSON says nothing about changed, so the envelope must fall back to
    // "assume it changed something" — never to changed:false, which nothing here can back.
    check("a confirmed verify is not reported as changed:false", structured?.changed, true);

    const onboardStructured = (byId.get(3)?.result as { structuredContent?: { changed?: boolean; result?: unknown } } | undefined)?.structuredContent;
    check("confirmed recipe onboard succeeds", byId.get(3)?.error, undefined);
    check("a confirmed onboard is not reported as changed:false", onboardStructured?.changed, true);
    check("onboard's own JSON rides in the envelope whole", onboardStructured?.result, { ok: true, steps: ["dashboard ready"] });
    const listReply = byId.get(4)?.result as { structuredContent?: { changed?: boolean; result?: unknown } } | undefined;
    check("recipe list answers in the declared envelope too", listReply?.structuredContent !== undefined, true);
    check("a read-only action's envelope reports it changed nothing", listReply?.structuredContent?.changed, false);
    // list emits its own JSON document when captured (isCaptured() — every MCP call is), so
    // the envelope's result is the parsed catalog, not the command's raw text.
    const listResult = listReply?.structuredContent?.result as { recipes?: { name?: string }[] } | undefined;
    check("its result is the structured catalog, not raw text", Array.isArray(listResult?.recipes), true);
    check("and the catalog names the probe recipe", listResult?.recipes?.some((entry) => entry.name === "probe"), true);
  } finally {
    await rm(resolve(apps.root, verifyDeployment), { recursive: true, force: true });
  }
});

// String(params.name ?? "") used to throw when params.name was an object whose toString is
// not callable — confirmed directly: String({toString: null}) throws "Cannot convert object
// to primitive value". Uncaught inside the dispatch loop, that took the whole process down
// before any request queued after it (including a later initialize) got answered.

// Each server-spawning section owns its own scratch deployment with unique random names, so the
// children (whose cost is dominated by the framework import) run concurrently: a Promise.all of
// at most four tasks. Sections that never spawn a server stay sequential.
await Promise.all([mainSection(), recipeSection(), lockSection(), verifySection()]);

{
  const badCallDeployment = `mcp-check-badcall-${randomBytes(4).toString("hex")}`;
  const malformedCallLines = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":{"toString":null}}}',
    '{"jsonrpc":"2.0","id":3,"method":"initialize"}',
  ];

  try {
    await createApp(createName("deployment", badCallDeployment));
    const result = await runServer(badCallDeployment, malformedCallLines.join("\n"));
    const responses = result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    check("the process does not crash on a tools/call with a non-string params.name", result.code, 0);
    check("all three requests get a reply", responses.length, 3);

    const badCallReply = responses.find((r) => r.id === 2);
    check("the malformed call gets an ordinary JSON-RPC error, not silence", badCallReply?.error !== undefined, true);

    const secondInit = responses.find((r) => r.id === 3);
    check(
      "the request queued after it still gets answered",
      (secondInit?.result as { serverInfo?: unknown } | undefined)?.serverInfo !== undefined,
      true,
    );
  } finally {
    await rm(resolve(apps.root, badCallDeployment), { recursive: true, force: true });
  }
}

// What an agent reads instead of the log. Built from the command's output alone, so the one
// case that matters most is a command that reports findings and then fails on them: the
// document it emitted is still valid and is still what the caller needs.

/** Validates a value against the subset of JSON Schema the declared output schema uses —
 *  driven by the schema object itself, so a future envelope change tightens or loosens
 *  this sweep with it instead of leaving the two to drift. */
function conforms(
  schema: { type?: unknown; required?: unknown; properties?: Record<string, { type?: unknown; items?: { type?: unknown } }> } | undefined,
  value: unknown,
): boolean {
  if (schema === undefined || schema.type !== "object" || value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of (schema.required as string[] | undefined) ?? []) {
    if (!(key in record)) return false;
  }
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    const field = record[key];
    if (field === undefined) continue;
    if (spec.type === "string" && typeof field !== "string") return false;
    if (spec.type === "boolean" && typeof field !== "boolean") return false;
    if (spec.type === "array" && (!Array.isArray(field) || (spec.items?.type === "string" && field.some((entry) => typeof entry !== "string")))) return false;
  }
  return true;
}

{
  const payload = JSON.stringify({
    healthy: false,
    problems: [
      { code: "CONFIG_DRIFT", severity: "blocking", detail: "x", nextAction: "./clawwright apply" },
      { code: "LOCK_MISSING", severity: "warning", detail: "y", nextAction: "./clawwright lock" },
    ],
    nextActions: ["./clawwright apply", "./clawwright lock"],
  });

  const envelope = structuredResult({ summary: "s", structured: true, readOnly: true }, payload, "op-1");
  check("a read-only command states it changed nothing", envelope?.changed, false);
  check("the verdict is carried", envelope?.healthy, false);
  check("problems come through whole", envelope?.problems.length, 2);
  check("warnings are the non-blocking subset", envelope?.warnings, [{ code: "LOCK_MISSING", severity: "warning", detail: "y", nextAction: "./clawwright lock" }]);
  check("the remedies are a list", envelope?.nextActions, ["./clawwright apply", "./clawwright lock"]);
  check("the call names itself", envelope?.operationId, "op-1");
  check("and the command's own document is kept unaltered", JSON.stringify(envelope?.result), payload);
}

{
  const envelope = structuredResult(
    { summary: "s", structured: true },
    JSON.stringify({ operationId: "journal-op", changed: true, problems: [], nextActions: [] }),
    "tool-call-id",
  );
  check("a command operation id is promoted to the envelope", envelope?.operationId, "journal-op");
}

{
  // A command that may change things and does not say: taken to have changed something. An
  // agent that re-checks needlessly loses a call; one that skips a check it needed loses
  // the thread.
  const envelope = structuredResult({ summary: "s", structured: true }, JSON.stringify({ healthy: true }), "op-2");
  check("a mutating command that stays silent is assumed to have changed something", envelope?.changed, true);
  check("and absent fields stay absent rather than being invented", [envelope?.problems, envelope?.nextActions], [[], []]);
}

{
  const envelope = structuredResult({ summary: "s", structured: true }, JSON.stringify({ changed: false, healthy: true }), "op-3");
  check("a command that says it changed nothing is believed", envelope?.changed, false);
}

{
  // A broken promise degrades to what every other tool returns; the text result still
  // stands, so a working call does not become an error over its envelope.
  check("output that is not JSON produces no envelope", structuredResult({ summary: "s", structured: true }, "==> starting\n", "op-4"), undefined);
  check("nor does JSON that is not a document", structuredResult({ summary: "s", structured: true }, "42", "op-5"), undefined);
}

// tools/list used to declare the outputSchema by asking structuredWhen for the one action
// name it happened to return true for, while the dispatcher attached structuredContent to
// a different hardcoded set — nothing ever compared the declaration with what the actions
// really answer. This sweep is that comparison: the action list comes from the real
// declaration's own input schema, every action is driven through the real server loop,
// and each response is validated against the schema tools/list itself declared. The
// command runs are stood in for — status/logs/install/remove need an engine to succeed —
// each emitting exactly its real implementation's captured shape; the run action alone
// reaches its REAL pipeline against the fixture manifest written below. The metadata
// under test — structured, readOnlyWhen, destructive, arguments — is the real list and
// import above also exercise real command implementations.
{
  const recipeCommand = openclawCommands.recipe!;
  const actionChoices = ((inputSchema(recipeCommand).properties as Record<string, { enum?: string[] } | undefined>)?.action?.enum ?? []) as string[];
  check("the declaration enumerates the actions to sweep", actionChoices.length, 18);

  const moduleUrl = (name: string): string => new URL(`../../../../framework/${name}.ts`, import.meta.url).href;
  const sweepRoot = await mkdtemp(join(tmpdir(), "clawwright-mcp-sweep-"));
  await writeFile(join(sweepRoot, ".env"), `OC_DATA_DIR=${join(sweepRoot, "data")}\nOC_TARGET_LOCATION=local\n`, "utf8");
  await mkdir(join(sweepRoot, "recipes", "sidecar", "actions"), { recursive: true });
  await writeFile(join(sweepRoot, "recipes", "sidecar", "recipe.json"), JSON.stringify({ description: "sweep fixture recipe", actions: { announce: { file: "actions/announce.ts", effect: "read", arguments: [] } } }), "utf8");  await writeFile(join(sweepRoot, "recipes", "sidecar", "actions", "announce.ts"), "export function run() { return { ok: true }; }\n", "utf8");  const script = `
    const { serveMcp } = await import(${JSON.stringify(moduleUrl("integration/mcp/server"))});
    const { useDeployment } = await import(${JSON.stringify(moduleUrl("runtime/deployment"))});
    const { managementCommands } = await import(${JSON.stringify(moduleUrl("commands/interface/groups/openclawCommands.management"))});
    const { log, info } = await import(${JSON.stringify(moduleUrl("core/io/log"))});
    const NOTES_TEXT = ${JSON.stringify(NOTES_TEXT)};
    const { emit } = await import(${JSON.stringify(moduleUrl("core/io/output"))});
    const outputs = {
      list: () => { log("available recipes"); info("sidecar          a probe service"); },
      import: () => { log('imported recipe "sidecar"'); info("destination: recipes/sidecar"); },
      check: () => { info("1 recipe check file(s) passed, 0 failed"); }, new: () => { log('created recipe "sidecar"'); info("directory: recipes/sidecar"); },
      install: () => { log("building sidecar (this compiles from source and can take minutes)"); log("sidecar is running"); },
      remove: () => { log("sidecar removed"); }, inspect: () => { info("sidecar: owned namespace"); }, recover: () => { log("service recreated"); }, migrate: () => { log("migration preview"); },
      status: () => { info("running"); }, logs: () => { emit("sidecar-gateway  | ready\\n"); },
      verify: () => { emit(JSON.stringify({ ok: true, problems: [] }) + "\\n"); }, onboard: () => { emit(JSON.stringify({ ok: true, steps: ["dashboard ready"] }) + "\\n"); }, run: () => { emit(JSON.stringify({ ok: true }) + "\\n"); },
      diagnose: () => { emit(JSON.stringify({ recipe: "sidecar", enabled: true, running: true, verify: { ok: true }, logs: "ready" }) + "\\n"); },
    };
    await useDeployment(${JSON.stringify(sweepRoot)});
    await serveMcp({
      name: "sweep",
      commands: {
        recipe: { ...managementCommands.recipe, run: async (ctx, args) => { if ((args[0] ?? "list") === "run") return managementCommands.recipe.run(ctx, args); (outputs[args[0] ?? "list"] ?? outputs.list)(); } },
        notes: { summary: "a text-only tool that declares no envelope", run: async () => { log(NOTES_TEXT); } },
      },
    });
  `;
  const requests = [
    { jsonrpc: "2.0", id: 0, method: "tools/list" },
    ...actionChoices.map((action, index) => ({
      jsonrpc: "2.0",
      id: index + 1,
      method: "tools/call",
      params: { name: "recipe", arguments: { action, ...(action === "recover" ? { service: "sidecar" } : {}), ...(action === "run" ? { name: "sidecar", "recipe-action": "announce" } : {}), ...(recipeCommand.readOnlyWhen?.([action]) === true ? {} : { confirm: true }) } },
    })),
    { jsonrpc: "2.0", id: actionChoices.length + 1, method: "tools/call", params: { name: "notes", arguments: {} } },
  ];

  try {
    const result = await runScript(script, requests.map((request) => JSON.stringify(request)).join("\n"));
    if (result.code !== 0) process.stderr.write(`sweep server exited ${result.code}:\n${result.stderr}\n`);
    const responses = result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const byId = new Map(responses.map((response) => [response.id, response]));
    check("the sweep server answers every request", responses.length, requests.length);

    const listed = ((byId.get(0)?.result as { tools?: Array<{ name: string; outputSchema?: unknown }> } | undefined)?.tools ?? []);
    const byName = new Map(listed.map((tool) => [tool.name, tool]));
    check("the sweep declares the same schema the real server does", byName.get("recipe")?.outputSchema, STRUCTURED_OUTPUT_SCHEMA);
    check("a tool without structured metadata declares no schema", byName.get("notes")?.outputSchema, undefined);

    const schema = byName.get("recipe")?.outputSchema as Parameters<typeof conforms>[0] | undefined;
    for (const action of actionChoices) {
      const reply = byId.get(actionChoices.indexOf(action) + 1)?.result as
        | { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> }
        | undefined;
      const readOnly = recipeCommand.readOnlyWhen?.([action]) === true;
      check(`${action}: the call succeeds`, reply?.isError, undefined);
      check(`${action}: the declared schema is true of the response`, conforms(schema, reply?.structuredContent), true);
      check(`${action}: changed follows the read-only classification`, reply?.structuredContent?.changed, readOnly ? false : true);
      check(`${action}: the command's own text still stands beside the envelope`, String(reply?.content?.[0]?.text ?? "").length > 0, true);
    }

    const envelopeResult = (action: string): unknown =>
      (byId.get(actionChoices.indexOf(action) + 1)?.result as { structuredContent?: { result?: unknown } } | undefined)?.structuredContent?.result;
    check("verify: the hook's JSON rides in the envelope whole", envelopeResult("verify"), { ok: true, problems: [] });
    check("onboard: the same for its own document", envelopeResult("onboard"), { ok: true, steps: ["dashboard ready"] });
    check("run: the fixture action's JSON rides in the envelope whole", envelopeResult("run"), { ok: true });
    check("diagnose: the same for its report", envelopeResult("diagnose"), { recipe: "sidecar", enabled: true, running: true, verify: { ok: true }, logs: "ready" });
    for (const action of ["list", "import", "new", "install", "remove", "inspect", "recover", "migrate", "status", "logs"]) {
      check(`${action}: a text action carries its text as the result`, typeof envelopeResult(action) === "string" && String(envelopeResult(action)).length > 0, true);
    }

    const notes = byId.get(actionChoices.length + 1)?.result as { structuredContent?: unknown; content?: Array<{ text?: string }> } | undefined;
    check("a tool that declares no schema returns no structuredContent", notes?.structuredContent, undefined);
    check("and its plain text is the whole answer", String(notes?.content?.[0]?.text ?? "").includes(NOTES_TEXT), true);
  } finally {
    await rm(sweepRoot, { recursive: true, force: true });
  }
}

// --- a healthy answer goes through the same redaction as a failure -----------------------
//
// Masking used to live only on the error branch, so a hook or a log that echoed a value the
// registry already knew — recipe diagnose being the named case — reached the MCP transcript
// on a clean exit. This drives the real server loop against a scratch deployment whose
// gateway token is registered the way a real session registers it (createContext), with
// commands and gate commands echo the value while succeeding.
{
  const secret = "zt0k_4f8e2d6c9b1a";
  const redactionRoot = await mkdtemp(join(tmpdir(), "clawwright-mcp-redaction-"));
  // mcp-creds now runs requireBootstrapped() (U7) before printing anything, which reaches a
  // real `docker compose ps` — mkdtemp's own suffix can carry uppercase letters, invalid as a
  // Compose project name, so one is pinned explicitly here the same way other real-docker
  // fixtures already do (deployment-names.check.ts, env.check.ts, apply.check.ts, …).
  await writeFile(join(redactionRoot, ".env"), `OC_DATA_DIR=${join(redactionRoot, "data")}\nOC_TARGET_LOCATION=local\nOC_COMPOSE_PROJECT=clawwright-mcp-redaction\nOPENCLAW_GATEWAY_TOKEN=${secret}\n`, "utf8");
  const moduleUrl = (name: string): string => new URL(`../../../../framework/${name}.ts`, import.meta.url).href;
  const script = `
    const { serveMcp } = await import(${JSON.stringify(moduleUrl("integration/mcp/server"))});
    const { useDeployment } = await import(${JSON.stringify(moduleUrl("runtime/deployment"))});
    const { openclawCommands } = await import(${JSON.stringify(moduleUrl("commands/interface/index"))});
    const { emit } = await import(${JSON.stringify(moduleUrl("core/io/output"))});
    const { log, registerSecret } = await import(${JSON.stringify(moduleUrl("core/io/log"))});
    const leaked = ${JSON.stringify(secret)}; registerSecret(leaked);
    await useDeployment(${JSON.stringify(redactionRoot)});
    const { commandBody } = await import(${JSON.stringify(moduleUrl("core/command/spec"))});
    const { materializeGate } = await import(${JSON.stringify(moduleUrl("integration/gate"))});
    const gate = (name, summary, run) => materializeGate({ name, summary, body: commandBody({ needs: "nothing", effect: "read", arguments: [], run }) }); // gate commands are spec bodies (D6)
    const gateEcho = gate("gate-echo", "prints the token and succeeds", async () => { emit("gate says " + leaked + "\\n"); return 0; });
    const gateFail = gate("gate-fail", "prints the token and fails", async () => { emit("gate refused " + leaked + "\\n"); return 7; });
    await serveMcp({
      name: "redaction",
      // Matches docker-compose.yml's real service name — mcp-creds (below) now runs
      // requireBootstrapped() before it prints, which reaches a real \`docker compose ps\`;
      // the default "app" is not a service that compose file declares.
      service: { name: "gateway" },
      commands: {
        "mcp-creds": openclawCommands["mcp-creds"],
        recipe: { ...openclawCommands.recipe, run: async (_ctx, args) => {
          emit(JSON.stringify({ recipe: args[1], verify: { token: leaked }, logs: "gateway | token=" + leaked }) + "\\n");
        } },
        probe: {
          summary: "echoes the token on success", structured: true, readOnly: true,
          run: async () => {
            log("progress mentions " + leaked);
            emit(JSON.stringify({ ok: true, [leaked + "_endpoint"]: "wss://inside", detail: "token=" + leaked }) + "\\n");
          },
        },
      },
    }, [gateEcho, gateFail]);
  `;
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recipe", arguments: { action: "diagnose", name: "sidecar", confirm: true } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "probe", arguments: {} } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mcp-creds", arguments: { token: true } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "gate-echo", arguments: {} } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "gate-fail", arguments: {} } },
  ];
  try {
    const result = await runScript(script, requests.map((request) => JSON.stringify(request)).join("\n"));
    if (result.code !== 0) process.stderr.write(`redaction server exited ${result.code}:\n${result.stderr}\n`);
    const responses = result.stdout.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
    const byId = new Map(responses.map((response) => [response.id, response]));
    const answerOf = (id: number): { isError?: boolean; text: string; structured: string } | undefined => {
      const value = byId.get(id)?.result as { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: unknown } | undefined;
      if (value === undefined) return undefined;
      return { isError: value.isError, text: String(value.content?.[0]?.text ?? ""), structured: JSON.stringify(value.structuredContent) };
    };
    const diagnose = answerOf(1);
    check("recipe diagnose succeeds over MCP", diagnose?.isError, undefined);
    check("diagnose: the raw token is gone from the text", diagnose?.text.includes(secret), false);
    check("diagnose: and from the envelope's report", diagnose?.structured.includes(secret), false);

    const probe = answerOf(2);
    check("probe: the echo command still succeeds", probe?.isError, undefined);
    check("probe: the raw token is gone from the text", probe?.text.includes(secret), false);
    check("probe: masked, not dropped, in the progress text", probe?.text.includes(progressMasked), true);
    check("probe: the raw token is gone from the envelope", probe?.structured.includes(secret), false);
    check("probe: a masked key keeps its shape", probe?.structured.includes("***_endpoint"), true);
    check("probe: a masked value keeps its neighbourhood", probe?.structured.includes("token=***"), true);
    const creds = answerOf(3);
    await requires("gnu-userland", "mcp-creds over MCP", async () => {
      await requires("docker", "mcp-creds over MCP", async () => {
        check("mcp-creds succeeds over MCP", creds?.isError, undefined);
        check("mcp-creds: the declared deliberate export still hands over the token", creds?.text.includes(secret), true);
      });
    });
    const gateOk = answerOf(4);
    check("gate-echo: the healthy gate answer is a success", gateOk?.isError, undefined);
    check("gate-echo: the raw token is gone from the text", gateOk?.text.includes(secret), false);
    check("gate-echo: masked, not dropped, in the gate output", gateOk?.text.includes(gateMasked), true);
    const gateErr = answerOf(5);
    check("gate-fail: the failing gate answer is an error", gateErr?.isError, true);
    check("gate-fail: and it masks the token too", gateErr?.text.includes(secret), false);

    check("mcp-creds is the one command declaring a deliberate export", openclawCommands["mcp-creds"]?.exportsSecrets === true, true);
    check(
      "and no other command claims the exemption",
      Object.keys(openclawCommands).filter((name) => openclawCommands[name]?.exportsSecrets === true),
      ["mcp-creds"],
    );
  } finally {
    await rm(redactionRoot, { recursive: true, force: true });
  }
}

await apps.dispose();
finish("mcp-server");
