// Which framework runs a deployment when `clawwright` is the system-wide command.
//
// The deployment's own framework wins, so one global install serves every app without
// changing any of them: a local @phpcraftdream/clawwright dependency (the app's version pin),
// or — for apps/<name> and the root of a Clawwright checkout — that checkout's own gate.
// Only an app with neither runs on the global package itself, whose @phpcraftdream/clawwright
// imports then resolve to that package. Two framework copies in one process would split
// module state (the selected deployment, registered secrets), so it is always one or the other.

import { createRequire, registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { INVOCATION_ENV, serializeInvocation } from "../core/io/invocation/index.ts";
import { checkoutFrameworkSource, frameworkRoot, monorepoRoot } from "../core/env.ts";
import { reportError, UserError } from "../core/io/log.ts";
import { command, shellLine, type Advice } from "../core/io/invocation/advice.ts";
import { renderArgument, renderFrameAdvice } from "../core/io/invocation/render.ts";
import { handoverOf, IN_BASH_NOTE, rootedLaunch, shimFrame, type Frame } from "../core/io/invocation/frame.ts";
import { nodeFs, frameworkOwner, strayCheckoutApp } from "./resolve.ts";

const PACKAGE = "@phpcraftdream/clawwright";
const DELEGATED = "CLAWWRIGHT_DELEGATED";

/** Fixed parts of the hand-over refusals, exported for the system-install check. */
export const APP_CONFLICT_NOTE = "conflicts with this directory";
export const APP_CONFLICT_FROM_ROOT = "run this from the checkout root";
export const FOREIGN_SOURCES_NOTE = "imports the framework sources";

/** The local package's entry point, when the app resolves one of its own. */
function localEntry(appRoot: string): string | undefined {
  try {
    const app = createRequire(resolve(appRoot, "package.json")).resolve(`${PACKAGE}/app`);
    return resolve(dirname(app), "..", "entry", "bin.js");
  } catch {
    return undefined;
  }
}

/** Reads and clears the hand-over flag. Called first thing in the receiving bin.ts, so the
 *  flag covers only this one hand-over and never reaches hooks or other clawwright runs it spawns. */
export function takeDelegationFlag(): boolean {
  const handedOver = process.env[DELEGATED] === "1";
  delete process.env[DELEGATED];
  return handedOver;
}

/** `flag`: only a package entry (bin.js) reads it; a checkout gate never would, so it would leak. */
export function spawnDelegated(entry: string, args: string[], flag: boolean, frame: Frame, runner: typeof spawnSync = spawnSync): ReturnType<typeof spawnSync> {
  return runner(process.execPath, ["--experimental-strip-types", entry, ...args], {
    stdio: "inherit",
    env: { ...process.env, [INVOCATION_ENV]: serializeInvocation(handoverOf(frame)), ...(flag ? { [DELEGATED]: "1" } : {}) },
  });
}

function runInstead(entry: string, args: string[], flag: boolean, frame: Frame): never {
  const result = spawnDelegated(entry, args, flag, frame);
  if (result.error !== undefined) {
    process.stderr.write(`clawwright: cannot start ${entry}: ${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

/** The hand-over's --app conflict as data: the sentence names the checkout root, so row 1
 *  spells the gate from there for the copy this run is (the at mark re-roots it), and row
 *  2 is the bash shim's own spelling, dropped when it duplicates row 1 — the same frame
 *  rule as entry/resolve.ts's checkout refusals. */
export function appConflictRefusal(decision: { readonly typed: string; readonly app: string }, frame: Frame): UserError {
  // The frame arrives from the caller (bin.ts's one source): the bash row's drop decision
  // and the typed name's quoting spell it, no process-global read.
  const advice: Advice[] = [command([], { app: decision.typed, at: "checkout-root" })];
  if (rootedLaunch(frame.launch).kind === "system") {
    advice.push(shellLine("posix", renderFrameAdvice(command([], { app: decision.typed }), shimFrame(frame)), { note: IN_BASH_NOTE }));
  }
  return new UserError(
    `--app ${renderArgument(decision.typed, handoverOf(frame).program)} ${APP_CONFLICT_NOTE}, deployment ${decision.app} of the checkout — ${APP_CONFLICT_FROM_ROOT}:`,
    { advice },
  );
}

/** Hands the whole invocation to the deployment's own framework when it has one; returns
 *  only when this package is the one to run. `launchArgv` is passed on untouched to a local
 *  install (same entry point), `argv` (without --project-root) to a checkout gate. Which
 *  copy that is — the decision — is entry/resolve.ts's; here only the effects remain. */
export function delegateToOwnFramework(self: string, appRoot: string, launchArgv: string[], argv: string[], handedOver: boolean, frame: Frame): void {
  const decision = frameworkOwner({ self, appRoot, launchArgv, argv, handedOver, platform: process.platform, fs: nodeFs, localEntry: localEntry(appRoot) });
  if (decision.kind === "run-here") return;
  if (decision.kind === "spawn") {
    runInstead(decision.entry, [...decision.args], decision.delegated, frame);
    return;
  }
  if (decision.reason === "missing-app-value") {
    reportError("--app needs a deployment name", frame);
    process.exit(1);
  }
  if (decision.reason === "invalid-app-value") {
    reportError(decision.message, frame);
    process.exit(1);
  }
  reportError(appConflictRefusal(decision, frame), frame);
  process.exit(1);
}

// No hand-over, yet its app.ts imports a checkout's framework sources: this package would
// load a second copy next to its own. An installed-style app.ts (the package specifier) is fine.
// Called after the gate commands have had their turn, so `version` etc. still answer here.
export function refuseStrayCheckoutApp(self: string, appRoot: string, frame: Frame): void {
  const stray = strayCheckoutApp({ self, appRoot, fs: nodeFs });
  if (stray === undefined) return;
  reportError(`${appRoot} ${FOREIGN_SOURCES_NOTE} of the Clawwright checkout ${stray.checkout} but is not one of its apps/<name> deployments — move it into apps/<name> (new-app), or switch its imports to @phpcraftdream/clawwright`, frame);
  process.exit(1);
}

/** Lets the deployment's app.ts import @phpcraftdream/clawwright from this very package when it
 *  has no install of its own (the system-wide case): resolved as a self-reference. */
export function resolveFrameworkFromSelf(): void {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== PACKAGE && !specifier.startsWith(`${PACKAGE}/`)) return nextResolve(specifier, context);
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
        return nextResolve(specifier, { ...context, parentURL: import.meta.url });
      }
    },
  });
}

/** The checkout gate: the package has no dist build here, so a deployment's app.ts importing
 *  `@phpcraftdream/clawwright/<export>` resolves onto the sibling sources (the recipe hook loader
 *  maps the same table for hook imports on its own loader thread). */
export function resolveFrameworkFromSources(): void {
  const legacyPublicModules = new Map([
    ["../../tools/framework/core/app.ts", "@phpcraftdream/clawwright/app"],
    ["../../tools/framework/runtime/mounts.ts", "@phpcraftdream/clawwright/mounts"],
    ["../../tools/framework/commands/interface/index.ts", "@phpcraftdream/clawwright/commands"],
  ]);
  const sourceCheckout =
    resolve(frameworkRoot, "..") === resolve(monorepoRoot, "packages") &&
    resolve(frameworkRoot, "..", "clawwright") === frameworkRoot &&
    nodeFs.exists(resolve(monorepoRoot, "tools", "clawwright.ts"));

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const legacySpecifier = legacyPublicModules.get(specifier);
      if (sourceCheckout && legacySpecifier !== undefined) {
        const parentUrl = context.parentURL;
        if (parentUrl !== undefined && !parentUrl.includes("?") && !parentUrl.includes("#")) {
          let appPath: string;
          try {
            appPath = fileURLToPath(parentUrl);
          } catch {
            appPath = "";
          }
          const appsDir = resolve(monorepoRoot, "apps");
          const relativeApp = relative(appsDir, appPath);
          const parts = relativeApp.split(sep);
          if (parts.length === 2 && parts[0] !== ".." && !isAbsolute(relativeApp) && parts[1] === "app.ts" && !parts[0]!.includes("/") && !parts[0]!.includes("\\") && pathToFileURL(resolve(appsDir, parts[0]!, "app.ts")).href === parentUrl) {
            const source = checkoutFrameworkSource(legacySpecifier);
            if (source !== undefined) return { url: pathToFileURL(source).href, shortCircuit: true };
          }
        }
      }
      if (specifier !== PACKAGE && !specifier.startsWith(`${PACKAGE}/`)) return nextResolve(specifier, context);
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
        const source = checkoutFrameworkSource(specifier);
        if (source === undefined) throw error;
        return { url: pathToFileURL(source).href, shortCircuit: true };
      }
    },
  });
}
