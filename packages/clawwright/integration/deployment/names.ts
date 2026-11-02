// Which apps/ subdirectories are deployments: one rule for the gate, `list`, the sole-deployment
// fallback and completion. A deployment holds app.ts and has a name safeName accepts; hidden
// directories are working state and never count.

import { readdir, access } from "node:fs/promises";
import { resolve } from "node:path";
import { readName, type DeploymentName } from "../../core/values/names.ts";

export interface AppsScan {
  /** Deployments, sorted. */
  readonly names: DeploymentName[];
  /** Visible directories that are not deployments, with the reason. */
  readonly others: { readonly name: string; readonly reason: string }[];
}

export async function scanApps(appsRoot: string): Promise<AppsScan> {
  const entries = await readdir(appsRoot, { withFileTypes: true }).catch(() => []);
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  const names: DeploymentName[] = [];
  const others: { name: string; reason: string }[] = [];
  for (const name of directories) {
    let safe: DeploymentName;
    try {
      safe = readName("deployment", name);
    } catch (error) {
      others.push({ name, reason: `not a deployment: ${(error as Error).message}` });
      continue;
    }
    const hasApp = await access(resolve(appsRoot, name, "app.ts")).then(() => true, () => false);
    if (hasApp) names.push(safe);
    else others.push({ name, reason: "not a deployment: no app.ts" });
  }
  return { names, others };
}

/** Deployment names only, sorted. */
export async function deploymentNames(appsRoot: string): Promise<string[]> {
  return (await scanApps(appsRoot)).names;
}
