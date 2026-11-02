// Creating a new deployment under apps/ (or the check-only override — appsRootFor).
// Listing existing ones is list.ts, which shares
// this file's appsDir.
//
// A deployment is a directory of configuration, not a codebase: .env, desired state,
// secret stores, recipes, and an app.ts saying which service it manages. The framework
// supplies the logic. Usable measure: the generated deployment must run immediately after
// its .env is filled in.
//
// npm distribution: `declarationFor()` below hardcodes `"../../tools/framework/..."`
// relative imports, correct only when app.ts sits two levels under monorepoRoot next to
// tools/ — monorepo-only, should stay that way. The installed-as-dependency init command
// has its own template (init.ts), importing the package specifier instead.

import { mkdir, writeFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { log, info, die } from "../../core/io/log.ts";
import { command } from "../../core/io/invocation/advice.ts";
import { commandLine, renderAdvice } from "../../core/io/invocation/render.ts";
import { targetFrame } from "../../core/io/invocation/frame.ts";
import { appsRootFor, monorepoRoot, parseEnv, deploymentEnvText, type DeploymentEnv } from "../../core/env.ts";
import { newName, type DeploymentName } from "../../core/values/names.ts";
import { setupProjectMcp } from "../mcp/project.ts";
import { createPrivateFile, wslBoundaryNote } from "../../security/privacy/private-file.ts";
import { deploymentEnv as templateEnv, gitignoreLines, nextStepsLines, updateGitignore } from "./deployment-template.ts";

export const appsDir = resolve(monorepoRoot, "apps");

// The target frame of the committed shim stored text names (S1.5): the app.ts run-it
// line spells the shim itself, never the directory the operator ran new-app from.
const storedTarget = targetFrame({ kind: "checkout-shim", root: "" }, "posix");

// Under the check-only apps root there is no checkout two levels up — the
// declaration imports this checkout's framework by absolute file URL instead.
function declarationSpecifier(module: string): string {
  const override = process.env["CLAWWRIGHT_CHECKS_APPS_DIR"];
  if (override !== undefined && override !== "")
    return JSON.stringify(pathToFileURL(resolve(monorepoRoot, "packages", "clawwright", module)).href);
  return JSON.stringify(`../../packages/clawwright/${module}`);
}

export function declarationFor(name: string): string {
  const seam = process.env["CLAWWRIGHT_CHECKS_APPS_DIR"] !== undefined &&
    process.env["CLAWWRIGHT_CHECKS_APPS_DIR"] !== "";
  return `// The ${name} deployment.
//
// Says which service this deployment manages and which framework commands it exposes.
// Its configuration lives next to this file: .env, config/, secrets/, recipes/.
//
// Run it with:  ${renderAdvice(command(["status"], { app: name }), storedTarget)}
${seam ? `// Check-only root: this textual specifier marks the deployment as
// checkout-sourced for importsCheckoutSourcesIn: import { defineApp } from "../../packages/clawwright/core/app.ts";
` : ""}
import { defineApp } from ${declarationSpecifier("core/app.ts")};
import { mountPoints } from ${declarationSpecifier("runtime/mounts.ts")};
import { openclawCommands } from ${declarationSpecifier("commands/interface/index.ts")};

export default defineApp({
  name: "${name}",
  description: "deployment of a self-hosted OpenClaw instance",

  service: { name: "gateway", logTail: "100" },
  mounts: mountPoints,

  // Every framework command, under this deployment. Add your own entries here if this
  // deployment needs something the framework does not provide.
  commands: openclawCommands,
});
`;
}

const DESIRED_STATE = `[
  { "path": "gateway.mode", "value": "local" },
  { "path": "gateway.bind", "value": "lan" }
]
`;

/** The template's own settings, adjusted so a new deployment doesn't collide with existing
 *  ones under apps/. Exported because bootstrap creates the file too, when a deployment
 *  directory exists without one — both paths must produce the same isolated settings. */
export async function deploymentEnv(name: string, portStart?: number): Promise<DeploymentEnv> {
  return deploymentEnvText(await templateEnv(name, appsRootFor(monorepoRoot), portStart));
}

/** Appended, not overwritten — shares its lines with init.ts's updateGitignore, minus the
 *  node_modules/ line an installed deployment needs and this doesn't. This repository's
 *  own .gitignore already excludes apps/ entirely, so this file only matters once the
 *  deployment directory becomes a git repo of its own (see the next: note below). */
async function writeGitignore(directory: string): Promise<void> {
  await updateGitignore(directory, gitignoreLines(false));
}

/** Printed as part of createApp's next-steps, and its own constant so lock.ts's
 *  COMMIT_ADVICE can be checked for consistency. Deliberately not run automatically (`git
 *  init` is the operator's call), but named so "commit it" (lock.ts) has somewhere to point. */
export const GIT_INIT_STEP = "git init";

export function gitInitAdvice(name: string): string {
  // One frame for the whole sentence — the checkout root, where the cd lands and the gate
  // resolves: the lock names the new deployment and spells this copy's program from there.
  // No frame argument: the renderer reads the installed frame (core/io/invocation is
  // exempt); the at mark re-roots the row (S1.3).
  const lock = renderAdvice(command(["lock"], { app: name, at: "checkout-root" }));
  return (
    `apps/ is entirely in this repository's own .gitignore, so apps/${name} has no git history ` +
    `of its own — make it one if you want "${lock}" committed: cd apps/${name} && ${GIT_INIT_STEP} ` +
    "(the .gitignore just written here already keeps .env and secrets/ out of it)"
  );
}

export async function createApp(name: DeploymentName): Promise<void> {
  newName("deployment", name);

  const directory = resolve(appsRootFor(monorepoRoot), name);

  // Existence is checked before anything is written: overwriting would destroy a filled-in
  // .env, and its keys with it.
  // An existing empty directory is fine: `init` inside a checkout refuses and leaves one behind.
  const existing = await readdir(directory).then(
    (items) => items.length,
    (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? 0 : 1),
  );
  if (existing > 0) die(`${directory} already exists`);

  await mkdir(resolve(directory, "config"), { recursive: true });
  await mkdir(resolve(directory, "secrets"), { recursive: true });
  await mkdir(resolve(directory, "recipes"), { recursive: true });

  await writeFile(resolve(directory, "app.ts"), declarationFor(name), "utf8");
  await writeFile(resolve(directory, "config", "desired-state.json"), DESIRED_STATE, "utf8");
  const env = await deploymentEnv(name);
  const envFile = resolve(directory, ".env");
  // boundary: false — the WSL-boundary note (if any) is printed after "next:" below, not
  // before it; see wslBoundaryNote's own call at the end of this function.
  await createPrivateFile(envFile, env, { boundary: false });
  await writeGitignore(directory);
  await setupProjectMcp(directory, "monorepo");

  log(`created ${directory}`);
  info("next:");
  for (const line of nextStepsLines(envFile, parseEnv(env, envFile).OC_DATA_DIR ?? "", commandLine(["bootstrap"], { app: name }))) info(line);
  info(
    `if ${name} is the only deployment under apps/, later commands pick it automatically; ` +
      `alongside others, select it with --app ${name} or export OC_APP=${name}`,
  );
  info("open the deployment directory in Claude Code or Codex; project MCP settings are already prepared");
  info("secrets stay inside this directory (snapshots go to the snapshot directory, OC_SNAPSHOT_DIR), so deployments never share them");
  info(gitInitAdvice(name));

  const boundaryNote = await wslBoundaryNote(envFile);
  if (boundaryNote !== undefined) info(boundaryNote);
}
