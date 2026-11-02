// Counters behind the two stage-7 S2.5 plain ratchets in architecture.check.ts, extracted so
// the ratchet table file stays a table: kindCastsOutsideValues (value-brand mints outside
// core/values) and grammarCallsInRun (the same count grammar-in-run.check.ts enforces — ONE
// shared measurement; the check is the enforcer, the table records it).

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";
import { grammarInRunScan } from "./grammar-in-run.ts";

const BRAND_CAST = /\bas\s+(?:RecipeName|LocalArtifact|LocalRecipeSource|RecipeRef|Checksum|OperationId|OwnedObjectName|SetName|StoreName|AgentName|DeploymentName)\b/;

/** Value-brand casts (`as RecipeName`, …) in packages/clawwright/** outside core/values —
 *  comment lines are stripped so prose mentions never count. */
export async function kindCastsOutsideValues(): Promise<number> {
  let count = 0;
  async function scan(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "values") await scan(full); }
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const content = await readFile(full, "utf8");
        for (const line of content.split("\n")) {
          const stripped = line.replace(/(^|\s)\/\/.*$/, "$1").replace(/\/\*.*?\*\//g, "");
          const trimmed = stripped.trim();
          if (trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
          if (BRAND_CAST.test(stripped)) count += 1;
        }
      }
    }
  }
  await scan(join(monorepoRoot, "packages", "clawwright"));
  return count;
}

/** Grammar-mint calls inside run bodies under packages/clawwright/commands/** — the shared
 *  grammar-in-run measurement, shrink-only: after S2.5 it is 0 and must stay 0. */
export async function grammarCallsInRun(): Promise<number> {
  return (await grammarInRunScan()).sites.length;
}

// --- stage-7 S2.5 boundary counters (expected 0; wired as ratchets in architecture.check.ts) ----

/** Comment-stripped source lines of one file. */
function codeLines(content: string): readonly string[] {
  return content.split("\n").map((line) => {
    const stripped = line.replace(/(^|\s)\/\/.*$/, "$1").replace(/\/\*.*?\*\//g, "");
    const trimmed = stripped.trim();
    return trimmed.startsWith("*") || trimmed.startsWith("/*") ? "" : stripped;
  });
}

const ARGUMENT_ERROR_TOKEN = /\bARGUMENT_ERROR_TOKEN\b/;
const PREPARED_CALL = /\bprepared\s*\(/;

/** Stage-7 S2.5 layer-boundary counts over packages/clawwright/**, one file per occurrence:
 *  argumentErrorTokenOutside — files OUTSIDE core/command/** referencing the private
 *  ArgumentError token (the token stays in core/command/errors.ts; only that layer builds
 *  ArgumentErrors); preparedOutsideCommand — files OUTSIDE core/command/** calling
 *  `prepared(` (deep imports from hostile code remain possible in TS — the ratchet pins
 *  the codebase, not the type system); planMintImportOutside — files OUTSIDE core/values/**
 *  and core/command/** with a RUNTIME (non-`import type`) import of core/values/plan.ts,
 *  i.e. of the brand mints (spec.ts's refusal-helper import stays legal; type-only imports
 *  are erased, so they cannot reach the mints; tools/checks are not scanned at all — they
 *  legitimately import the refusal helpers). */
export async function stage7S25Boundaries(): Promise<{
  argumentErrorTokenOutside: number;
  preparedOutsideCommand: number;
  planMintImportOutside: number;
}> {
  let tokenFiles = 0;
  let preparedFiles = 0;
  let planMintFiles = 0;
  async function scan(dir: string, segments: readonly string[]): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const next = [...segments, entry.name];
      if (entry.isDirectory()) { if (entry.name !== "dist" && entry.name !== "node_modules") await scan(full, next); }
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const inCommand = segments[0] === "core" && segments[1] === "command";
        const inValues = segments[0] === "core" && segments[1] === "values";
        const lines = codeLines(await readFile(full, "utf8"));
        if (!inCommand && lines.some((line) => ARGUMENT_ERROR_TOKEN.test(line))) tokenFiles += 1;
        if (!inCommand && lines.some((line) => PREPARED_CALL.test(line))) preparedFiles += 1;
        if (!inCommand && !inValues && lines.some((line) => line.trim().startsWith("import {") && line.includes("core/values/plan.ts"))) planMintFiles += 1;
      }
    }
  }
  await scan(join(monorepoRoot, "packages", "clawwright"), []);
  return { argumentErrorTokenOutside: tokenFiles, preparedOutsideCommand: preparedFiles, planMintImportOutside: planMintFiles };
}
