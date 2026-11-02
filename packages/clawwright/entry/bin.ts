#!/usr/bin/env node
// The installed-mode gate — the package's own bin entry once tools/framework/ is installed
// as an npm dependency in a consumer repo, as opposed to tools/clawwright.ts (the monorepo
// gate, several deployments side by side under apps/<name>).
//
// Exactly one app here: the consumer's own project root. No --app/OC_APP selection, no
// apps/<name> nesting — those exist in the monorepo gate to share one checkout, not what
// an installed dependency needs.
//
// The shebang is a plain `#!/usr/bin/env node`; loading the consumer's app.ts needs the
// strip-types flag explicit (re-executing this file, see below) rather than in the
// shebang, since busybox `env` has no -S — on Alpine, the common Node base image, the
// npm-linked bin would fail before a single line of this ran.
//
// Where the deployment is, whether init may write here and which framework copy runs are
// one pure decision (entry/resolve.ts); this file only performs its side effects.

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { main } from "./cli.ts";
import { runGateCommand, gateHelpLines, helpWithoutDeployment, type GateCommand } from "../integration/gate.ts";
import { info, reportError } from "../core/io/log.ts";
import { INVOCATION_ENV, serializeInvocation, installFrame, takeInvocationFromEnv } from "../core/io/invocation/index.ts";
import { useGateCommands } from "../core/io/invocation/render.ts";
import { useDeployment } from "../runtime/deployment.ts";
import { openclawCommands } from "../commands/interface/index.ts";
import { renderFullCommandHelp } from "../core/io/help-render.ts";
import { frameFromInvocation, handoverOf, launchFromHandover, type Frame } from "../core/io/invocation/frame.ts";
import { installedGate } from "./registry.ts";
import { delegateToOwnFramework, refuseStrayCheckoutApp, resolveFrameworkFromSelf, takeDelegationFlag } from "./delegate.ts";
import { defaultFrame, warnForEntry } from "./root.ts";
import { findCheckoutRootIn, missingAppDecision, nodeFs, resolveInstalledEntry } from "./resolve.ts";
import type { AppDefinition } from "../core/app.ts";
import { CANNOT_LOAD } from "./resolve.ts";

// First, before anything can spawn: the flag covers this hand-over only, not descendants.
const handedOver = takeDelegationFlag();
// The shim names itself; unnamed, the copy decides (see defaultFrame).
const handed = takeInvocationFromEnv();
const rawArgv = process.argv.slice(2);

// The frame is built once here and passed down as a value (S1.3): a hand-over is classified
// by what its program points at (launchFromHandover's file facts), otherwise the copy
// decides (root.ts's three cases). Nothing below reads the process-global back.
const host = process.platform === "win32" ? "win32" : "posix";
const cwd = process.cwd();
let frame: Frame = handed === undefined
  ? await defaultFrame(cwd, { host, msys: false, cwd, checkout: findCheckoutRootIn(cwd, nodeFs) })
  : {
      ...frameFromInvocation(handed, { host, msys: false, cwd, places: findCheckoutRootIn(cwd, nodeFs) === undefined ? {} : { checkoutRoot: findCheckoutRootIn(cwd, nodeFs) } }),
      launch: launchFromHandover(handed, {
        cwd,
        fs: { exists: nodeFs.exists, readFile: nodeFs.readFile },
        checkoutRoot: findCheckoutRootIn(cwd, nodeFs),
      }),
    };

const entry = resolveInstalledEntry({ cwd, rawArgv, platform: process.platform, fs: nodeFs, frame });
const root = entry.kind === "run" ? entry.appRoot : entry.kind === "refuse" ? (entry.ancestor ?? cwd) : cwd;
if (handed === undefined) {
  const checkout = entry.kind === "run" || entry.kind === "refuse" ? entry.checkout : undefined;
  frame = await defaultFrame(root, { host, msys: false, cwd, checkout });
} else {
  frame = { ...frame, places: { ...frame.places, deploymentRoot: root, ...(entry.kind === "run" || entry.kind === "refuse" ? { checkoutRoot: entry.checkout } : {}) } };
}
installFrame(frame);
switch (entry.kind) {
  case "refuse": {
    for (const refusal of entry.refusals) reportError(refusal, frame);
    process.exit(1);
  }
  case "checkout-types-note": {
    info(entry.line);
    process.exit(0);
  }
}
const { appRoot, localTypesOnly, ancestor, checkout } = entry;
const argv = [...entry.argv];
const launchArgv = [...entry.launchArgv];
// Installed system-wide, this may not be the framework this deployment runs on.
delegateToOwnFramework(fileURLToPath(import.meta.url), appRoot, launchArgv, argv, handedOver, frame);
resolveFrameworkFromSelf();
// The retry already diagnosed this copy before re-executing it.
if (process.env.CLAWWRIGHT_TYPE_STRIPPING_RETRY !== "1") warnForEntry(import.meta.url);

