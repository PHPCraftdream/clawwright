// Golden snapshots of the user-visible surfaces (refactor plan stage 0, item 1).
//
// Renders every surface into memory as deterministic text; golden.check.ts compares the
// result with the committed files under expected/ (not snapshots/: .gitignore keeps every
// snapshots/ out, for instance state), and tools/dev/golden-update.ts writes them. The check
// never writes. Any later step that moves a hint, a description or a tool
// list must show up as a reviewed diff of these files.
//
// Everything here runs without a real target: no docker, no network, no host state. The
// only fixture written is a scratch deployment under a temp apps root (CLAWWRIGHT_CHECKS_APPS_DIR,
// via appsRootFor), created and removed around the subprocess calls that need a resolvable
// deployment, and temp directories under the OS temp dir.
//
// Placeholders scrubbed from every snapshot (see scrub()):
//   <root>      the clawwright checkout root on this machine
//   <tmp>       the OS temp directory
//   <home>      the user's home directory
// The scratch deployment is always named "golden-fixture", so hints that name it are
// stable across machines, and its root is checked-out fresh (rm'd then recreated) each
// run rather than colliding with a developer's apps/.
//
// Known machine dependence, recorded instead of papered over: the checkout gate's top-level
// help, MCP tools/list and the completion scripts are rendered by spawning the real gate
// script as a subprocess (the same path mcp-mirror uses). The gate's own declarations are
// importable since entry/checkout-gate.ts (no side effects at import), so the golden name
// lists come from there. Surfaces reached only past deployment resolution would depend on
// the developer's apps/ — those are rendered in-process from the importable declarations
// through the same renderers the entries call.

import { reportError } from "#framework/core/io/log.ts";
import { createName } from "#framework/core/values/names.ts";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { monorepoRoot } from "#framework/core/env.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { COMPLETION_COMMAND_NAME, COMPLETION_SHELLS } from "#framework/integration/completion/index.ts";
import { checkoutGateCommands } from "#framework/entry/checkout-gate.ts";
import { createApp } from "#framework/integration/deployment/scaffold.ts";
import { checkoutSubfolderReport, missingDeploymentReport, reportUnknownCommand, runGateCommand } from "#framework/integration/gate.ts";
import { reportUnknownArgument } from "#framework/entry/cli.ts";
import { VERSION_COMMAND_NAME } from "#framework/integration/version.ts";
import { renderEntryMatrix } from "./matrix.ts";
import { renderAdviceMatrix } from "./advice.ts";
import { runApp } from "#framework/entry/cli.ts";
import { renderFullCommandHelp } from "#framework/core/io/help-render.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { installFrame, setInvocation, type Invocation } from "#framework/core/io/invocation/index.ts";
import { frameFromInvocation } from "#framework/core/io/invocation/frame.ts";
import { useGateCommands } from "#framework/core/io/invocation/render.ts";
import { checkoutGate } from "#framework/entry/registry.ts";
import { UnknownArgumentError } from "#framework/core/command/index.ts";
import { runProcess } from "#checks/kit/spawn.ts";
import { isolatedAppsRoot } from "#checks/kit/harness.ts";

const GATE_SCRIPT = resolve(monorepoRoot, "tools", "clawwright.ts");
const BIN_SCRIPT = resolve(monorepoRoot, "packages", "clawwright", "entry", "bin.ts");
const FIXTURE_APP = "golden-fixture";

// The gate surfaces that list commands agree on one list: the declared checkout commands
// (entry/checkout-gate.ts) plus the two wired in tools/clawwright.ts.
const CHECKOUT_GATE_HELP_ORDER = checkoutGateCommands.map((command) => command.name);
const CHECKOUT_GATE_SURFACE_ORDER = [...CHECKOUT_GATE_HELP_ORDER, VERSION_COMMAND_NAME, COMPLETION_COMMAND_NAME];

/** Invocations the refusal matrix is rendered under, in the order they appear in refusals.txt. */
const INVOCATIONS: readonly [string, Invocation][] = [
  ["checkout root (./clawwright)", { program: "./clawwright", mode: "checkout", audience: "terminal" }],
  ["named deployment (./clawwright --app demo)", { program: "./clawwright", mode: "checkout", app: { name: "demo", selectedBy: "flag" }, audience: "terminal" }],
  ["installed command (clawwright)", { program: "clawwright", mode: "installed", audience: "terminal" }],
  ["sole deployment (./clawwright --app demo)", { program: "./clawwright", mode: "checkout", app: { name: "demo", selectedBy: "sole" }, audience: "terminal" }],
];

