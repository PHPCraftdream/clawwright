#!/usr/bin/env node
// The gate.
//
// Picks a deployment, points the framework at its directory, loads its declaration and
// hands over. No command logic lives here.
//
// A deployment is a directory under apps/ holding .env, config/, secrets/, recipes/ and
// an app.ts naming its service. Several can sit side by side:
//
//   clawwright status                    the default deployment
//   OC_APP=staging clawwright status     another one
//   clawwright --app staging status      same, as an argument
//
// With neither set and no "openclaw" deployment, a checkout with exactly one deployment
// under apps/ uses it automatically.

import { main } from "../packages/clawwright/entry/cli.ts";
import {
  runGateCommand,
  gateHelpLines,
  reportUnknownCommand,
  beforeBareDoubleDash,
  APP_ORDER,
  type GateCommand,
} from "../packages/clawwright/integration/gate.ts";
import { APP_FLAG_SUMMARY, helpEntryLine } from "../packages/clawwright/core/io/help-render.ts";
import type { ArgumentSpec } from "../packages/clawwright/core/command/spec.ts";
import { reportError, info, UserError } from "../packages/clawwright/core/io/log.ts";
import { command } from "../packages/clawwright/core/io/invocation/advice.ts";
import { checkoutGateFrame, frameFromInvocation, launchFromHandover, type Frame } from "../packages/clawwright/core/io/invocation/frame.ts";
import { frameFacts, installFrame, takeInvocationFromEnv } from "../packages/clawwright/core/io/invocation/index.ts";
import { useGateCommands } from "../packages/clawwright/core/io/invocation/render.ts";
import { monorepoRoot, appsRootFor } from "../packages/clawwright/core/env.ts";
import { useDeployment } from "../packages/clawwright/runtime/deployment.ts";
import { openclawCommands } from "../packages/clawwright/commands/interface/index.ts";
import { normalizeVersionAlias } from "../packages/clawwright/integration/version.ts";
import type { AppDefinition } from "../packages/clawwright/core/app.ts";
import { resolveFrameworkFromSources } from "../packages/clawwright/entry/delegate.ts";
import { isVerbatim } from "../packages/clawwright/core/command/parse/index.ts";
import { nodeFs, resolveCheckoutEntry } from "../packages/clawwright/entry/resolve.ts";
import { checkoutGate } from "../packages/clawwright/entry/registry.ts";
import { pathToFileURL } from "node:url";
import { resolve as pathResolve } from "node:path";

// A deployment's app.ts importing @phpcraftdream/clawwright resolves onto this checkout's
// sources — there is no dist build here (recipe hooks map the same table in the hook loader).
resolveFrameworkFromSources();

// A hand-over from the system-wide command or a launcher names itself; otherwise this is
// the checkout's committed gate script — its own frame, built once (frame.ts), installed
// once, and passed down as a value (S1.3); the branches below only complete its app fact.
const handedOver = takeInvocationFromEnv();
const facts = frameFacts();
let frame: Frame = handedOver === undefined
  ? checkoutGateFrame(monorepoRoot, facts)
  : {
      ...frameFromInvocation(handedOver, { ...facts, places: { checkoutRoot: monorepoRoot } }),
      launch: launchFromHandover(handedOver, {
        cwd: facts.cwd,
        fs: { exists: nodeFs.exists, readFile: nodeFs.readFile },
        checkoutRoot: monorepoRoot,
      }),
    };
const argv = normalizeVersionAlias(process.argv.slice(2));

// The gate's own commands, one list from entry/registry.ts — the declared check/new-app/
// remove-app/list plus version and completion, closing completion over the finished array.
const gateCommands: GateCommand[] = checkoutGate();
// Registered before any command runs, so the renderer omits --app from these (they run before a deployment is resolved).
useGateCommands(gateCommands.map((command) => command.name));

