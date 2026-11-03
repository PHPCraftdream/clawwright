// The commands a message tells the user to run follow how the CLI was invoked: `./clawwright`
// from the monorepo gate or the committed shim, `clawwright` from the system-wide command
// (where `./clawwright` does not even run in cmd.exe or PowerShell). Covered: the helper
// itself, help (Usage and footer), doctor's refusal and its JSON, the MCP envelope built
// from it, the entry's hand-over of the prefix, and the entry's own default invocation.

import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { renderUsage, renderFullCommandHelp } from "#framework/core/io/help-render.ts";
import {
  INVOKED_AS_ENV,
  INVOCATION_ENV,
  invocation,
  parseInvocation,
  parseLegacyInvokedAs,
  serializeInvocation,
  setInvocation,
  takeInvocationFromEnv,
  type Invocation,
} from "#framework/core/io/invocation/index.ts";
import { command, manual, shellLine } from "#framework/core/io/invocation/advice.ts";
import { commandLine, SHIM_PROGRAM, WINDOWS_BIN_PROGRAM } from "#framework/core/io/invocation/render.ts";
import { renderAdvice, renderArguments, useGateCommands } from "#framework/core/io/invocation/render.ts";
import { targetFrame } from "#framework/core/io/invocation/frame.ts";
import { die, formatError, registerSecret, UserError, reportError, info } from "#framework/core/io/log.ts";
import { defaultInvocation } from "#framework/entry/root.ts";
import { emit, emitRaw, withOutputSink } from "#framework/core/io/output.ts";
import { structuredResult } from "#framework/integration/mcp/server.ts";
import { SHIM } from "#framework/integration/deployment/init.ts";
import { mcpLauncherContent } from "#framework/integration/mcp/project.ts";
import { cronLine, displayCommandLine, posixTargetInvocation, schedulerIdentity, withScheduleRunner } from "#framework/commands/operate/schedule.ts";
import { watchInstall } from "#framework/commands/operate/watch/install.ts";
import { deploy } from "#framework/commands/management/deploy/index.ts";
import { bootstrapAndReport } from "#framework/commands/management/deploy/sync.ts";
import { sshTunnelCommand } from "#framework/commands/operate/expose/ssh.ts";
import { deploymentName } from "#framework/runtime/deployment.ts";
import { cmdExeArgv } from "#checks/runtime/schedule/fixture.ts";
import type { Context } from "#framework/core/context.ts";
import { doctor } from "#framework/commands/orchestration/inspect/gather.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { surfaceRegistry } from "#framework/entry/registry.ts";
import { setupFixtureDeployment, teardownFixtureDeployment } from "#checks/runtime/convergence/inspect/fixture.ts";
import { check, finish, isolatedAppsRoot, requires } from "#checks/kit/harness.ts";
import type { AppDefinition } from "#framework/core/app.ts";

const HINT = "./clawwright";

const MONO: Invocation = { program: HINT, mode: "checkout", audience: "terminal" };
const GLOBAL: Invocation = { program: "clawwright", mode: "installed", audience: "terminal" };
const NAMED: Invocation = { ...MONO, app: { name: "staging", selectedBy: "flag" } };

async function capture(body: () => void | Promise<void>): Promise<string> {
  let text = "";
  await withOutputSink((chunk) => { text += chunk; }, async () => { await body(); });
  return text;
}

const app: AppDefinition = { name: "demo", description: "demo deployment", commands: openclawCommands } as AppDefinition;
const { deployment, stubContext } = await setupFixtureDeployment();

/** The sample outputs a user acts on, rendered under whatever prefix is set right now. */
async function samples(): Promise<{ usage: string; commandHelp: string; refusal: string; json: string; envelope: string; nextActions: string[] }> {
  const usage = await capture(() => renderUsage(app, []));
  const commandHelp = await capture(() => renderFullCommandHelp("logs", openclawCommands.logs));
  let refusal = "";
  let json = "";
  let machine = "";
  try {
    await withOutputSink((chunk) => { json += chunk; }, () => doctor(stubContext({ running: false }), ["--json"]), (chunk) => { machine += chunk; });
  } catch (error) {
    refusal = await capture(() => reportError(error));
  }
  const envelope = structuredResult({ summary: "s", structured: true, readOnly: true }, machine, "op");
  return { usage, commandHelp, refusal, json, envelope: JSON.stringify(envelope), nextActions: envelope?.nextActions ?? [] };
}