/** Replaces machine-specific path prefixes with the placeholders documented in the header. */
function scrub(text: string): string {
  let result = stripVTControlCharacters(text).replaceAll("\r\n", "\n");
  for (const [placeholder, value] of [["<root>", monorepoRoot], ["<tmp>", tmpdir()], ["<home>", homedir()]] as const) {
    for (const spelling of new Set([value, value.replaceAll("\\", "/")])) {
      result = result.split(spelling).join(placeholder);
    }
  }
  return result;
}

/** Collects everything the body writes through log/info/emit into one string (colours off:
 *  the capture sink never sees escape codes unless a child wrote them, which scrub strips). */
async function captured(body: () => void | Promise<void>): Promise<string> {
  const chunks: string[] = [];
  await withOutputSink((chunk) => { chunks.push(chunk); }, async () => { await body(); });
  return chunks.join("");
}

interface GateOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly input?: string;
}

/** One real gate process, run with this checkout's own entry script. */
function runGate(script: string, args: string[], options: GateOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return runProcess(process.execPath, ["--experimental-strip-types", script, ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.input === undefined ? {} : { input: options.input }),
  });
}

/** Gate process environment pointed at the scratch deployment: hints carry
 *  `--app golden-fixture`, and no command ever sees the developer's own deployments. */
function fixtureEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, OC_APP: FIXTURE_APP };
  delete env.CLAWWRIGHT_INVOKED_AS;
  delete env.CLAWWRIGHT_INVOCATION;
  return env;
}

/** Installed-entry environment: the command names itself `clawwright`, as a global install does. */
function installedEnv(): NodeJS.ProcessEnv {
  return { ...process.env, CLAWWRIGHT_INVOKED_AS: "clawwright" };
}

function section(title: string, body: string): string {
  return `=== ${title} ===\n${body.replace(/\n+$/, "\n")}\n`;
}

/** app.ts for the installed-entry fixture deployment: an installed app.ts imports the
 *  framework as a package; here a file URL stands in for that resolution. Written into a
 *  temp directory, never committed. */
function fixtureAppTs(): string {
  const commands = pathToFileURL(resolve(monorepoRoot, "packages", "clawwright", "commands", "interface", "index.ts")).href;
  return [
    `const { openclawCommands } = await import(${JSON.stringify(commands)});`,
    `export default {`,
    `  name: "clawwright",`,
    `  description: "self-hosting framework for OpenClaw",`,
    `  commands: openclawCommands,`,
    `};`,
    ``,
  ].join("\n");
}

/** `--help` for every deployment command, from the same renderer the console dispatcher
 *  calls (entry/cli.ts's renderFullCommandHelp) — identical on both entries. */
async function deploymentCommandHelp(): Promise<string> {
  const parts: string[] = [];
  for (const name of Object.keys(openclawCommands)) {
    parts.push(section(`${name} --help`, await captured(() => renderFullCommandHelp(name, openclawCommands[name]!))));
  }
  return parts.join("");
}

/** The refusal matrix: one in-process rendering per case and invocation, through the real
 *  gate/cli reporters with the capture sink collecting stderr-shaped output. */
