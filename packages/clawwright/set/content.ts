// The portable content model of one set source — a working tree or an unpacked artifact
// (refactor plan stage 7, S3.2; design: docs/internal/refactor-stage7-portable-content-design.md).
//
// ONE builder, taking the source ROOT as an argument: one inventory walk through the
// portable-content policy, the declaration read once, every carried JSON file read once and
// parsed from those bytes (a caller that already holds the bytes passes them in `preRead`).
// Content problems are the builder's diagnostics — the build gate refuses on a recipe's
// walkError; the validator reports the rest. Content validation (set/ownership/validate.ts)
// runs over this model and reads nothing else — no ambient path, no global source switch —
// so a tree and the artifact built from it are judged by the same engine over the same bytes.
// Integrity (archive entries, manifest checksums, links) stays in set/load.ts and only gates
// whether a model may be built at all; the manifest itself is attached by the caller (built
// from the inventory for a tree, verified from set.json for an artifact).

import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRecipeDefinition } from "#src/service/recipe.ts";
import { collectPortableRecipeFiles } from "#src/security/privacy/recipe-portable-content.ts";
import { checksumOf } from "#src/service/checksums.ts";
import { desiredStateShapeError } from "#src/set/ownership/validate.ts";
import { recipeInvalidDefinition } from "#src/set/advice.ts";
import { parseAcceptanceChecks, parseAgentDeclaration } from "./recipe-files.ts";
import type { AgentConfig } from "#src/commands/management/provision-agent/declaration.ts";
import type { AcceptanceCheck } from "#src/commands/orchestration/accept.ts";
import { DESIRED_STATE_PATH } from "./artifacts/model.ts";
import type { SetManifest } from "./artifacts/model.ts";
import type { Problem } from "#src/service/inspection.ts";

/** One carried file: portable path (`recipes/<name>/…`), sha256 of its bytes, byte size,
 *  and where the bytes were read from. Built by the single inventory walk. */
export interface PortableFile {
  readonly path: string;
  readonly checksum: string;
  readonly size: number;
  readonly origin: string;
}

/** The set's config declaration, read once. `label` is the path findings name — the
 *  source's own declaration path, exactly the absolute path today's texts print. */
export interface DeclarationContent {
  readonly label: string;
  /** The bytes, when the file could be read. */
  readonly raw: string | undefined;
  readonly empty: boolean;
  /** Why the file could not be read; `missing` is the ENOENT case. */
  readonly readError: { readonly missing: boolean; readonly message: string } | undefined;
  /** The parsed JSON, when it parsed. */
  readonly parsed: unknown;
  readonly parseError: string | undefined;
  readonly shapeError: string | undefined;
  /** The declared values (one per { path, value } operation), when the shape is valid. */
  readonly values: readonly unknown[] | undefined;
}

/** Which carried file a content diagnostic is about — structural identity, not prose: a
 *  prose substring once let an agent diagnostic whose text merely contained
 *  "acceptance.json" (agentId "acceptance.json") win build's refusal over the real
 *  acceptance error, breaking the acceptance-before-agent order. */
export type DiagnosticSource = "recipe" | "agent-config" | "acceptance";
export interface SetDiagnostic { readonly problem: Problem; readonly source: DiagnosticSource; readonly recipe: string; }

/** One recipe's carried files as the walk saw them. `walkError` is the walker's own failure
 *  message — the build gate refuses on it; a rejected recipe.json is instead a diagnostic
 *  (recipeInvalidDefinition), because the content, not the source, is at fault. */
export interface ParsedRecipeContent {
  /** Where the recipe's files live in this source (findings name this path verbatim). */
  readonly dir: string;
  readonly dirExists: boolean;
  readonly walkError: string | undefined;
  /** The parsed values from the same single read that produced the diagnostics:
   *  the ok agent/acceptance values, or undefined when absent or rejected. */
  readonly agent: AgentConfig | undefined;
  readonly acceptance: AcceptanceCheck[] | undefined;
}

/** Everything content validation may judge about one source. */
export interface PortableContent {
  readonly inventory: readonly PortableFile[];
  readonly declaration: DeclarationContent;
  readonly parsed: { readonly recipes: Readonly<Record<string, ParsedRecipeContent>> };
  /** Attached by the caller: built from the inventory for a tree, the verified manifest
   *  for an artifact. `carried()`-style questions are answered from it, never from the
   *  disk — a privateFiles-kept tree file is in neither. */
  readonly manifest: SetManifest;
  /** Content problems found while building (a rejected recipe.json, agent/config.json or
   *  acceptance.json); the validator passes them through as findings. */
  readonly diagnostics: readonly SetDiagnostic[];
}

