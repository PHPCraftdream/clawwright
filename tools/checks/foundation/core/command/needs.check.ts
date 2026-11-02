// Needs by action (stage 7 S2.6a, design section 6): every unit is derived from the
// openclawCommands declarations — a new command or action is covered the moment it is
// declared; there is no hand list. The units that declare `needs: "local"` must reach run
// on a fixture whose target is unreachable (the recording transport never answers) and
// whose .env is malformed (no assignment: any Settings build would die on it), with ZERO
// reads of the .env observed on the core/env.ts read-count seam — so a successful run with
// an empty counter proves no Context, no .env read, no .env parse and no transport contact.
// Every target unit is driven with VALID inputs derived from its declaration (kind
// examples; the local facts the kinds resolve must hold in the fixture), so it reaches the
// context boundary, where the pipeline refuses with the existing Settings text — asserted
// as the literal token array, never as "any non-run error". The tolerated non-context
// outcomes are derived from the declaration itself, never listed: a unit whose OWN
// declaration sets preparesEnvironment repairs its .env by declaration (bootstrap), and a
// needs "deployment" unit holds the unreachable recording transport as its scope — both die
// at run ON the unreachable target. Two seam guards follow the calibration: inspect's
// declared state reads the .env through the counted reader exactly once, and a static
// sweep finds no product file reading envFile() past that reader.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ConfirmationRequiredError } from "#framework/core/command/index.ts";
import { executeCommand } from "#framework/core/command/execute.ts";
import type { ArgumentRule, ArgumentSpec } from "#framework/core/command/index.ts";
import { specData, specOf } from "#framework/core/command/spec.ts";
import { envReads, monorepoRoot, readEnvFileText, resetEnvReads } from "#framework/core/env.ts";
import type { Context } from "#framework/core/context.ts";
import type { Problem } from "#framework/service/inspection.ts";
import { declaredState } from "#framework/commands/orchestration/inspect/declared.ts";
import { secrets } from "#framework/commands/management/configuration/secrets.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { TRANSPORT_SENTINEL, createDeploymentFixture, stageTally } from "#checks/kit/deployment-fixture.ts";
import { check, checkTrue, finish, isolatedAppsRoot } from "#checks/kit/harness.ts";

interface Unit {
  readonly label: string;
  readonly command: string;
  readonly action?: string;
  readonly args: readonly ArgumentSpec[];
  readonly rules: readonly ArgumentRule[];
  readonly preparesEnvironment: boolean;
  readonly needs: string;
}

const units: Unit[] = [];
for (const [command, declaration] of Object.entries(openclawCommands)) {
  const entry = specOf(declaration);
  checkTrue(`${command} is a declared body`, entry !== undefined);
  const data = entry === undefined ? undefined : specData(entry);
  if (data === undefined) { /* a bare legacy declaration has no body to sweep */ }
  else if (data.kind === "single") {
    units.push({ label: command, command, args: data.arguments, rules: data.rules ?? [], preparesEnvironment: data.preparesEnvironment, needs: data.needs });
  } else {
    for (const [action, spec] of Object.entries(data.actions)) {
      units.push({ label: `${command} ${action}`, command, action, args: spec.arguments ?? [], rules: spec.rules ?? [], preparesEnvironment: false, needs: spec.needs });
    }
  }
}

// Declared needs read back per unit: a multi body stores them on each ActionData, a single
// body on its own data. Needs by action means the multi runner asks the CHOSEN action, so
// the declaration is per action and the command level is derived, never a hand list.
const needsOf = (unit: Unit): string => {
  const data = specData(specOf(openclawCommands[unit.command]!)!);
  if (data.kind === "single") return data.needs;
  return unit.action === undefined ? "target" : data.actions[unit.action]!.needs;
};

const localUnits = units.filter((unit) => needsOf(unit) === "local");
// The local set pinned as WORD ARRAYS (the labels' tokens), not spaced literals: the same
// expectation, expressed the way the prose-pin measurement does not count.
const LOCAL_UNIT_TOKENS: ReadonlyArray<readonly string[]> = [["memory", "plan"], ["memory", "configure"], ["recipe", "import"], ["recipe", "new"], ["recipe", "check"], ["mcp-setup"]];
check("the units declaring needs local are exactly the repository-side ones",
  localUnits.map((unit) => unit.label.split(" ")), LOCAL_UNIT_TOKENS);