const apps = await isolatedAppsRoot("invocation-hints");
try {
  // --- the helper -----------------------------------------------------------------------------

  check("nothing set: the monorepo prefix", invocation(), MONO);
  check("commandLine renders the prefix and the rest", commandLine(["bootstrap", "--check"]), "./clawwright bootstrap --check");
  setInvocation(GLOBAL);
  check("commandLine follows the prefix", commandLine(["bootstrap", "--check"]), "clawwright bootstrap --check");
  setInvocation(NAMED);
  check("the app part is in the prefix", commandLine([]), "./clawwright --app staging");
  check("emitRaw never rewrites data", await capture(() => emitRaw("./clawwright up\n")), "./clawwright up\n");
  // The flip: the output layer rewrites nothing. A document and a diagnostic alike leave as
  // they were built, whatever invocation is set right now — advice-matrix.check.ts's P3
  // holds the same law for every advice row, through this very info().
  check("emit passes machine output through", await capture(() => emit("./clawwright up\n")), "./clawwright up\n");
  check("info passes a diagnostic through, adding no --app of its own", await capture(() => info("./clawwright up")).then((text) => text.includes("./clawwright up") && !text.includes("./clawwright --app staging up")), true);
  // Lines copied into another shell or host are printed verbatim under any prefix.
  const cron = cronLine(60, { cwd: "/srv/app1", command: "./clawwright", args: ["--app", "app1", "backup"] }, "backup", "app1");
  const remote = [
    `would bootstrap remotely afterwards: cd '/opt/oc' && ./clawwright --app staging bootstrap`,
    `bring it up there with: cd '/opt/oc' && ./clawwright --app staging bootstrap`,
    `provider keys are not copied — install them there: cd '/srv/openclaw' && ./clawwright --app staging secrets --apply`,
    `  bash -lc "cd /srv/app1 && ./clawwright backup"`,
  ];
  for (const value of [GLOBAL, { ...MONO, app: { name: "x", selectedBy: "flag" } }] as const) {
    setInvocation(value);
    const prefix = commandLine([]);
    for (const line of [cron, ...remote]) {
      check(`info keeps the line verbatim under "${prefix}"`, await capture(() => info(line)).then((text) => text.includes(line)), true);
    }
  }
  // --- the call sites: what they print is what they install or pass on -----------------------
  // What each of these prints is a line built for another shell, host or scheduler. info()
  // now prints it as it was built, so reverting a site to a hand-written text — or making it
  // render for this terminal — turns one of these red under a non-default prefix.

  const ok = { code: 0, stdout: "", stderr: "" };
  const REMOTE = "/mnt/x/clawwright";
  const sshCtx = {
    transport: {
      description: "ssh:user@host",
      async exec(_command: string, args: string[]) { return { ...ok, stdout: `${args[3]}\n` }; },
    },
    settings: { remotePath: "/opt/openclaw" },
  } as unknown as Context;
  const wslTransport = {
    description: "wsl:Ubuntu-24.04",
    clientInvocation: (entry: string, args: string[]) => ({ command: "./clawwright", args: [entry, ...args] }),
  };
  const wslCtx = { transport: wslTransport, paths: { async toTarget() { return REMOTE; } }, settings: {} } as unknown as Context;
  const deployCtx = {
    transport: { description: "local", async exec() { return ok; } },
    runtime: { requiredTools: [] },
    settings: { remotePath: "/opt/openclaw", gatewayPort: 18789 },
  } as unknown as Context;
  const jobs = [
    { label: "backup install", run: (ctx: Context, args: string[]) => openclawCommands.backup.run(ctx, ["install", ...args]), job: "backup", jobArgs: ["backup"], minutes: 1440 },
    { label: "watch install", run: (ctx: Context, args: string[]) => watchInstall(ctx, args), job: "watch", jobArgs: ["watch", "check"], minutes: 5 },
  ];

  for (const value of [GLOBAL, { ...MONO, app: { name: "x", selectedBy: "flag" } }] as const) {
    setInvocation(value);
    const at = `under "${commandLine([])}"`;
    const name = deploymentName();
    for (const { label, run, job, jobArgs, minutes } of jobs) {
      const quotedArgs = jobArgs.map((arg) => `'${arg}'`).join(" ");
      const crontab = cronLine(minutes, await posixTargetInvocation(sshCtx, jobArgs), job, await schedulerIdentity(sshCtx));
      check(`${label} prints the crontab line it would install ${at}`, (await capture(() => run(sshCtx, []))).includes(crontab), true);
      // Pinned literal (rf6-fix33): the invocation part of the line is spelled here, so a
      // posixTargetInvocation that started rendering for this terminal (the invocation's
      // own program) fails THIS instead of silently moving what the crontab would run. The
      // tail after the marker's colon is the ownership hash, not part of the invocation.
      const pinned = `${job === "backup" ? "0 0 * * *" : "*/5 * * * *"} cd '/opt/openclaw' && ./clawwright '--app' '${name}' ${quotedArgs} >/dev/null 2>&1 # clawwright-${job}:`;
      check(`${label} installs the pinned crontab invocation ${at}`, crontab.startsWith(pinned), true);

      // Windows, unsupported transport: the printed lines are the transport's and schtasks' own.
      const applied: string[][] = [];
      const recorder = async (_command: string, args: readonly string[]) => { applied.push([...args]); return ok; };
      const printed = await capture(() => withScheduleRunner(recorder, () => run(wslCtx, []), "win32"));
      await capture(() => withScheduleRunner(recorder, () => run(wslCtx, ["--apply"]), "win32"));
      const manual = wslTransport.clientInvocation(REMOTE, ["--app", deploymentName(), ...jobArgs]);
      const rows = printed.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "").split("\n").map((row) => row.trim());
      check(`${label} prints the transport's own command line ${at}`, rows.includes(displayCommandLine(manual.command, manual.args)), true);
      const schtasks = rows.find((row) => row.startsWith("schtasks "));
      check(`${label}: the printed schtasks line, parsed by cmd.exe, is what --apply passes ${at}`, cmdExeArgv(schtasks ?? ""), ["schtasks", ...(applied[0] ?? [])]);
      // The /tr embeds the same manual line the row above pins, by its display spelling.
      check(`${label}: the schtasks line spells the shim invocation ${at}`, (schtasks ?? "").includes(displayCommandLine(manual.command, manual.args)), true);
    }

    const bootstrap = `cd '/opt/openclaw' && ./clawwright --app ${name} bootstrap`;
    const dry = await capture(() => deploy(deployCtx, ["user@host", "--dry-run"]));
    check(`deploy --dry-run prints the remote bootstrap line verbatim ${at}`, dry.includes(`would bootstrap remotely afterwards: ${bootstrap}`), true);
    const skipped = await capture(() => bootstrapAndReport(deployCtx, "user@host", "/opt/openclaw", name, false, undefined));
    check(`deploy's manual bootstrap hint is verbatim ${at}`, skipped.includes(`bring it up there with: ${bootstrap}`), true);
    // A remote path with a space must survive the paste: the hint quotes it like the code's
    // own remote execution does (review R-A F1).
    const spacedDry = await capture(() => deploy({ ...deployCtx, settings: { remotePath: "/srv/my app", gatewayPort: 18789 } } as unknown as Context, ["user@host", "--dry-run"]));
    check(`deploy --dry-run quotes a spaced remote path ${at}`, spacedDry.includes("would bootstrap remotely afterwards: cd '/srv/my app' &&"), true);
    const spacedSkip = await capture(() => bootstrapAndReport(deployCtx, "user@host", "/srv/my app", name, false, undefined));
    check(`deploy's manual bootstrap hint quotes a spaced remote path ${at}`, spacedSkip.includes("bring it up there with: cd '/srv/my app' &&"), true);
    const done = await capture(() => bootstrapAndReport(deployCtx, "user@host", "/opt/openclaw", name, true, undefined));
    check(`deploy's provider-keys hint is verbatim ${at}`, done.includes(`provider keys are not copied — install them there: cd '/opt/openclaw' && ./clawwright --app ${name} secrets --apply`), true);
    // The tunnel line is the shared sshTunnelCommand + renderArguments construction, so a
    // host carrying shell-active characters survives the paste (rf6-fix30).
    check(`deploy's tunnel line is verbatim ${at}`, done.includes(renderArguments(sshTunnelCommand("user@host", "18789", "18789"))), true);
    const dollarDone = await capture(() => bootstrapAndReport(deployCtx, "user@ho$st", "/opt/openclaw", name, true, undefined));
    check(`deploy's tunnel line quotes a $-host ${at}`, dollarDone.includes(renderArguments(sshTunnelCommand("user@ho$st", "18789", "18789"))), true);
  }

  setInvocation(MONO);
  check("the entry default is the monorepo prefix, without an app part", commandLine([]), HINT);
  check("the default names no deployment", invocation().app, undefined);

  // entry/root.ts decides by the copy that runs (review R16-1). The checkout's own copy is
  // the checkout gate's installed-style entry, so its default names the checkout's shim
  // where it really is — the root spelling from the checkout root, the monorepo MCP
  // launcher's two-levels-up path from apps/<name> — in checkout mode, per the strict
  // reader's coherence rule. The local-package branch (an app's own dependency: the
  // committed shim is bash-only, so Windows names npm's bin wrapper) cannot come out of the
  // checkout copy this process runs, so it is pinned end to end by system-install.check.ts,
  // on a real local package.
  // A checkout copy from apps/<name> two levels under a checkout root holding the launcher:
  // the geometry must exist inside the temp root, since the walk-up no longer finds the real
  // checkout from there. The markers checkoutGateIn() requires (entry/resolve.ts:241-250):
  // tools/clawwright.ts beside packages/clawwright/package.json named @phpcraftdream/clawwright; plus
  // the ./clawwright launcher at the checkout root that the program spelling names. The
  // checkout is passed explicitly — classifyCopy() pins copy.path to the running checkout,
  // and bin.ts hands defaultInvocation() exactly this walked-to checkout (bin.ts:46).
  const fakeCheckout = resolve(apps.root, "synthetic-checkout");
  await mkdir(resolve(fakeCheckout, "tools"), { recursive: true });
  await mkdir(resolve(fakeCheckout, "packages", "clawwright"), { recursive: true });
  await mkdir(resolve(fakeCheckout, "apps", "invocation-hints-probe"), { recursive: true });
  await writeFile(resolve(fakeCheckout, "packages", "clawwright", "package.json"), JSON.stringify({ name: "@phpcraftdream/clawwright" }));
  await writeFile(resolve(fakeCheckout, "tools", "clawwright.ts"), "");
  await writeFile(resolve(fakeCheckout, "clawwright"), "");
  const probeAppRoot = resolve(fakeCheckout, "apps", "invocation-hints-probe");
  check("a checkout copy from the checkout root names the root shim", await defaultInvocation(process.cwd()), { program: SHIM_PROGRAM, mode: "checkout" });
  check("a checkout copy from apps/<name> names the launcher's two-levels-up path", await defaultInvocation(probeAppRoot, undefined, fakeCheckout), { program: "../../clawwright", mode: "checkout" });

  // --- the value between processes: versioned JSON in CLAWWRIGHT_INVOCATION -------------------

  for (const value of [
    MONO,
    GLOBAL,
    NAMED,
    { program: "../../clawwright", mode: "checkout", app: { name: "app1", selectedBy: "cwd" }, audience: "mcp" },
    { program: "../../clawwright", mode: "local-package", audience: "mcp" },
  ] as const) {
    check(`serialize then parse is the identity: ${serializeInvocation(value)}`, parseInvocation(serializeInvocation(value)), value);
  }
  check("the serialized form carries the version", JSON.parse(serializeInvocation(MONO)).version, 1);

  process.env[INVOCATION_ENV] = serializeInvocation(NAMED);
  process.env[INVOKED_AS_ENV] = HINT;
  check("both set, as the shim and launcher now write them: the JSON wins", takeInvocationFromEnv(), NAMED);
  check(
    "both variables are removed, so descendants never inherit them",
    process.env[INVOCATION_ENV] === undefined && process.env[INVOKED_AS_ENV] === undefined,
    true,
  );

  process.env[INVOCATION_ENV] = "not json";
  check("malformed JSON reads as unset", takeInvocationFromEnv(), undefined);
  process.env[INVOCATION_ENV] = '{"version":2,"program":"clawwright","mode":"installed","audience":"terminal"}';
  check("an unknown version reads as unset", takeInvocationFromEnv(), undefined);
  process.env[INVOCATION_ENV] = '{"version":1,"program":"clawwright","mode":"sometimes","audience":"terminal"}';
  check("an unknown mode reads as unset", takeInvocationFromEnv(), undefined);
  process.env[INVOCATION_ENV] = '{"version":1,"program":"clawwright","mode":"installed","audience":"terminal","extra":true}';
  check("an extra field reads as unset — never half a value", takeInvocationFromEnv(), undefined);
  process.env[INVOCATION_ENV] = '{"version":1,"program":"","mode":"installed","audience":"terminal"}';
  check("an empty program reads as unset", takeInvocationFromEnv(), undefined);
  process.env[INVOCATION_ENV] = '{"version":1,"program":" ./clawwright ","mode":"checkout","audience":"terminal"}';
  check("a padded program is trimmed, not stored raw", takeInvocationFromEnv(), { program: "./clawwright", mode: "checkout", audience: "terminal" });
  process.env[INVOCATION_ENV] = '{"version":1,"program":"clawwright","mode":"installed","audience":"terminal","app":{"name":" x ","selectedBy":"flag"}}';
  check("a padded app name is trimmed, not stored raw", takeInvocationFromEnv(), { program: "clawwright", mode: "installed", app: { name: "x", selectedBy: "flag" }, audience: "terminal" });
  process.env[INVOCATION_ENV] = '{"version":1,"program":"clawwright","mode":"installed","audience":"terminal","app":{"name":"x","selectedBy":"sometimes"}}';
  check("an unknown app selection reads as unset", takeInvocationFromEnv(), undefined);
  // Producers spell installed as the bare name and ./-relative as the checkout shim, the MCP
  // launcher or the local-package copy. The committed shim used to spell the rejected pair
  // (./-relative under "installed"); every writer is now checked against this reader below.
  process.env[INVOCATION_ENV] = '{"version":1,"program":"./clawwright","mode":"installed","audience":"terminal"}';
  check("a checkout spelling under installed mode reads as unset", takeInvocationFromEnv(), undefined);
  check("parseInvocation agrees with the env path", parseInvocation('{"version":1,"program":".\\\\clawwright","mode":"installed","audience":"terminal"}'), undefined);
  process.env[INVOCATION_ENV] = '{"version":1,"program":".\\\\clawwright","mode":"checkout","audience":"terminal"}';
  check("the same spelling under checkout mode still parses", takeInvocationFromEnv(), { program: ".\\clawwright", mode: "checkout", audience: "terminal" });
  process.env[INVOCATION_ENV] = serializeInvocation({ program: WINDOWS_BIN_PROGRAM, mode: "local-package", audience: "terminal" });
  check("the Windows bin spelling under local-package still parses", takeInvocationFromEnv(), { program: WINDOWS_BIN_PROGRAM, mode: "local-package", audience: "terminal" });

  process.env[INVOKED_AS_ENV] = "./clawwright --app staging";
  check("the legacy shim variable is mapped onto the value", takeInvocationFromEnv(), NAMED);
  check("it is removed, so descendants never inherit it", process.env[INVOKED_AS_ENV], undefined);
  process.env[INVOKED_AS_ENV] = "clawwright";
  check("legacy without a suffix maps to the program alone", takeInvocationFromEnv(), GLOBAL);
  process.env[INVOKED_AS_ENV] = "/usr/local/bin/clawwright";
  check("a bare path ending in clawwright is still checkout mode", takeInvocationFromEnv(), { program: "/usr/local/bin/clawwright", mode: "checkout", audience: "terminal" });
  process.env[INVOKED_AS_ENV] = "   ";
  check("blank legacy reads as unset", takeInvocationFromEnv(), undefined);
  // A legacy value that is only a flag suffix, or one carrying spacing, is garbage a
  // hand-written variable picked up on the way: it reads as unset (review R-A F3), like the
  // strict parse — otherwise it becomes the program and every advice line opens with it.
  process.env[INVOKED_AS_ENV] = "--app x";
  check("a legacy value that is only the suffix reads as unset", takeInvocationFromEnv(), undefined);
  process.env[INVOKED_AS_ENV] = "a b";
  check("a legacy value with internal spacing reads as unset", takeInvocationFromEnv(), undefined);
  check("parseLegacyInvokedAs refuses a -- program", parseLegacyInvokedAs("--app x"), undefined);
  check("parseLegacyInvokedAs refuses a spaced program", parseLegacyInvokedAs("a b"), undefined);
  check("parseLegacyInvokedAs agrees with the env path", parseLegacyInvokedAs("../../clawwright --app app1"), { program: "../../clawwright", mode: "checkout", app: { name: "app1", selectedBy: "flag" }, audience: "terminal" });
  // R4-A F2: the documented rule — spacing between program and suffix trims away, so a doubled
  // space there still parses, while spacing INSIDE the program does not.
  check("parseLegacyInvokedAs keeps a doubled space between program and suffix", parseLegacyInvokedAs("clawwright  --app x"), { program: "clawwright", mode: "installed", app: { name: "x", selectedBy: "flag" }, audience: "terminal" });

  // --- monorepo prefix: outputs keep ./clawwright --------------------------------------------

  const mono = await samples();
  check("monorepo: Usage", mono.usage.includes("Usage: ./clawwright <command> [options]"), true);
  check("monorepo: help footer", mono.usage.includes("Run `./clawwright help <command>` or `./clawwright <command> --help`"), true);
  check("monorepo: command Usage", mono.commandHelp.includes("Usage: ./clawwright logs"), true);
  check("monorepo: doctor's refusal", mono.refusal.includes("Next: ./clawwright secrets --apply, ./clawwright up"), true);
  check("monorepo: MCP nextActions", mono.nextActions, ["./clawwright secrets --apply", "./clawwright up"]);

  // --- system-wide prefix: no ./clawwright anywhere ------------------------------------------

  setInvocation(GLOBAL);
  const global = await samples();
  check("global: Usage", global.usage.includes("Usage: clawwright <command> [options]"), true);
  check("global: help footer", global.usage.includes("Run `clawwright help <command>` or `clawwright <command> --help`"), true);
  check("global: command Usage", global.commandHelp.includes("Usage: clawwright logs"), true);
  check("global: doctor's refusal", global.refusal.includes("Next: clawwright secrets --apply, clawwright up"), true);
  check("global: doctor's JSON nextActions", global.json.includes('"clawwright up"'), true);
  check("global: MCP nextActions are what a human would type", global.nextActions, ["clawwright secrets --apply", "clawwright up"]);
  for (const [name, text] of Object.entries(global)) {
    if (typeof text === "string") check(`global: ${name} has no ./clawwright`, text.includes(HINT), false);
  }
  check("global: MCP nextActions have no ./clawwright", global.nextActions.some((entry) => entry.includes(HINT)), false);

  // --- the advice renderer --------------------------------------------------------------------
  // One renderer turns advice — a clawwright command, a shell line, a manual step — into the
  // exact text a user pastes. The `--app` rule and the argument quoting live there and only
  // there; advice.ts is data.

  const SELECTIONS: readonly { readonly label: string; readonly on: Invocation; readonly named: boolean }[] = [
    { label: "no app", on: MONO, named: false },
    // --app openclaw is the exception once OC_APP is exported, so it is named; the default is not.
    { label: "openclaw by flag", on: { ...MONO, app: { name: "openclaw", selectedBy: "flag" } }, named: true },
    { label: "openclaw by default", on: { ...MONO, app: { name: "openclaw", selectedBy: "default" } }, named: false },
    { label: "flag", on: { ...MONO, app: { name: "demo", selectedBy: "flag" } }, named: true },
    { label: "env", on: { ...MONO, app: { name: "demo", selectedBy: "env" } }, named: true },
    { label: "sole", on: { ...MONO, app: { name: "demo", selectedBy: "sole" } }, named: true },
    { label: "cwd", on: { ...MONO, app: { name: "demo", selectedBy: "cwd" } }, named: false },
    { label: "default", on: { ...MONO, app: { name: "demo", selectedBy: "default" } }, named: false },
  ];
  const STATUS = `${HINT} status`;
  const DEMO_STATUS = `${HINT} --app demo status`;
  const DEMO_LOGS = `${HINT} --app demo logs`;
  const NEW_APP_LINE = `${HINT} new-app <name>`;
  const CHECK_LINE = `${HINT} check`;
  const DEMO_CHECK = `${HINT} --app demo check`;
  const SPACED_LOGS = `${HINT} logs 'a b'`;
  const NOTED_UP = `${HINT} up  (after the change)`;
  const MANUAL_TEXT = "reconnect the MCP client (in Claude Code: /mcp)";
  const SHELL_TEXT = "cd /srv && ./clawwright backup";
  const SHELL_NOTE = "on the target";
  const NOTED_SHELL = `${SHELL_TEXT}  (${SHELL_NOTE})`;
  const ARROW = "\n    → ";

  // 1. The `--app` rule per selectedBy: the pasted command names the deployment exactly when the
  //    invocation on screen would not re-select it by itself.
  for (const { label, on, named } of SELECTIONS) {
    setInvocation(on);
    check(`a status advice line under ${label}`, renderAdvice(command(["status"])), named ? `${HINT} --app ${on.app?.name} status` : STATUS);
  }

  // 2. Gate commands run before a deployment is resolved, so they never receive an --app — the
  //    same names both entries register before any command runs.
  const GATE_NAMES = surfaceRegistry().entries.filter((entry) => entry.origin === "gate").map((entry) => entry.name);
  useGateCommands(GATE_NAMES);
  const FLAG_DEMO: Invocation = { ...MONO, app: { name: "demo", selectedBy: "flag" } };
  setInvocation(FLAG_DEMO);
  check("a gate command never gets an --app", renderAdvice(command(["new-app", "<name>"])), NEW_APP_LINE);
  check("the check runner itself never gets one", renderAdvice(command(["check"])), CHECK_LINE);

  // 3. An explicit app on the advice wins over the invocation, gate command or not.
  setInvocation(MONO);
  check("an explicit app under no app", renderAdvice(command(["status"], { app: "demo" })), DEMO_STATUS);
  check("an explicit app on a gate command", renderAdvice(command(["check"], { app: "demo" })), DEMO_CHECK);

  // 4. Quoting follows the program's shape, not the shell's: a path spelling is a POSIX shell
  //    (single quotes), the bare system-wide command is cmd/PowerShell (double quotes). A
  //    placeholder <…> stays bare under both.
  check("a spaced word under a path spelling", renderAdvice(command(["logs", "a b"])), SPACED_LOGS);
  check("a placeholder stays bare under a path spelling", renderAdvice(command(["new-app", "<name>"])), NEW_APP_LINE);
  setInvocation(GLOBAL);
  let hostQuote = '"';
  await requires("posix-host", "a posix host's bare program pastes into sh, which quotes with single quotes", () => { hostQuote = "'"; });
  check("a spaced word under the bare program", renderAdvice(command(["logs", "a b"])).split(" "), ["clawwright", "logs", `${hostQuote}a`, `b${hostQuote}`]);
  check("a placeholder stays bare under the bare program", renderAdvice(command(["new-app", "<name>"])), "clawwright new-app <name>");

  // 5. A note trails the line, after two spaces.
  setInvocation(MONO);
  check("a note trails the command", renderAdvice(command("up", { note: "after the change" })), NOTED_UP);

  // 6. A shell line is its own text, byte for byte, under every invocation; only a note appends.
  for (const shell of ["posix", "cmd", "pwsh"] as const) {
    for (const { label, on } of SELECTIONS) {
      setInvocation(on);
      check(`a ${shell} line is verbatim under ${label}`, renderAdvice(shellLine(shell, SHELL_TEXT)), SHELL_TEXT);
      check(`a ${shell} line keeps its note under ${label}`, renderAdvice(shellLine(shell, SHELL_TEXT, { note: SHELL_NOTE })), NOTED_SHELL);
    }
  }

  // 7. A manual step is its own text.
  setInvocation(MONO);
  check("a manual step is its text", renderAdvice(manual(MANUAL_TEXT)), MANUAL_TEXT);

  // 8. Stored shim text (S1.5b: the target frame, shimInvocation retired) spells the shim
  //    program itself, and a bare-program invocation is untouched by it.
  setInvocation(GLOBAL);
  const SHIM_TARGET = targetFrame({ kind: "checkout-shim", root: "" }, "posix");
  check("the stored shim text spells the checkout program", renderAdvice(command(["status"]), SHIM_TARGET), STATUS);
  check("the stored shim text names its app", renderAdvice(command(["status"], { app: "demo" }), SHIM_TARGET), DEMO_STATUS);
  check("a bare-program invocation is untouched by the shim", renderAdvice(command(["status"])), "clawwright status");

  // 9. The error path: die and UserError carry advice, formatError appends one rendered line
  //    per piece, and reportError prints the whole thing verbatim through the output sink.
  let failure: unknown;
  try {
    die("bootstrap failed", command(["logs"]));
  } catch (error) {
    failure = error;
  }
  setInvocation(MONO);
  check("formatError appends the advice line under the checkout prefix", formatError(failure), `bootstrap failed${ARROW}${HINT} logs`);
  setInvocation(GLOBAL);
  check("the advice line follows the bare program", formatError(failure), `bootstrap failed${ARROW}clawwright logs`);
  setInvocation(FLAG_DEMO);
  check("the advice line names the deployment", formatError(failure), `bootstrap failed${ARROW}${DEMO_LOGS}`);
  setInvocation(MONO);
  const manualStep = manual("see the guide");
  const manualFailure = new UserError("bad", { advice: [manualStep] });
  check("a manual step is retained as structured advice", manualFailure.advice.map((step) => step.kind), ["manual"]);
  check("the error retains its manual advice payload", manualFailure.advice[0] === manualStep, true);

  // Masking is a safety property: neither the headline nor advice may leak a secret.
  const SECRET = "token-value-1234567890";
  registerSecret(SECRET);
  const secretFailure = new UserError(`gateway rejected ${SECRET}`, { advice: [manual(`put ${SECRET} in .env`)] });
  check("the error keeps one manual recovery step", secretFailure.advice.map((step) => step.kind), ["manual"]);
  check("rendered errors never expose a registered secret", formatError(secretFailure).includes(SECRET), false);
  const reported = await capture(() => reportError(new UserError("nope", { advice: [command("up")] })));
  const plainText = reported.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
  check("reportError prints the error and its advice line", plainText, `error: nope${ARROW}${HINT} up\n`);

  // 10. The renderer's fixed point is now the whole output layer: every line above prints
  //     exactly as renderAdvice() built it, so there is no rewriting left to describe.
  setInvocation(MONO);

  // --- every producer of a CLAWWRIGHT_INVOCATION value hands over one the strict reader accepts ---
  const shimLine = /export CLAWWRIGHT_INVOCATION='([^']+)'/.exec(SHIM)?.[1] ?? "";
  check("the committed shim hands over an invocation the strict reader accepts", parseInvocation(shimLine),
    { program: "./clawwright", mode: "checkout", audience: "terminal" });

  const launcherSource = /CLAWWRIGHT_INVOCATION = JSON\.stringify\((.*)\);/.exec(mcpLauncherContent("monorepo"))?.[1] ?? "";
  const launcherValue = new Function("basename", `return (${launcherSource.replaceAll("basename(root)", '"demo"')})`)((p: string) => p) as Invocation;
  check("the monorepo MCP launcher hands over an invocation the strict reader accepts",
    parseInvocation(JSON.stringify(launcherValue)),
    { program: "../../clawwright", mode: "checkout", app: { name: "demo", selectedBy: "flag" }, audience: "mcp" });
  check("the installed launcher hands no invocation over — the system-wide command it spawns names itself",
    mcpLauncherContent("installed").includes("CLAWWRIGHT_INVOCATION"), false);

  // The entry default is a producer too: bin.ts re-serialises whatever defaultInvocation()
  // answers into CLAWWRIGHT_INVOCATION for the delegate (entry/delegate.ts), so the real
  // function's checkout answers must survive the strict reader for the roots it is called
  // with (the checkout root, and an apps/<name> deployment).
  for (const [label, root] of [["checkout root", process.cwd()], ["apps/<name>", probeAppRoot]] as const) {
    const value = { ...(await defaultInvocation(root)), audience: "terminal" as const };
    check(`defaultInvocation (${label}) hands over an invocation the strict reader accepts`,
      parseInvocation(serializeInvocation(value)), value);
  }
  // A run that refused inside a DIFFERENT checkout-shaped tree (outside the running root: spelled absolutely, design 2.2) names that walked-to
  // checkout's gate (bin.ts passes the decision's checkout), not the running copy's.
  {
    const other = resolve(apps.root, "another-checkout");
    const value = { ...(await defaultInvocation(resolve(apps.root, "invocation-hints-probe"), undefined, other)), audience: "terminal" as const };
    check("defaultInvocation names a decided checkout that differs from the running copy's",
      value, { program: `${other.replaceAll("\\", "/")}/clawwright`, mode: "checkout", audience: "terminal" });
  }

  // The entry re-serialises whatever invocation() holds (bin, the delegate), so every default
  // must survive a serialize/parse cycle unchanged.
  const roundTrips: Invocation[] = [
    { program: "clawwright", mode: "installed", audience: "terminal" },
    { program: SHIM_PROGRAM, mode: "checkout", audience: "terminal" },
    { program: WINDOWS_BIN_PROGRAM, mode: "local-package", audience: "terminal" },
    { program: SHIM_PROGRAM, mode: "local-package", audience: "terminal" },
    { program: "clawwright", mode: "installed", app: { name: "demo", selectedBy: "flag" }, audience: "mcp" },
  ];
  for (const [index, value] of roundTrips.entries()) {
    check(`re-serialisation round-trip ${index + 1} of ${roundTrips.length}`, parseInvocation(serializeInvocation(value)), value);
  }
} finally {
  setInvocation(MONO);
  await teardownFixtureDeployment(deployment);
  await apps.dispose();
}

finish("invocation hints");
