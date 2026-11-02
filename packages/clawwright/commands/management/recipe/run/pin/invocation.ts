import type { Context } from "#src/core/context.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { info, log } from "#src/core/io/log.ts";
import { guardedWith } from "#src/runtime/lock/instance-lock.ts";
import { loadRecipe } from "#src/service/recipe.ts";
import { preparePin, executePin } from "./plan.ts";
export { preparePin, executePin } from "./plan.ts";

/** The ordinary (non-JSON) preview/apply report: header, checksum change, provenance, next step. */
export function pinReportLines(name: string, result: Awaited<ReturnType<typeof executePin>>): { headline: string; details: string[] } {
  return {
    headline: `${name}: ${result.file}:${result.versionLine} ${result.old.version} -> ${result.new.version}`,
    details: [
      `checksum ${result.old.checksum} -> ${result.new.checksum}`,
      `checksum from ${result.sourceURL} for ${result.assetURL}`,
      `${result.applied ? "applied" : "preview"}; next: recipe install ${name}`,
    ],
  };
}
export async function runRecipePin(ctx: Context, input: { name: Parameters<typeof loadRecipe>[0]; version: string; artifact?: string; apply: boolean; takeover: Parameters<typeof guardedWith>[2] }, options: { fetcher?: import("./checksum.ts").FetchSeam; beforeWrite?: () => void | Promise<void> } = {}): Promise<void> {
  const recipe = await loadRecipe(input.name);
  const plan = await preparePin(recipe.directory, input.version, input.artifact);
  const run = () => executePin(plan, { ...options, apply: input.apply });
  const result = input.apply ? await guardedWith(ctx, `recipe pin ${input.name}`, input.takeover, run) : await run();
  if (isCaptured()) emit(`${JSON.stringify(result)}\n`);
  else { const report = pinReportLines(input.name, result); log(report.headline); for (const line of report.details) info(line); }
}