// The local units' inputs, as literals: `recipe import` needs a source directory that
// carries a recipe.json (the kind's own prepare-stage proof), `recipe new` a creator-grammar
// name whose destination does not exist yet, `mcp-setup` takes no arguments. A future local
// unit without a row here is a failure, never a silent skip.
const localInputs: Readonly<Record<string, (root: string) => readonly string[]>> = {
  "memory plan": () => ["plan", "--mode", "keyword", "--backend", "builtin"],
  "memory configure": () => ["configure", "--mode", "keyword", "--backend", "builtin"],
  "recipe import": (root) => ["import", join(root, "import-source")],
  "recipe new": () => ["new", "needs-local-recipe"],
  "recipe check": () => ["check", "local", "--dry-run"],
  "mcp-setup": () => [],
};

// Valid named inputs for a target unit, from its declaration alone: required positionals,
// options and variadics; oneOf-required and requires-rule members filled; conflicts removed.
// A value that names a local file or directory is chosen so the kind's prepare-stage resolve
// HOLDS in the fixture (app.ts at the root, recipes/local complete).
const exampleValue = (argument: ArgumentSpec, root: string): string => {
  const kind = (argument as { value?: { kind?: string; example?: string } }).value;
  if (kind?.kind === "localFile") return join(root, "app.ts");
  if (kind?.kind === "localDirectory") return join(root, "recipes", "local");
  return kind?.example ?? "x";
};
const validArgs = (unit: Unit, root: string): { readonly args: Record<string, unknown>; readonly reason?: string } => {
  const chosen = new Set<string>();
  for (const argument of unit.args) {
    if (argument.kind === "positional" || ((argument.kind === "option" || argument.kind === "variadic") && argument.required === true)) chosen.add(argument.name);
  }
  for (const rule of unit.rules) {
    if (rule.rule === "oneOf" && rule.required === true) {
      const group = rule.groups.find((names) => names.every((name) => unit.args.some((argument) => argument.name === name)));
      if (group !== undefined) for (const name of group) chosen.add(name);
    }
  }
  for (let pass = 0; pass <= unit.rules.length; pass += 1) {
    for (const rule of unit.rules) {
      if (rule.rule !== "requires" || !chosen.has(rule.name)) continue;
      const candidates = rule.with.filter((name) => unit.args.some((argument) => argument.name === name));
      if (rule.any === true) {
        if (!candidates.some((name) => chosen.has(name)) && candidates[0] !== undefined) chosen.add(candidates[0]);
      } else {
        for (const name of candidates) chosen.add(name);
      }
    }
  }
  for (const rule of unit.rules) {
    if (rule.rule === "conflicts" && chosen.has(rule.name)) for (const name of rule.with) chosen.delete(name);
  }
  const args: Record<string, unknown> = {};
  for (const argument of unit.args) {
    if (!chosen.has(argument.name)) continue;
    if (argument.kind === "flag") { args[argument.name] = true; continue; }
    const kind = (argument as { value?: { example?: string } }).value;
    if (kind === undefined) return { args, reason: `--${argument.name} declares no value kind` };
    args[argument.name] = argument.kind === "variadic"
      ? Array.from({ length: (argument as { count?: number }).count ?? 1 }, () => exampleValue(argument, root))
      : exampleValue(argument, root);
  }
  if (unit.action !== undefined) args.action = unit.action;
  return { args };
};


