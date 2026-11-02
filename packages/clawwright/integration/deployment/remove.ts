// Removing a deployment directory under apps/ — the inverse of scaffold.ts's createApp().
//
// Repository-side only: apps/<name>/ itself (.env, config/, secrets/, recipes/, app.ts,
// client configs) — never the target (instance/destroy.ts's destroy is bootstrap's inverse; this
// is new-app's). Monorepo mode only, like list/new-app/check: this gate command exists
// only in tools/clawwright.ts, never in entry/bin.ts's installed-mode gate.

import { readdir, rm, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { log, info, warn, die } from "../../core/io/log.ts";
import { safeName, type DeploymentName } from "../../core/values/names.ts";
import { humanSize } from "../../core/io/size.ts";
import { commandLine } from "../../core/io/invocation/render.ts";
import { listDeployments, type ListDeploymentsOptions } from "../list.ts";
import { appsRootFor, monorepoRoot } from "../../core/env.ts";

export interface RemoveAppOptions {
  /** Overridable so a check can point at a scratch apps/ instead of the real one. */
  readonly appsRoot?: string;
  /** Forwarded to listDeployments() — same reason it takes one: a check hands back a
   *  stub Context instead of resolving a real transport and Docker. */
  readonly buildContext?: ListDeploymentsOptions["buildContext"];
  /** Overridable so a check can model a missing or inconclusive inventory row. */
  readonly listDeployments?: typeof listDeployments;
}

async function directorySizeBytes(directory: string): Promise<number> {
  let total = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      total += await directorySizeBytes(full);
      continue;
    }
    try {
      total += (await lstat(full)).size;
    } catch {
      // Removed or unreadable between the listing and the stat — not this run's problem.
    }
  }
  return total;
}

/** Refuses everything that is not a plain, existing, non-symlink apps/<name> directory —
 *  before anything about its contents is read. safeName's own alphabet (no `/`, `.`, `..`)
 *  already makes "outside apps/" unreachable through `name`; the symlink check covers the
 *  directory entry itself being a link planted at that name. */
/** The refusals and reports remove-app prints; the checks assert them by name. */
export const NOTHING_REMOVED = "nothing removed";

export function notPresent(directory: string): string {
  return `${directory} does not exist — nothing to remove`;
}

export function bootstrappedRefusal(name: string, state: string): string {
  return `${name} still has a bootstrapped instance (${state}) — run ${commandLine(["destroy"], { app: name })} first ` +
    "(and --data if the data should go too)";
}

export function instanceStateRefusal(name: string, state: string | undefined): string {
  return `${name} instance state is ${state ?? "unknown"} — refusing to remove local configuration; confirm the target is reachable and run list again`;
}

async function resolveTargetDirectory(name: string, appsRoot: string): Promise<string> {
  safeName("deployment", name);
  const directory = resolve(appsRoot, name);

  let stat;
  try {
    stat = await lstat(directory);
  } catch {
    die(notPresent(directory));
  }
  if (stat.isSymbolicLink()) {
    die(`${directory} is a symlink — refusing to remove it; remove the real directory it points at instead`);
  }
  if (!stat.isDirectory()) die(`${directory} is not a directory — refusing to remove it`);
  return directory;
}

/** The same state the gate's `list` command reports, read through listDeployments() rather than a
 *  second detector — a running/stopped verdict here means exactly what it means there. */
async function currentState(
  name: string,
  appsRoot: string,
  buildContext: RemoveAppOptions["buildContext"],
  list: NonNullable<RemoveAppOptions["listDeployments"]>,
): Promise<string | undefined> {
  const summaries = await list({ appsRoot, checkStatus: true, buildContext });
  return summaries.find((entry) => entry.name === name)?.state;
}

async function hasOwnGitHistory(directory: string): Promise<boolean> {
  try {
    return (await lstat(resolve(directory, ".git"))).isDirectory();
  } catch {
    return false;
  }
}

/** The gate's `remove-app <name>` — deletes apps/<name>/. Default is a dry run: lists what
 *  would go and exits 0. A real run needs the gate's parsed `yes`, and refuses while the
 *  deployment still has a bootstrapped instance (running or stopped-but-bootstrapped) —
 *  destroy that first. The argv re-parse used to live here too; the gate's
 *  parseDeclaredArgs(REMOVE_APP_ARGUMENTS) is the one parse. */
export async function removeApp(name: DeploymentName, yes: boolean, options: RemoveAppOptions = {}): Promise<number> {
  const appsRoot = options.appsRoot ?? appsRootFor(monorepoRoot);

  const directory = await resolveTargetDirectory(name, appsRoot);
  const state = await currentState(name, appsRoot, options.buildContext, options.listDeployments ?? listDeployments);
  if (state === "running" || state === "stopped") {
    die(bootstrappedRefusal(name, state));
  }
  if (state !== "not-bootstrapped") {
    die(instanceStateRefusal(name, state));
  }

  const entries = (await readdir(directory, { withFileTypes: true })).map((entry) => entry.name).sort();
  const sizeBytes = await directorySizeBytes(directory);
  const ownGit = await hasOwnGitHistory(directory);

  if (!yes) {
    log(`would remove ${directory}`);
    for (const entry of entries) info(`  ${entry}`);
    info(`total size: ${humanSize(sizeBytes)}`);
    if (ownGit) {
      warn(`${directory}/.git holds this deployment's own history — that goes too, including anything never committed there`);
    }
    info(`dry run — ${NOTHING_REMOVED}. Pass --yes for a real run`);
    return 0;
  }

  await rm(directory, { recursive: true, force: true });
  log(`removed ${directory}`);
  return 0;
}
