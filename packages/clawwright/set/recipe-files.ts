// The recipe files a set declares in JSON (agent/config.json, acceptance.json), parsed once.
// Tree and artifact read the same bytes through the same step, so a malformed file is the same
// answer on both paths — a refusal naming the file and the recipe from `set build`, a
// SET_RECIPE_INVALID finding from the validator — and never an integrity claim about the archive.

import { readFile } from "node:fs/promises";
import { parseAgentConfig } from "#src/commands/management/provision-agent/declaration.ts";
import type { AgentConfig } from "#src/commands/management/provision-agent/declaration.ts";
import type { AcceptanceCheck } from "#src/commands/orchestration/accept.ts";

/** Parsed content, or why the file is not what it must be — worded for the user. */
export type RecipeFile<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

/** The portable name a recipe file is reported under, the same on the tree and the artifact. */
export const agentConfigLabel = (recipe: string): string => `recipes/${recipe}/agent/config.json`;
export const acceptanceLabel = (recipe: string): string => `recipes/${recipe}/acceptance.json`;

async function readOrAbsent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

function parseJson(text: string, label: string, recipe: string): RecipeFile<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, reason: `recipe "${recipe}": ${label} is not valid JSON: ${(error as Error).message}` };
  }
}

/** The recipe's agent declaration parsed from bytes a caller already read. */
export function parseAgentDeclaration(text: string, recipe: string): RecipeFile<AgentConfig> {
  const label = agentConfigLabel(recipe);
  const json = parseJson(text, label, recipe);
  if (!json.ok) return json;
  try {
    return { ok: true, value: parseAgentConfig(json.value) };
  } catch (error) {
    return { ok: false, reason: `recipe "${recipe}": ${label} is not a valid agent declaration: ${(error as Error).message}` };
  }
}

/** The recipe's acceptance checks parsed from bytes a caller already read, with accept's own
 *  grammar. Lazy import: accept.ts sits downstream of install.ts and load.ts must never reach
 *  install.ts, not even transitively. */
export async function parseAcceptanceChecks(text: string, recipe: string): Promise<RecipeFile<AcceptanceCheck[]>> {
  const label = acceptanceLabel(recipe);
  const json = parseJson(text, label, recipe);
  if (!json.ok) return json;
  const checks = (json.value as { checks?: unknown } | null)?.checks;
  if (!Array.isArray(checks)) return { ok: true, value: [] };
  const { acceptanceSpecError } = await import("#src/commands/orchestration/accept.ts");
  for (let index = 0; index < checks.length; index += 1) {
    const invalid = acceptanceSpecError(checks[index], index);
    if (invalid !== undefined) return { ok: false, reason: `recipe "${recipe}": ${label}: ${invalid}` };
  }
  return { ok: true, value: checks as AcceptanceCheck[] };
}

/** The recipe's acceptance checks read from `file`; undefined when the recipe has none. */
export async function readAcceptanceFile(file: string, recipe: string): Promise<RecipeFile<AcceptanceCheck[]> | undefined> {
  const text = await readOrAbsent(file);
  if (text === undefined) return undefined;
  return parseAcceptanceChecks(text, recipe);
}