async function refusals(): Promise<string> {
  const parts: string[] = [];

  const underEveryInvocation = async (title: string, body: () => void | Promise<void>): Promise<string> => {
    const rendered: string[] = [];
    for (const [label, invocation] of INVOCATIONS) {
      // The snapshot is host-independent: the frame is built for a pinned POSIX host (as frames.ts does).
      setInvocation(invocation);
      installFrame(frameFromInvocation(invocation, { host: "posix", msys: false, cwd: process.cwd() }));
      rendered.push(section(`${title} — ${label}`, await captured(body)));
    }
    return rendered.join("");
  };

  // The candidate lists mirror the entries: tools/clawwright.ts's baseCommandNames and
  // bin.ts's helpWithoutDeployment candidates. The gate command names come from the
  // declarations module (entry/checkout-gate.ts), not a hand list.
  const checkoutCandidates = [
    ...Object.keys(openclawCommands),
    ...CHECKOUT_GATE_SURFACE_ORDER,
    "help", "control-mcp",
  ];
  const unknownCommand = () => reportUnknownCommand("frobnicate", checkoutCandidates);
  parts.push(await underEveryInvocation("unknown command: frobnicate", unknownCommand));

  const unknownArgument = async () => {
    try {
      // The command refuses before it touches its context, so an empty stub stands in for
      // the Context the dispatcher would have built (plan I5 makes that ordering structural).
      await openclawCommands.status!.run({} as never, ["--bogus"]);
    } catch (error) {
      if (error instanceof UnknownArgumentError) reportUnknownArgument("status", error);
      else throw error;
    }
  };
  parts.push(await underEveryInvocation("unknown argument: status --bogus", unknownArgument));

  // The gate commands are registered as before (they run before a deployment is resolved,
  // so the renderer omits `--app`); the dispatcher pointer is deployment-free by registry
  // origin, derived in refuseDispatcherTokens.
  const genericApp = {
    name: "clawwright",
    description: "self-hosting framework for OpenClaw — this checkout has no deployments yet",
    commands: openclawCommands,
  };
  const gateCommands = checkoutGate();
  useGateCommands(gateCommands.map((command) => command.name));
  for (const command of gateCommands) {
    parts.push(await underEveryInvocation(`unknown argument: ${command.name} --bogus (gate)`, async () => {
      await runGateCommand(gateCommands, [command.name, "--bogus"]);
    }));
  }
  for (const dispatcher of ["help", "control-mcp"] as const) {
    parts.push(await underEveryInvocation(`unknown argument: ${dispatcher} --bogus (dispatcher)`, async () => {
      await runApp(genericApp, [dispatcher, "--bogus"]);
    }));
  }
  parts.push(await underEveryInvocation("missing required: new-app (gate)", async () => { await runGateCommand(gateCommands, ["new-app"]); }));
  // completion's `shell` positional carries choices, and bind refuses a bad value before run.
  parts.push(await underEveryInvocation("invalid choice: completion fish (gate)", async () => { await runGateCommand(gateCommands, ["completion", "fish"]); }));
  // Decision Q3: a gate argument refusal with the command's own --json given prints the same
  // {"error":…} document every other command's refusal prints (the pipeline is one now).
  parts.push(await underEveryInvocation("flag value: list --json --no-status=x (gate)", async () => { await runGateCommand(gateCommands, ["list", "--json", "--no-status=x"]); }));


  const helpWithoutApp = async () => { await runApp(genericApp, ["status", "--help"], []); };
  parts.push(await underEveryInvocation("<command> --help without a deployment: status --help", helpWithoutApp));

  const missingNoOthers = () => {
    reportError(missingDeploymentReport(true, "demo", "<root>/apps/demo", [], false));
  };
  parts.push(await underEveryInvocation("missing deployment, no others available: --app demo", missingNoOthers));

  const missingWithOthers = () => {
    reportError(missingDeploymentReport(false, "openclaw", "<root>/apps/openclaw", ["demo", "staging"], false));
  };
  parts.push(await underEveryInvocation("missing deployment, others available: openclaw", missingWithOthers));

  const subfolder = () => {
    reportError(`no app.ts in <root>`);
    const report = checkoutSubfolderReport("check", "<checkout>");
    if (report !== undefined) reportError(report);
  };
  parts.push(await underEveryInvocation("checkout gate command from a checkout subfolder: check", subfolder));

  return parts.join("");
}