// Where am I, which deployment, which framework copy, how do I name myself — one pure
// decision (entry/resolve.ts); the switch below only performs its side effects.
const decision = resolveCheckoutEntry({
  root: monorepoRoot,
  cwd: process.cwd(),
  argv,
  ocApp: process.env.OC_APP,
  handedOver: handedOver !== undefined,
  launch: frame.launch,
  handedProgram: handedOver?.program,
  handedApp: handedOver?.app,
  fs: nodeFs,
  gateCommands: gateCommands.map((command) => command.name),
  deploymentCommands: Object.keys(openclawCommands),
  variadicCommands: Object.entries(openclawCommands)
    .filter(([, command]) => isVerbatim((command.arguments ?? []) as readonly ArgumentSpec[]))
    .map(([commandName]) => commandName),
  deploymentArguments: (name) => (gateCommands.find((command) => command.name === name)?.arguments ?? openclawCommands[name]?.arguments) as readonly ArgumentSpec[],
});
  if ("app" in decision && decision.app !== undefined) {
    frame = { ...frame, app: { state: "selected", name: decision.app.name, by: decision.app.selectedBy } };
  }
installFrame(frame);

// The command list in the gate's `help`: the gate's own commands, plus the one line here that is
// not a command at all.
const monorepoGateHelp = [
  ...gateHelpLines(gateCommands),
  helpEntryLine("--app <name>", APP_FLAG_SUMMARY),
];

switch (decision.kind) {
  case "refuse": {
    for (const refusal of decision.refusals) reportError(refusal);
    process.exit(1);
  }
  case "refuse-misplaced-app-flag": {
    // The advice renders with the program as typed — `clawwright`, not the checkout spelling,
    // which a global (cmd/pwsh) invocation could not run.
    reportError(new UserError(APP_ORDER, { advice: [command(["<command>"], { app: "<name>" })] }));
    process.exit(1);
  }
  case "refuse-unknown-command": {
    reportUnknownCommand(decision.name, [...decision.candidates]);
    process.exit(1);
  }
  case "gate-command": {
    // Same frame rule as the run branch (rf6-fix33): the typed --app rides, so prose hints
    // spell the deployment the same way under `check --help` and `help check`.
    process.exit((await runGateCommand(gateCommands, [decision.name, ...decision.args])) ?? 0);
  }
  case "help-without-deployment": {
    // help/--help/-h must work in a completely fresh checkout, before any deployment
    // exists — and so must `<deployment command> --help`, the second form the general
    // help itself promises. Built from openclawCommands directly (there's no app.ts yet):
    // every deployment's own declaration just re-exports this set unless it adds commands of its own.
    const genericApp: AppDefinition = {
      name: "clawwright",
      description: `self-hosting framework for OpenClaw — ${decision.description}`,
      commands: openclawCommands,
    };
    await main(genericApp, [...decision.argv], monorepoGateHelp, gateCommands);
    // runApp sets process.exitCode on error (e.g. unknown command) — respect it instead of forcing 0.
    process.exit(process.exitCode ?? 0);
  }
  case "run": {
    // --json output must stay parseable, and a non-interactive caller (script, cron) has no one
    // to read this for — only print for a human at a real terminal. A stderr note suppression:
    // over-suppressing the note is harmless.
    if (decision.soleNote !== undefined && !beforeBareDoubleDash(decision.argv).includes("--json") && process.stderr.isTTY === true) {
      info(`using the only deployment: ${decision.soleNote}`);
    }
    // Set before anything reads configuration: every path below resolves against it.
    useDeployment(decision.deploymentDir);

    let app: AppDefinition;
    try {
      const appModule = pathToFileURL(pathResolve(appsRootFor(monorepoRoot), decision.appName, "app.ts")).href;
      const module = (await import(appModule)) as { default: AppDefinition };
      app = module.default;
    } catch (error) {
      reportError(`cannot load deployment "${decision.appName}": ${(error as Error).message}`);
      process.exit(1);
    }

    // The command list in the gate's `help`: the gate's own commands, plus the one line here that is
    // not a command at all.
    const monorepoGateHelp = [
      ...gateHelpLines(gateCommands),
      helpEntryLine("--app <name>", APP_FLAG_SUMMARY),
    ];

    await main(app, [...decision.argv], monorepoGateHelp, gateCommands);
  }
}
