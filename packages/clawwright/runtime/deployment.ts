// Where a deployment keeps its own files.
//
// An application is a deployment: its .env, desired state, secret stores, recipes and
// snapshots live in one directory, and several deployments can sit side by side sharing this
// framework. Nothing here may be resolved against the repository root, or two deployments
// would silently share one configuration. The gate sets the directory before any command runs.
//
// DESIGN NOTE — npm distribution (see env.ts for the matching note). A directory is handed
// in once by whatever the entry point is, and everything else derives from it, never from
// the framework's own location: monorepo mode resolves `apps/<name>` and calls
// `useDeployment()`; installed-as-dependency mode has exactly one app at its own project
// root. This file does not need to know which mode produced the directory.

import { basename, resolve } from "node:path";
import { readName, type StoreName } from "../core/values/names.ts";
import { setSourceDir } from "../set/artifacts/source.ts";

let activeDir: string | undefined;
let composeOverride: string | undefined;
let applicationRecipes: { deployment: string; directory: string; setting: string } | undefined;

export function useDeployment(directory: string): void {
  activeDir = directory;
}

/** The active deployment directory, or undefined before one is selected — unlike
 *  deploymentDir() this never throws. Used by a caller stepping through several deployments
 *  (list), and by a path getter's caller that tests this instead of catching a throw. */
export function selectedDeployment(): string | undefined {
  return activeDir;
}

/** Clears the selection — the state before any entry point called useDeployment(). */
export function clearDeployment(): void {
  activeDir = undefined;
}

/** Selects an application's recipe root for the active deployment. */
export function useApplicationRecipesDir(directory: string | undefined): void {
  if (directory === undefined) {
    applicationRecipes = undefined;
    return;
  }
  const deployment = deploymentDir();
  applicationRecipes = { deployment, directory: resolve(deployment, directory), setting: directory };
}

/** The application's declared recipe root, retained for deployment mapping. */
export function applicationRecipesSetting(): string | undefined {
  const configured = applicationRecipes;
  if (configured === undefined || configured.deployment !== activeDir) return undefined;
  return configured.setting;
}

/** The deployment's own identity — the directory it lives in, always. Everything that
 *  crosses a process boundary or becomes an argument to another invocation of this tooling
 *  uses this, and only this. Never affected by OC_COMPOSE_PROJECT: that override exists for
 *  the one thing Docker itself names, not for this deployment's own identity. */
export function deploymentName(): string {
  return basename(deploymentDir());
}

// Docker Compose's own project-name rule, checked here so a typo in OC_COMPOSE_PROJECT fails
// with a clear message instead of deep inside a compose invocation.
const COMPOSE_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Overrides what composeProjectName() returns, independent of deploymentName() — set via
 *  OC_COMPOSE_PROJECT in .env, read once when the context is built. */
export function useComposeProjectOverride(name: string | undefined): void {
  if (name !== undefined && !COMPOSE_PROJECT_PATTERN.test(name)) {
    throw new Error(
      `invalid OC_COMPOSE_PROJECT "${name}" — Docker Compose project names are lowercase letters, digits, hyphens and underscores, starting with a letter or digit`,
    );
  }
  composeOverride = name;
}

/** The raw override, or undefined when none is set — for a caller that saves and restores it
 *  around a nested Context. */
export function composeProjectOverride(): string | undefined {
  return composeOverride;
}

/** What Docker actually calls this deployment's containers, networks and volumes — the
 *  directory's own name unless OC_COMPOSE_PROJECT overrides it. Recipe projects derive
 *  from this namespace too; non-Docker deployment identities use deploymentName(). */
export function composeProjectName(): string {
  return composeOverride ?? deploymentName();
}

/** The active deployment directory. Throws rather than guessing: a wrong default here
 *  would read another deployment's credentials. */
export function deploymentDir(): string {
  if (activeDir === undefined) {
    throw new Error("no deployment selected — the entry point must call useDeployment()");
  }
  return activeDir;
}

/** Environment file, also what the container runtime reads for interpolation. */
export function envFile(): string {
  return resolve(deploymentDir(), ".env");
}

/** Declarative settings applied to the managed service. Set-owned: installing from an
 *  artifact reads this out of the artifact while everything else (.env, secret stores, the
 *  lock) keeps coming from the deployment directory. */
export function desiredStateFile(): string {
  return resolve(setSourceDir() ?? deploymentDir(), "config", "desired-state.json");
}

export function filesFile(): string {
  return resolve(setSourceDir() ?? deploymentDir(), "config", "files.json");
}

/** Template listing the variables this deployment needs, without values. */
export function secretsTemplateFile(): string {
  return resolve(deploymentDir(), "config", "secrets.template.env");
}

/** Filled-in values for a named target, kept out of git. The name is checked because it
 *  comes from the command line: a store called ../../other/local would read another
 *  deployment's credentials. */
export function secretStoreFile(name: StoreName): string {
  return resolve(deploymentDir(), "secrets", `${readName("store", name)}.env`);
}

/** Where the deployment's secret stores live. */
export function secretsDir(): string {
  return resolve(deploymentDir(), "secrets");
}

/** Recipes belonging to this deployment — set-owned, so it follows the set source for the
 *  same reason desiredStateFile does. */
export function recipesDir(): string {
  const source = setSourceDir();
  if (source !== undefined) return resolve(source, "recipes");
  const deployment = deploymentDir();
  return applicationRecipes?.deployment === deployment
    ? applicationRecipes.directory
    : resolve(deployment, "recipes");
}