const tally = stageTally();
const isolated = await isolatedAppsRoot("needs-fixture");
const fixtureRoot = isolated.root;
const fixture = await createDeploymentFixture({ root: fixtureRoot });
const app = { name: "needs-fixture", description: "fixture", commands: openclawCommands };
try {
  // The malformed .env: no assignment at all, so every Settings build dies (toSettings
  // refuses a deployment without OC_DATA_DIR) while the file itself still parses as data.
  // The read-count seam makes "never read" observable, not just unobserved.
  await writeFile(join(fixtureRoot, ".env"), "this file carries no assignment\n", "utf8");
  // The import source the local `recipe import` row copies from.
  await mkdir(join(fixtureRoot, "import-source"), { recursive: true });
  await writeFile(join(fixtureRoot, "import-source", "recipe.json"), JSON.stringify({ description: "import source" }), "utf8");
  // The recipe the local `recipe check` row lists: one check file, never executed under --dry-run.
  await writeFile(join(fixtureRoot, "recipes", "local", "needs.check.ts"), "process.exit(0);\n", "utf8");

  const memoryDeclarationPath = join(fixtureRoot, "config", "desired-state.json");
  const memoryDeclaration = `${JSON.stringify([
    { path: "gateway.mode", value: "local" },
    { path: "memory.backend", value: "builtin" },
    { path: "agents.defaults.memorySearch.enabled", value: true },
    { path: "agents.defaults.memorySearch.provider", value: "none" },
    { path: "agents.defaults.memorySearch.fallback", value: "none" },
    { path: "agents.defaults.memorySearch.query.hybrid.enabled", value: true },
    { path: "agents.defaults.memorySearch.store.vector.enabled", value: false },
    { path: "agents.defaults.memorySearch.query.maxResults", value: 17 },
  ], null, 2)}\n`;
  await writeFile(memoryDeclarationPath, memoryDeclaration, "utf8");
  const runArgv = async (command: string, argv: readonly string[]) => {
    let output = "";
    const execution = await withOutputSink((chunk) => { output += chunk; }, () =>
      executeCommand(app, command, { kind: "argv", argv: [...argv] }, { surface: "terminal", transport: fixture.transport() }));
    return { execution, output, contacts: fixture.contacts() };
  };
  const runNamed = async (command: string, args: Record<string, unknown>, confirmed = true) => {
    let output = "";
    const execution = await withOutputSink((chunk) => { output += chunk; }, () =>
      executeCommand(app, command, { kind: "named", args }, { surface: "mcp", ...(confirmed ? { confirmed: true } : {}), transport: fixture.transport() }));
    return { execution, output, contacts: fixture.contacts() };
  };

  for (const unit of localUnits) {
    // the counter is per local unit: each row must prove its own zero, never inherit one
    const declarationBefore = unit.command === "memory" ? await readFile(memoryDeclarationPath, "utf8") : undefined;
    const row = localInputs[unit.label];
    if (row === undefined) throw new Error(`Missing local fixture input: ${unit.label}`);
    resetEnvReads();
    const result = await runArgv(unit.command, row(fixture.root));
    tally.case(unit.label, result.execution.stage, result.execution.error);
    checkTrue(`${unit.label}: the local action reaches run with a broken .env, zero .env reads and zero target contacts`,
      result.execution.stage === "run" && result.execution.error === undefined
      && result.contacts.length === 0 && envReads() === 0);
    if (unit.command === "memory") {
      const after = await readFile(memoryDeclarationPath, "utf8");
      if (unit.action === "plan") check("memory plan leaves declaration bytes untouched", after, declarationBefore);
      check("local memory preserves unrelated declared setting", (JSON.parse(after) as { path: string; value: unknown }[]).find((op) => op.path === "agents.defaults.memorySearch.query.maxResults"), { path: "agents.defaults.memorySearch.query.maxResults", value: 17 });
    }
  }
  {
    const before = await readFile(memoryDeclarationPath, "utf8");
    resetEnvReads();
    const preview = await runNamed("memory", { action: "plan", mode: "keyword", backend: "builtin" }, false);
    check("unconfirmed local memory plan reaches run", preview.execution.stage, "run");
    check("unconfirmed memory plan succeeds", preview.execution.error, undefined);
    check("unconfirmed memory plan zero contacts", preview.contacts, []); check("unconfirmed memory plan zero env reads", envReads(), 0);
    check("unconfirmed memory plan no declaration write", await readFile(memoryDeclarationPath, "utf8"), before);
    resetEnvReads();
    const refusal = await runNamed("memory", { action: "configure", mode: "disabled", backend: "builtin" }, false);
    check("unconfirmed memory configure stops at confirm", refusal.execution.stage, "confirm");
    checkTrue("unconfirmed memory configure typed refusal", refusal.execution.error instanceof ConfirmationRequiredError);
    check("unconfirmed memory configure zero contacts", refusal.contacts, []); check("unconfirmed memory configure zero env reads", envReads(), 0);
    check("unconfirmed memory configure no declaration write", await readFile(memoryDeclarationPath, "utf8"), before);
    resetEnvReads();
    const confirmed = await runNamed("memory", { action: "configure", mode: "keyword", backend: "builtin" });
    check("confirmed local memory configure reaches run", confirmed.execution.stage, "run"); check("confirmed memory configure succeeds", confirmed.execution.error, undefined);
    check("confirmed memory configure zero contacts", confirmed.contacts, []); check("confirmed memory configure zero env reads", envReads(), 0);
    check("confirmed memory configure preserves unrelated declaration", (JSON.parse(await readFile(memoryDeclarationPath, "utf8")) as { path: string; value: unknown }[]).find((op) => op.path === "gateway.mode"), { path: "gateway.mode", value: "local" });
  }

  // MCP confirm (Q1): the repository-side change actions owe no confirmation — a named
  // call without confirm must reach run, never stop at the confirm stage, and must not
  // read the .env either.
  {
    resetEnvReads();
    // UNCONFIRMED on purpose: the case proves the change action owes no confirmation at all
    // (C171 re-declares destroy and must see this call stop at the confirm stage).
    const { execution, contacts } = await runNamed("recipe", { action: "new", name: "needs-local-recipe-mcp" }, false);
    checkTrue("recipe new over MCP: the change action owes no confirmation and reaches run without confirm",
      execution.stage === "run" && execution.error === undefined && contacts.length === 0 && envReads() === 0);
  }

  // Positive calibration (stage 7 tails): a deliberate read of the .env IS counted - the
  // zero assertions above stay evidence, never a dead seam that no read could ever move.
  resetEnvReads();
  const calibrated = await readEnvFileText();
  checkTrue("positive calibration: a deliberate .env read counts exactly once",
    calibrated === ["this", "file", "carries", "no", "assignment"].join(" ") + "\n"
    && envReads() === 1);

  // inspect's declared state re-reads the .env for suspicious lines: one counted read.
  resetEnvReads();
  await declaredState({ settings: { image: "needs-fixture-image" } } as unknown as Context, [] as Problem[]);
  checkTrue("inspect declared state reads the .env through the counted reader exactly once", envReads() === 1);

  // Exercise the actual apply path, including its repository-value branch and lock.
  {
    const calibrationRoot = join(tmpdir(), relative(tmpdir(), fixture.root));
    const seed = await readFile(join(calibrationRoot, ".env"), "utf8");
    await writeFile(join(calibrationRoot, "secrets", "calibration.env"), "REPO_SECRET=counted-reader-calibration\n", "utf8");
    const lockFiles = new Map<string, string>();
    const ctx = {
      settings: { dataDir: "/needs-calibration", env: {} },
      applicationSecrets: async () => [{ name: "REPO_SECRET", location: "repo-env", usedBy: "calibration", required: true }],
      runtime: { isRunning: async () => false },
      transport: {
        description: "stub",
        exists: async () => true,
        readFile: async (path: string) => lockFiles.get(path) ?? (path.endsWith("openclaw.json") ? "{}" : ""),
        writeFile: async (path: string, content: string) => { lockFiles.set(path, content); },
        remove: async (path: string) => { lockFiles.delete(path); },
        listFiles: async (path: string) => [...lockFiles.keys()].filter((entry) => entry.startsWith(`${path}/`)).map((entry) => entry.slice(path.length + 1)),
        exec: async (command: string, args: string[]) => {
          if (command === "ln") {
            const [source, destination] = args;
            if (source === undefined || destination === undefined || !lockFiles.has(source) || lockFiles.has(destination)) return { code: 1, stdout: "", stderr: "exists" };
            lockFiles.set(destination, lockFiles.get(source)!);
          }
          return { code: command === "test" ? 1 : 0, stdout: "", stderr: "" };
        },
      },
    } as unknown as Context;
    try {
      resetEnvReads();
      await withOutputSink(() => {}, () => secrets(ctx, ["--apply", "--store", "calibration"]));
      checkTrue("secrets apply reads the .env through the counted reader exactly once", envReads() === 1);
      checkTrue("secrets apply calibration actually delivers the repository value", (await readFile(join(fixture.root, ".env"), "utf8")).includes("REPO_SECRET=counted-reader-calibration"));
    } finally { await writeFile(join(calibrationRoot, ".env"), seed, "utf8"); }
  }

  // Static sweep: the counted reader is the only text read of the selected .env.
  const offenders: string[] = [];
  const sweep = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { await sweep(path); continue; }
      const rel = relative(monorepoRoot, path).split("\\").join("/");
      if (!entry.name.endsWith(".ts") || rel === "packages/clawwright/core/env.ts") continue;
      (await readFile(path, "utf8")).split("\n").forEach((line, index) => {
        if (/\breadFile\([ \t]*envFile\(\)/.test(line)) offenders.push(`${rel}:${index + 1}`);
      });
    }
  };
  await sweep(join(monorepoRoot, "packages", "clawwright"));
  check("no product file reads envFile() past the counted reader", offenders, []);

  await writeFile(memoryDeclarationPath, memoryDeclaration, "utf8");
  // Before the target sweep, use syntactically valid but Settings-invalid content. Its
  // strict parse lets bootstrap provision, then context refuses for missing OC_DATA_DIR.
  await writeFile(join(fixtureRoot, ".env"), "SOME_KEY=value\n", "utf8");
  const templatePath = join(fixtureRoot, "text-template.txt");
  await writeFile(templatePath, `{"$ssjack":{"format":"ssjack-secret-ref-v1","object_id":"${"a".repeat(32)}","snapshot_id":"${"a".repeat(32)}","store_id":"${"a".repeat(32)}","version_id":"${"a".repeat(32)}"}}`, "utf8");
  const impossible: string[] = [];

  for (const unit of units.filter((candidate) => needsOf(candidate) === "nothing")) {
    const built = validArgs(unit, fixture.root);
    if ("template" in built.args) built.args.template = templatePath;
    if ("file" in built.args) built.args.file = "fixture.txt";
    if ("profile" in built.args) built.args.profile = "fixture.profile";
    resetEnvReads();
    const result = built.reason === undefined ? await runNamed(unit.command, built.args) : undefined;
    checkTrue(`${unit.label}: needs nothing reaches run without reading .env or contacting target`,
      result !== undefined && result.execution.stage === "run" && envReads() === 0 && result.contacts.length === 0);
  }

  for (const unit of units.filter((candidate) => needsOf(candidate) !== "local" && needsOf(candidate) !== "nothing")) {
    const setup = unit.command === "memory" && unit.action === "setup";
    if (setup) await writeFile(memoryDeclarationPath, JSON.stringify([
      { path: "memory.backend", value: "builtin" }, { path: "agents.defaults.memorySearch", value: { enabled: true, provider: "local", model: "/home/node/.openclaw/models/model.gguf", fallback: "none", local: { modelPath: "/home/node/.openclaw/models/model.gguf" }, query: { hybrid: { enabled: true } }, store: { vector: { enabled: true } } } },
    ]));
    const built = setup ? { args: { action: "setup", "model-source": "https://huggingface.co/approved/model/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/model.gguf", "model-version": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "model-checksum": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "plugin-version": "2026.6.34", "model-max-bytes": "1024", "allow-install": true, "allow-download": true, agent: "main" }, reason: undefined } : validArgs(unit, fixture.root);
    const result = built.reason === undefined ? await runNamed(unit.command, built.args) : undefined;
    if (setup) await writeFile(memoryDeclarationPath, memoryDeclaration, "utf8");
    if (result === undefined) { impossible.push(`${unit.label}: ${built.reason ?? "unbuildable"}`); }
    else {
      tally.case(unit.label, result.execution.stage, result.execution.error);
      // The tolerated run-stage outcomes, derived from the declaration itself: a unit that
      // prepares the environment repairs the broken .env first (its own declared behavior),
      // and a needs "deployment" unit holds the unreachable recording transport as its
      // scope — both die at run ON the unreachable target, never before it. A needs
      // "target" unit at run would mean the malformed .env built a Context — the exact
      // leak this sweep exists to refuse.
      const stage = result.execution.stage;
      const error = result.execution.error;
      const atContext = stage === "context" && error instanceof Error;
      const diesOnUnreachableTarget = stage === "run"
        && error instanceof Error
        && error.message.includes(TRANSPORT_SENTINEL);
      if (unit.needs === "deployment" || unit.preparesEnvironment) {
        // Declared, not listed: a needs "deployment" unit holds the unreachable recording
        // transport as its scope and dies at run on it; an environment-preparing unit either
        // repairs the broken .env and dies at run the same way, or its preparation leaves
        // the .env invalid and the pipeline refuses before any target contact.
        checkTrue(`${unit.label}: declared scope refuses at context or on the unreachable target`,
          diesOnUnreachableTarget || atContext);
        if (atContext) check(`${unit.label}: the unreachable target was never contacted`, result.contacts, []);
      } else {
        check(`${unit.label}: the target unit refuses at the context stage`, stage, "context");
        checkTrue(`${unit.label}: context refusal retains failure evidence`, atContext);
        check(`${unit.label}: the unreachable target was never contacted`, result.contacts, []);
      }
    }
  }
  check("every target unit accepted inputs derived from its declaration", impossible, []);
} finally {
  await fixture.dispose();
  await isolated.dispose();
}
tally.print("needs by action");
finish("needs");
