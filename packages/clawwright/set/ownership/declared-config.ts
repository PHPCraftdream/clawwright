import type { Context } from "#src/core/context.ts";
import { readFileCandidate } from "./candidate-file.ts";
import { writeFileAtomic } from "./ledger.ts";
import { desiredStateShapeError } from "./validate.ts";
import { configPathParts } from "#src/core/values/config/config-selectors.ts";

export interface DeclaredConfigEntry { readonly path: string; readonly value: unknown }
export interface DeclaredConfigRecord { readonly version: 1; readonly entries: DeclaredConfigEntry[] }
export const DECLARED_CONFIG_VERSION = 1;
export function declaredConfigFile(ctx: Context): string { return `${ctx.settings.dataDir}/clawwright-declared.json`; }

function parse(text: string | undefined): DeclaredConfigRecord | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const candidate = parsed as { version?: unknown; entries?: unknown };
    if (candidate.version !== DECLARED_CONFIG_VERSION || desiredStateShapeError(candidate.entries) !== undefined) return undefined;
    for (const entry of candidate.entries as DeclaredConfigEntry[]) configPathParts(entry.path);
    return { version: 1, entries: structuredClone(candidate.entries) as DeclaredConfigEntry[] };
  } catch { return undefined; }
}

/** Tolerant observation: an absent or unparseable record claims no paths. */
export async function readDeclaredConfig(ctx: Context): Promise<DeclaredConfigRecord> {
  const file = await readFileCandidate(ctx, declaredConfigFile(ctx));
  return parse(file.text) ?? { version: 1, entries: [] };
}

/** A writer must preserve evidence it cannot understand rather than replacing it. */
export async function readDeclaredConfigStrict(ctx: Context): Promise<DeclaredConfigRecord> {
  const path = declaredConfigFile(ctx);
  const file = await readFileCandidate(ctx, path);
  if (!file.present) return { version: 1, entries: [] };
  const parsed = parse(file.text);
  if (parsed === undefined) throw new Error(`${path} exists but could not be read as a valid declared-config record; repair it before applying configuration`);
  return parsed;
}

export async function writeDeclaredConfig(ctx: Context, entries: readonly DeclaredConfigEntry[]): Promise<void> {
  await writeFileAtomic(ctx, declaredConfigFile(ctx), `${JSON.stringify({ version: 1, entries: structuredClone(entries) }, null, 2)}\n`);
}
