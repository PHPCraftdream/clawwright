// The gate before either delivery: every tree about to travel is walked by the same
// portable-content policy the other carriers of recipe bytes use, so a name gets one
// answer from all four. A file that policy holds private refuses the whole deploy rather
// than being excluded and left for rsync globs to guess at.

import { lstat, realpath } from "node:fs/promises";
import { die } from "#src/core/io/log.ts";
import { deploymentDir, recipesDir } from "#src/runtime/deployment.ts";
import { collectPortableRecipeFiles, SENSITIVE_RECIPE_NAME } from "#src/security/privacy/recipe-portable-content.ts";
import { collectSensitiveCheckoutNames } from "#src/security/privacy/deploy-boundary.ts";
import { listRecipeDirectories } from "#src/service/recipe.ts";
import { isAbsolute, relative, resolve, sep } from "node:path";

const ROOT_STORE_NAME = /^[^./\\][^/\\]*\.env$/i;
const PRIVATE_ROOTS = new Set(["secrets", "data", "backups", "snapshots", ".env"]);

/** Checks the actual rsync source, including a recipe-root symlink. */
async function assertRecipeSourceRoot(): Promise<void> {
  const source = recipesDir();
  try {
    await lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const actual = await realpath(source);
  const deployment = await realpath(deploymentDir());
  const fromDeployment = relative(deployment, actual);
  if (fromDeployment === "" || fromDeployment === ".." || fromDeployment.startsWith(`..${sep}`) || isAbsolute(fromDeployment)) {
    die("deploy refuses a recipesDir source that is not contained below the deployment");
  }
  if (PRIVATE_ROOTS.has((fromDeployment.split(sep)[0] ?? "").toLowerCase())) {
    die("deploy refuses a recipesDir source that resolves into a private deployment root");
  }
}

/** Every path the portable-content policy holds back across the three trees deploy sends:
 *  the recipes root, the deployment's config/, and the checkout root itself. Reports only
 *  what currently exists — after `recipe import` the declared bytes are absent and deploying
 *  is fine. */
export async function collectRefusals(sourceRoot: string): Promise<string[]> {
  const carrying: string[] = [];

  await assertRecipeSourceRoot();
  const recipesRoot = recipesDir();
  const recipeEntries = (await listRecipeDirectories(recipesRoot))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of recipeEntries) {
    // A sensitive-named top-level entry — file, link or directory — refuses on its own,
    // before the walk below could even be reached.
    const rootReason = SENSITIVE_RECIPE_NAME.test(entry.name)
      ? "sensitive-name policy"
      : ROOT_STORE_NAME.test(entry.name) ? "store-shaped source-root file" : undefined;
    if (rootReason !== undefined) {
      carrying.push(`recipes/${entry.name} (${rootReason})`);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const walked = await collectPortableRecipeFiles(resolve(recipesRoot, entry.name));
    for (const excluded of walked.excluded) {
      carrying.push(`recipes/${entry.name}/${excluded.path} (${excluded.reason})`);
    }
  }

  try {
    // The deployment's config/ is synced wholesale below; a deployment may have no config/
    // at all — only that absence is tolerated, never a read that failed for any other reason.
    const config = await collectPortableRecipeFiles(resolve(deploymentDir(), "config"));
    for (const entry of config.excluded) {
      carrying.push(`config/${entry.path} (${entry.reason})`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // The checkout root is not a recipe and carries no privateFiles declaration, but the
  // generic sensitive-NAME half of the same policy still applies to it.
  for (const entry of await collectSensitiveCheckoutNames(sourceRoot)) {
    carrying.push(`${entry.path} (${entry.reason})`);
  }

  return carrying;
}

/** Dies before any tool check, connection or remote write if anything the policy holds
 *  private is still present in the trees deploy is about to send. */
export async function assertDeployable(sourceRoot: string): Promise<void> {
  const carrying = await collectRefusals(sourceRoot);
  if (carrying.length === 0) return;

  die(
    "deploy refuses to send files the portable-content policy holds private:\n" +
      carrying.map((line) => `  ${line}`).join("\n") + "\n" +
      "Deploy excludes nothing on purpose: rsync globs cannot escape a literal [, so " +
      "excluding these by pattern could leak one or over-exclude an unrelated file — and " +
      "these bytes would land on another host with nothing left to review.\n" +
      "Keep credentials in the deployment's .env or secrets/ (they stay here), or have the " +
      "recipe's prepare hook create them on the target.",
  );
}
