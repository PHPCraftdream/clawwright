// Listing every deployment under apps/ — the gate's `list` command. Shares deployment/scaffold.ts's appsDir;
// creating a deployment is that file's job, reading what several of them add up to is this
// one's.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { log, info, maskSecrets } from "../core/io/log.ts";
import { commandLine } from "../core/io/invocation/render.ts";
import { appsRootFor, monorepoRoot, EnvSyntaxError, parseEnv, toSettings, type Settings } from "../core/env.ts";
import { createContext, type Context } from "../core/context.ts";
import { useDeployment, selectedDeployment } from "../runtime/deployment.ts";
import { NotBootstrapped } from "../runtime/runtime.ts";
import { hasDigest } from "../runtime/docker/image-ref.ts";
import type { AppDefinition } from "../core/app.ts";
import { scanApps } from "./deployment/names.ts";

/** "running"/"stopped" answer isRunning(); "not-bootstrapped" is NotBootstrapped (the data
 *  directory was never created); "unchecked" means --no-status skipped the target entirely;
 *  "error" covers everything else that stopped one deployment's row short of a verdict — a
 *  missing .env, a broken app.ts, an unreachable target — with `reason` naming which. */
export interface DeploymentSummary {
  readonly name: string;
  readonly target?: string;
  readonly port?: string;
  readonly image?: string;
  readonly pinned?: boolean;
  readonly state: "running" | "stopped" | "not-bootstrapped" | "unchecked" | "error";
  readonly reason?: string;
  /** Set when the row's `.env` has a line without `=`: the parse refusal's code and line. */
  readonly envError?: { readonly code: string; readonly line: number };
}

export interface ListDeploymentsOptions {
  /** Configuration only, no isRunning() call — for a fast read of many deployments. */
  checkStatus?: boolean;
  /** Where deployments live. Overridable so a check can point at a scratch directory instead
   *  of the apps/ this repository shares with every real deployment. */
  appsRoot?: string;
  /** Builds the Context isRunning() is asked of. Overridable so a check can hand back a
   *  stub instead of a real transport and Docker; production always loads the deployment's
   *  own app.ts, the same as every other command run against it. */
  buildContext?: (app: AppDefinition, directory: string) => Promise<Context>;
  /** Also return one error row per visible directory that is not a deployment. */
  includeOthers?: boolean;
}

async function defaultBuildContext(app: AppDefinition, directory: string): Promise<Context> {
  useDeployment(directory);
  return createContext({
    mounts: app.mounts,
    service: app.service,
    settings: app.settings,
    secrets: app.secrets,
    afterBackup: app.afterBackup,
    beforeRestore: app.beforeRestore,
  });
}

/** The four configuration fields plus pinning, read straight from .env — never through
 *  app.ts (may not load): always literal environment values, not something an app computes. */
function configSummary(name: string, settings: Settings): Omit<DeploymentSummary, "state"> {
  const target = settings.location === "ssh" && settings.sshHost !== ""
    ? `ssh:${settings.sshHost}`
    : settings.location;
  // "auto" is unresolved until a Context picks a transport (checkStatus does, below) — flag
  // it so --no-status doesn't read as if the target were literally named "auto".
  return {
    name,
    target: target === "auto" ? "auto (not resolved)" : target,
    port: settings.gatewayPort,
    image: settings.image,
    pinned: hasDigest(settings.image),
  };
}

async function summarizeDeployment(
  name: string,
  directory: string,
  checkStatus: boolean,
  buildContext: (app: AppDefinition, directory: string) => Promise<Context>,
): Promise<DeploymentSummary> {
  let env: Record<string, string>;
  try {
    env = parseEnv(await readFile(resolve(directory, ".env"), "utf8"), resolve(directory, ".env"));
  } catch (error) {
    if (error instanceof EnvSyntaxError) {
      return { name, state: "error", reason: maskSecrets(error.message), envError: { code: error.code, line: error.line } };
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { name, state: "error", reason: maskSecrets((error as Error).message) };
    }
    return { name, state: "error", reason: `no .env — run ${commandLine(["bootstrap"], { app: name })}` };
  }

  let settings: Settings;
  try {
    settings = toSettings(env);
  } catch (error) {
    return { name, state: "error", reason: maskSecrets((error as Error).message) };
  }
  const config = configSummary(name, settings);

  if (!checkStatus) return { ...config, state: "unchecked" };

  let app: AppDefinition;
  try {
    const module = (await import(pathToFileURL(resolve(directory, "app.ts")).href)) as { default: AppDefinition };
    app = module.default;
  } catch (error) {
    return { ...config, state: "error", reason: `cannot load app.ts: ${maskSecrets((error as Error).message)}` };
  }

  try {
    const context = await buildContext(app, directory);
    // The context resolved "auto" to a real transport — show that instead of the raw setting.
    const resolved = { ...config, target: context.transport.description };
    try {
      const running = await context.runtime.isRunning();
      return { ...resolved, state: running ? "running" : "stopped" };
    } catch (error) {
      if (error instanceof NotBootstrapped) return { ...resolved, state: "not-bootstrapped" };
      return { ...resolved, state: "error", reason: maskSecrets((error as Error).message) };
    }
  } catch (error) {
    return { ...config, state: "error", reason: maskSecrets((error as Error).message) };
  }
}

/** One row per apps/<name>, read-only throughout. Visited one at a time, not concurrently:
 *  buildContext's useDeployment() is a single global the runtime reads at call time, so two
 *  deployments in flight would have the second one's isRunning() silently answer for
 *  whichever directory was active. Restored to whatever it was before this ran (an active
 *  MCP session must not find itself pointed at apps/'s last entry once `list` returns). */
export async function listDeployments(options: ListDeploymentsOptions = {}): Promise<DeploymentSummary[]> {
  const root = options.appsRoot ?? appsRootFor(monorepoRoot);
  const checkStatus = options.checkStatus ?? true;
  const buildContext = options.buildContext ?? defaultBuildContext;

  const { names, others } = await scanApps(root);

  const restore = selectedDeployment();
  try {
    const summaries: DeploymentSummary[] = [];
    for (const name of names) {
      summaries.push(await summarizeDeployment(name, resolve(root, name), checkStatus, buildContext));
    }
    if (options.includeOthers === true) {
      for (const other of others) summaries.push({ name: other.name, state: "error", reason: other.reason });
      summaries.sort((a, b) => (a.name < b.name ? -1 : 1));
    }
    return summaries;
  } finally {
    if (restore !== undefined) useDeployment(restore);
  }
}

function displayState(state: DeploymentSummary["state"]): string {
  if (state === "not-bootstrapped") return "not bootstrapped";
  if (state === "unchecked") return "not checked";
  return state;
}

/** The `list` command's console rendering — kept beside listDeployments() rather than in the gate
 *  script, the same split createApp's own log/info calls already draw. */
export function printDeploymentList(summaries: DeploymentSummary[]): void {
  if (summaries.length === 0) {
    info(`no deployments under apps/ — create one with ${commandLine(["new-app", "<name>"])}`);
    return;
  }
  for (const entry of summaries) {
    log(`${entry.name} — ${displayState(entry.state)}`);
    if (entry.target !== undefined) {
      info(`target: ${entry.target}   port: ${entry.port}   image: ${entry.image}${entry.pinned === true ? " (pinned)" : ""}`);
    }
    if (entry.reason !== undefined) info(entry.reason);
  }
}