/** Renders every snapshot into memory, keyed by file name under expected/. */
export async function renderGolden(): Promise<Record<string, string>> {
  const snapshots: Record<string, string> = {};

  // --- help ---------------------------------------------------------------------------

  const apps = await isolatedAppsRoot("golden-render");
  try {
    await createApp(createName("deployment", FIXTURE_APP));

    // Checkout entry: the real gate script renders its own top-level help (gate help lines
    // included) with the scratch deployment selected, and each gate command's --help.
    const topHelp = await runGate(GATE_SCRIPT, ["help"], { env: fixtureEnv() });
    const checkoutParts = [section("./clawwright help", topHelp.stderr + topHelp.stdout)];
    for (const gateCommand of CHECKOUT_GATE_SURFACE_ORDER) {
      const help = await runGate(GATE_SCRIPT, [gateCommand, "--help"], { env: fixtureEnv() });
      checkoutParts.push(section(`./clawwright ${gateCommand} --help`, help.stderr + help.stdout));
    }
    checkoutParts.push(section("deployment commands (both entries render these identically)", await deploymentCommandHelp()));
    snapshots["help-checkout.txt"] = checkoutParts.join("");

    // Installed entry: bin.ts run from a fixture deployment in a temp directory, naming
    // itself clawwright like a global install does.
    const installedDir = await mkdtemp(join(tmpdir(), "clawwright-golden-installed-"));
    try {
      await writeFile(resolve(installedDir, "app.ts"), fixtureAppTs(), "utf8");
      const installedTop = await runGate(BIN_SCRIPT, ["help"], { env: installedEnv(), cwd: installedDir });
      const installedParts = [section("clawwright help (installed)", installedTop.stderr + installedTop.stdout)];
      for (const gateCommand of ["init", "version", "completion"]) {
        const help = await runGate(BIN_SCRIPT, [gateCommand, "--help"], { env: installedEnv(), cwd: installedDir });
        installedParts.push(section(`clawwright ${gateCommand} --help (installed)`, help.stderr + help.stdout));
      }
      // One real installed `<deployment command> --help` without a deployment: bin.ts's
      // helpWithoutDeployment path (gate commands only in the listing, note after the body).
      const emptyDir = await mkdtemp(join(tmpdir(), "clawwright-golden-empty-"));
      try {
        const noDeployment = await runGate(BIN_SCRIPT, ["status", "--help"], { env: installedEnv(), cwd: emptyDir });
        installedParts.push(section("clawwright status --help (installed, no app.ts here)", noDeployment.stderr + noDeployment.stdout));
      } finally {
        await rm(emptyDir, { recursive: true, force: true });
      }
      snapshots["help-installed.txt"] = installedParts.join("");
    } finally {
      await rm(installedDir, { recursive: true, force: true });
    }

    // --- MCP tools/list -----------------------------------------------------------------
    //
    // The real server path: control-mcp over stdio on the scratch deployment, one
    // tools/list request, the result pretty-printed.
    const listed = await runGate(
      GATE_SCRIPT,
      ["control-mcp"],
      { env: fixtureEnv(), input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n` },
    );
    const responseLine = listed.stdout.split("\n").find((line) => line.trim() !== "");
    const response = responseLine === undefined ? undefined : JSON.parse(responseLine) as { result?: unknown };
    snapshots["mcp-tools-list.json"] = `${JSON.stringify(response?.result ?? {}, null, 2)}\n`;

  // --- completion scripts ---------------------------------------------------------------
  //
  // Still inside the isolated apps root: every gate spawn below (completion included)
  // must run against the empty scratch apps root, so the root is disposed only after
  // the last spawn, in the finally at the end of this render.

  const completionParts: string[] = [];
  for (const shell of COMPLETION_SHELLS) {
    const script = await runGate(GATE_SCRIPT, ["completion", shell], {});
    completionParts.push(section(`./clawwright completion ${shell}`, script.stdout));
  }
  const emptyDir = await mkdtemp(join(tmpdir(), "clawwright-golden-empty-"));
  try {
    for (const shell of COMPLETION_SHELLS) {
      const script = await runGate(BIN_SCRIPT, ["completion", shell], { env: installedEnv(), cwd: emptyDir });
      completionParts.push(section(`clawwright completion ${shell} (installed)`, script.stdout));
    }
  } finally {
    await rm(emptyDir, { recursive: true, force: true });
  }
  snapshots["completion-scripts.txt"] = completionParts.join("");

  } finally {
    await apps.dispose();
  }

  // --- advice matrix -------------------------------------------------------------------------

  snapshots["advice-matrix.txt"] = renderAdviceMatrix();

  // --- problem codes ----------------------------------------------------------------------

  const { PROBLEM_CODES } = await import("#framework/service/inspection.ts");
  const { renderAdvice, SHIM_PROGRAM } = await import("#framework/core/io/invocation/render.ts");
  const { invocation, setInvocation } = await import("#framework/core/io/invocation/index.ts");
  const before = invocation();
  setInvocation({ program: SHIM_PROGRAM, mode: "checkout", audience: "terminal" });
  const codeLines = Object.entries(PROBLEM_CODES)
    .map(([code, meaning]) => `${code}\t${meaning.severity}\t${renderAdvice(meaning.next)}`)
    .join("\n");
  setInvocation(before);
  snapshots["problem-codes.txt"] = `code\tseverity\tnextAction\n${codeLines}\n`;

  // --- refusals -----------------------------------------------------------------------------

  snapshots["refusals.txt"] = await refusals();

  // --- entry decision matrix ----------------------------------------------------------------

  snapshots["entry-matrix.txt"] = renderEntryMatrix();

  // One heavy render, one scrub: applied uniformly so a new surface cannot forget it.
  return Object.fromEntries(Object.entries(snapshots).map(([name, text]) => [name, scrub(text)]));
}

/** Snapshot directory, resolved from this file so moving the check moves the snapshots. */
export function snapshotsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "expected");
}

/** The committed snapshot text for `name`, with line endings normalised. */
export async function readSnapshot(name: string): Promise<string> {
  return (await readFile(resolve(snapshotsDir(), name), "utf8")).replaceAll("\r\n", "\n");
}
