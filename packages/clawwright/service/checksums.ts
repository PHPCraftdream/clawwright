// Content identity for the things a deployment is made of.
//
// Its own module because two commands need the same answer and must not each have their
// own: inspect compares a recipe against what is on the target, and lock records what the
// recipe was when the instance was pinned. If those two computed "the same recipe"
// differently, the lock would disagree with the inspection about a deployment neither had
// touched, and there would be no way to tell which one was wrong.

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { collectPortableAgentBundleFiles, collectPortableRecipeFiles } from "../security/privacy/recipe-portable-content.ts";

export function checksumOf(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** A checksum per file of a recipe's runtime content, keyed the same way provision-agent
 *  mirrors them, so a checksum map compares directly with what the target reports.
 *  `agent/` is excluded, exactly as the mirror excludes it (prompts aren't served
 *  content) — see agentBundleChecksums for why that exclusion must not extend past this
 *  function. Walked through the shared portable-content policy, so policy-excluded files
 *  (declared privateFiles, sensitive names) are left out too: every consumer (set build's
 *  manifest, inspect, the lock) shares one portable-content notion. */
export async function recipeFileChecksums(recipeDir: string): Promise<Record<string, string>> {
  const { files } = await collectPortableRecipeFiles(recipeDir, { excludeTop: "agent" });
  const checksums: Record<string, string> = {};
  for (const rel of files.sort()) {
    checksums[rel] = checksumOf(await readFile(resolve(recipeDir, ...rel.split("/"))));
  }
  return checksums;
}

/** The same, for the agent bundle: everything under `agent/`. Excluding it from the mirror
 *  is right (prompts aren't served content), but letting that exclusion be the ONLY
 *  checksum was wrong and silent: the lock, plan's declaration checksum and inspection all
 *  read one number, so editing AGENTS.md/SOUL.md/cron-message.txt reported nothing changed
 *  — plan scheduled no work, apply left old prompts in place. Two numbers instead, since
 *  they answer different questions (has served content changed, has the agent's own
 *  definition changed — both mean re-provisioning, only the first means the mirror is
 *  stale). Walked through collectPortableAgentBundleFiles, the same walk
 *  loadRecipeAgentBundle uses, so a private/sensitive file is held out for one reason, not two. */
export async function agentBundleChecksums(recipeDir: string): Promise<Record<string, string>> {
  const agentDir = resolve(recipeDir, "agent");
  const walked = await collectPortableAgentBundleFiles(recipeDir);
  // A recipe can be a plain service with no agent at all — collectPortableAgentBundleFiles
  // answers undefined rather than throwing; any other failure still throws.
  if (walked === undefined) return {};

  const checksums: Record<string, string> = {};
  for (const rel of walked.files.sort()) {
    checksums[rel] = checksumOf(await readFile(resolve(agentDir, ...rel.split("/"))));
  }
  return checksums;
}

/** One checksum standing for a whole file map, comparable with a single equality rather
 *  than by walking both. Order-independent: serialised from sorted keys. */
export function checksumOfFileMap(files: Record<string, string>): string {
  const canonical = Object.keys(files)
    .sort()
    .map((rel) => `${rel}:${files[rel]}`)
    .join("\n");
  return checksumOf(canonical);
}