// Creating the deployment happens before one can be loaded — no app.ts yet for a fresh
// consumer repo. `check` is absent: it needs this repository's own test suite, unshipped. One
// list from entry/registry.ts: init (carrying the placement decision this entry made), version
// and completion, closing completion over the finished array.
const gateCommands: GateCommand[] = installedGate(appRoot, { localTypesOnly, ancestor });
// Registered before any command runs, so the renderer omits --app from these (they run before a deployment is resolved).
useGateCommands(gateCommands.map((command) => command.name));

const gateExit = await runGateCommand(gateCommands, argv);
if (gateExit !== undefined) process.exit(gateExit);
// Only after the gate commands: `version` answers without needing the app to be one of apps/<name>.
refuseStrayCheckoutApp(fileURLToPath(import.meta.url), appRoot, frame);

const appFile = resolve(appRoot, "app.ts");
try {
  await access(appFile);
} catch {
  const missing = missingAppDecision({
    appRoot,
    argv,
    checkout,
    gateCommandNames: gateCommands.map((command) => command.name),
    deploymentCommands: Object.keys(openclawCommands),
    frame,
  });
  if (missing.kind === "subfolder-report") {
    reportError(missing.headline, frame);
    reportError(missing.refusal, frame);
    process.exit(1);
  }
  if (missing.kind === "help") {
    // Help for a deployment command answers without a deployment, from the built-in
    // declarations — the same way the checkout root's gate answers (R32-09).
    const helpExit = helpWithoutDeployment(gateCommands, argv, {
      deploymentCommands: Object.keys(openclawCommands),
      checkout,
      deploymentHelp: (name) => {
        const declared = openclawCommands[name];
        if (declared !== undefined) renderFullCommandHelp(name, declared, frame);
      },
    });
    if (helpExit !== undefined) process.exit(helpExit);
  }
  const { headline, refusals } = missing.kind === "help" ? missing.fallback : missing;
  reportError(headline, frame);
  for (const refusal of refusals) reportError(refusal, frame);
  process.exit(1);
}

// Set before anything reads configuration: every path below resolves against it.
useDeployment(appRoot);

/** This file again, with type stripping switched on. app.ts belongs to the consumer, so
 *  loading it needs the flag; it can't ride in the shebang (busybox `env` has no -S), and
 *  guessing from process.version would have to be right about every release — the import
 *  failing with "Unknown file extension" is the capability itself answering. Only that one
 *  flag is passed on: whatever disabled stripping here must not be inherited by the retry. */
function retryWithTypeStripping(): never {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", fileURLToPath(import.meta.url), ...launchArgv],
    { stdio: "inherit", env: { ...process.env, CLAWWRIGHT_TYPE_STRIPPING_RETRY: "1", [INVOCATION_ENV]: serializeInvocation(handoverOf(frame)), ...(handedOver ? { CLAWWRIGHT_DELEGATED: "1" } : {}) } },
  );
  process.exit(result.status ?? 1);
}

let app: AppDefinition;
try {
  const module = (await import(pathToFileURL(appFile).href)) as { default: AppDefinition };
  app = module.default;
} catch (error) {
  const message = (error as Error).message;
  const cannotReadTypeScript = message.includes("Unknown file extension") || message.includes("experimental-strip-types");
  if (cannotReadTypeScript && process.env.CLAWWRIGHT_TYPE_STRIPPING_RETRY !== "1") retryWithTypeStripping();

  reportError(`${CANNOT_LOAD} ${appFile}: ${message}`, frame);
  if (cannotReadTypeScript) {
    reportError("this Node cannot execute TypeScript even with --experimental-strip-types — Node 24 or newer is required", frame);
  }
  process.exit(1);
}

await main(app, argv, gateHelpLines(gateCommands), gateCommands);