/** A model without its manifest yet (the tree's manifest is built FROM the inventory). */
export interface PortableContentBase {
  readonly inventory: readonly PortableFile[];
  readonly declaration: DeclarationContent;
  readonly parsed: { readonly recipes: Readonly<Record<string, ParsedRecipeContent>> };
  readonly diagnostics: readonly SetDiagnostic[];
}

/** Where the model is built from. Both sources go through the same request shape: a tree
 *  passes the deployment directory (recipeRoot may sit outside it); an unpacked artifact
 *  passes its staging root with recipeRoot/declarationPath resolved inside it. */
export interface PortableContentRequest {
  readonly recipeRoot: string;
  readonly declarationPath: string;
  /** Recipe names to inspect — the manifest's recipe keys, both sources. */
  readonly recipes: readonly string[] | (() => Promise<readonly string[]>);
  /** Bytes a caller already read (absolute path → utf8 text plus its checksum), used in
   *  place of a re-read. Both sides hash the same utf8 text, so the checksums agree. */
  readonly preRead?: ReadonlyMap<string, Buffer>;
  /** Test seam: the physical reader the memoized `read` falls through to. Counts physical reads. */
  readonly readFile?: (path: string) => Promise<Buffer>;
  readonly afterDeclaration?: (declaration: DeclarationContent) => Promise<void>;
  readonly afterRecipe?: (name: string, parsed: ParsedRecipeContent, diagnostics: readonly SetDiagnostic[], inventory: readonly PortableFile[]) => Promise<void>;
}

export function portableContent(base: PortableContentBase, manifest: SetManifest): PortableContent {
  return { ...base, manifest };
}

/** The declaration analysis for bytes a caller already holds (in-memory models in checks). */
export function declarationContent(label: string, raw: string): DeclarationContent {
  const empty = raw.trim() === "";
  let parsed: unknown;
  let parseError: string | undefined;
  if (!empty) {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      parseError = (error as Error).message;
    }
  }
  const shapeError = parseError === undefined && !empty ? desiredStateShapeError(parsed) : undefined;
  return {
    label,
    raw,
    empty,
    readError: undefined,
    parsed,
    parseError,
    shapeError,
    values: parseError === undefined && shapeError === undefined && !empty ? (parsed as { path: string; value?: unknown }[]).map((entry) => entry.value) : undefined,
  };
}

function declarationFromRead(label: string, bytes: Buffer | undefined, error?: unknown): DeclarationContent {
  if (error !== undefined) {
    return { label, raw: undefined, empty: false, readError: { missing: (error as NodeJS.ErrnoException).code === "ENOENT", message: (error as Error).message }, parsed: undefined, parseError: undefined, shapeError: undefined, values: undefined };
  }
  return declarationContent(label, bytes!.toString("utf8"));
}

/** Builds the model for one source: the declaration first, then ONE walk of the recipe
 *  tree through the portable-content policy (the same walker that packs it, so private
 *  and sensitive files are absent from the inventory for the same reason on both
 *  sources). A recipe directory that does not exist contributes no inventory and
 *  dirExists: false — the validator reports it, exactly as the disk check used to. */
export async function collectPortableContent(request: PortableContentRequest): Promise<PortableContentBase> {
  const cache = new Map<string, Promise<Buffer>>();
  for (const [path, bytes] of request.preRead ?? []) cache.set(path, Promise.resolve(bytes));
  const read = (abs: string): Promise<Buffer> => {
    let pending = cache.get(abs);
    if (pending === undefined) {
      pending = (request.readFile ?? readFile)(abs); // seam: a check proves each path is physically read once
      cache.set(abs, pending);
    }
    return pending;
  };
  const declarationResult = await read(request.declarationPath).then(
    (bytes) => declarationContent(request.declarationPath, bytes.toString("utf8")),
    (error: unknown) => declarationFromRead(request.declarationPath, undefined, error),
  );
  const declaration = declarationResult;
  await request.afterDeclaration?.(declaration);
  const recipeNames = typeof request.recipes === "function" ? await request.recipes() : request.recipes;
  const inventory: PortableFile[] = [];
  const diagnostics: SetDiagnostic[] = [];
  if (declaration.raw !== undefined) {
    const declarationBytes = await read(request.declarationPath).catch(() => undefined);
    if (declarationBytes !== undefined) inventory.push({ path: DESIRED_STATE_PATH, checksum: checksumOf(declarationBytes), size: declarationBytes.byteLength, origin: request.declarationPath });
  }
  const recipes: Record<string, ParsedRecipeContent> = {};
  for (const name of recipeNames) {
    const dir = resolve(request.recipeRoot, name);
    const dirExists = await access(dir).then(() => true, () => false);
    let walkError: string | undefined;
    let definitionDiagnosed = false;
    let walked: Awaited<ReturnType<typeof collectPortableRecipeFiles>> | undefined;
    let carried = new Set<string>();
    const problemStart = diagnostics.length;
    const recipePath = resolve(dir, "recipe.json");
    if (dirExists) {
      try {
        walked = await collectPortableRecipeFiles(dir, { requiredFiles: ["agent/config.json", "acceptance.json"], readRecipeManifest: async (path) => read(path).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }) });
        carried = new Set(walked.files);
      } catch (error) {
        const recipeBytes = await cache.get(recipePath)?.catch(() => undefined);
        walkError = (error as Error).message;
        const definitionError = recipeBytes === undefined
          ? undefined
          : (() => { try { parseRecipeDefinition(name, recipeBytes.toString("utf8")); return undefined; } catch (parseError) { return (parseError as Error).message; } })();
        const reason = definitionError ?? (error as Error).message;
        diagnostics.push({ problem: recipeInvalidDefinition(name, reason), source: "recipe", recipe: name });
        definitionDiagnosed = true;
        if (recipeBytes !== undefined) {
          carried.add("recipe.json");
          inventory.push({ path: `recipes/${name}/recipe.json`, checksum: checksumOf(recipeBytes), size: recipeBytes.byteLength, origin: recipePath });
        }
      }
    }
    if (walked !== undefined) {
      for (const rel of walked.files.sort()) {
        const origin = resolve(dir, ...rel.split("/"));
        const bytes = await read(origin).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          if (rel === "agent/config.json" || rel === "acceptance.json") {
            diagnostics.push({ problem: recipeInvalidDefinition(name, `recipe "${name}": recipes/${name}/${rel} could not be read: ${(error as Error).message}`, rel), source: rel === "agent/config.json" ? "agent-config" : "acceptance", recipe: name });
            return undefined;
          }
          throw error;
        });
        if (bytes !== undefined) inventory.push({ path: `recipes/${name}/${rel}`, checksum: checksumOf(bytes), size: bytes.byteLength, origin });
      }
    }
    const readOptionalText = async (rel: string): Promise<string | undefined> => {
      if (!carried.has(rel)) return undefined;
      try { return (await read(resolve(dir, ...rel.split("/")))).toString("utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return undefined; }
    };
    const agentText = await readOptionalText("agent/config.json");
    let agent: AgentConfig | undefined;
    if (agentText !== undefined) {
      const parsed = await parseAgentDeclaration(agentText, name);
      if (parsed.ok) agent = parsed.value;
      else diagnostics.push({ problem: recipeInvalidDefinition(name, parsed.reason, "agent/config.json"), source: "agent-config", recipe: name });
    }
    const acceptanceText = await readOptionalText("acceptance.json");
    let acceptance: AcceptanceCheck[] | undefined;
    if (acceptanceText !== undefined) {
      const checks = await parseAcceptanceChecks(acceptanceText, name);
      if (checks.ok) acceptance = checks.value;
      else diagnostics.push({ problem: recipeInvalidDefinition(name, checks.reason, "acceptance.json"), source: "acceptance", recipe: name });
    }
    const recipeText = carried.has("recipe.json") ? (await read(resolve(dir, "recipe.json")).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; diagnostics.push({ problem: recipeInvalidDefinition(name, `recipe "${name}": recipes/${name}/recipe.json could not be read: ${(error as Error).message}`, "recipe.json"), source: "recipe", recipe: name }); return undefined; }))?.toString("utf8") : undefined;
    if (recipeText !== undefined && !definitionDiagnosed) {
      try { parseRecipeDefinition(name, recipeText); }
      catch (error) { diagnostics.push({ problem: recipeInvalidDefinition(name, (error as Error).message), source: "recipe", recipe: name }); }
    }
    recipes[name] = { dir, dirExists, walkError, agent, acceptance };
    await request.afterRecipe?.(name, recipes[name], diagnostics.slice(problemStart), inventory);
  }
  return { inventory, declaration, parsed: { recipes }, diagnostics };
}
