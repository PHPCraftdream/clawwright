import { prepareLint } from "./lint/plan.ts";
import type { LintPlan } from "./lint/plan.ts";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { info } from "#src/core/io/log.ts";
import type { RecipeName } from "#src/core/values/names.ts";
import type { RecipeRef } from "#src/core/values/plan.ts";
import { loadRecipe } from "#src/service/recipe.ts";
import { collectPortableRecipeFiles } from "#src/security/privacy/recipe-portable-content.ts";

export const RECIPE_CHECK_TIMEOUT_MS = 30_000;
const RECIPE_CHECK_OUTPUT_BYTES = 64 * 1024;

export interface RecipeCheckPlan {
  readonly name: RecipeName | RecipeRef;
  readonly directory: string;
  readonly files: readonly string[];
  readonly lint: LintPlan;
  readonly dryRun: boolean;
}

export async function prepareRecipeCheck(name: RecipeName | RecipeRef, dryRun: boolean): Promise<RecipeCheckPlan> {
  const { directory } = await loadRecipe(name);
  // Nested node_modules is walked before filtering; unsafe dependency links still refuse.
  const walked = await collectPortableRecipeFiles(directory, { excludeTop: "node_modules" });
  const portable = walked.files.filter((file) => !file.split("/").includes("node_modules")).sort();
  const files = portable.filter((file) => file.endsWith(".check.ts"));
  const lint = await prepareLint(directory, portable);
  if (files.length === 0 && lint.targets.length === 0 && !portable.includes("compose.yml")) throw new Error(`recipe "${name}": no checks found — add *.check.ts files anywhere recursively under the recipe directory`);
  return { name, directory, files, lint, dryRun };
}

/** Explicit allowlist: never inherit NODE_OPTIONS, app settings or credential variables. */
export function recipeCheckEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"]) {
    const actual = Object.keys(source).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (actual !== undefined) env[key] = source[actual];
  }
  return env;
}

function runCheckFile(directory: string, file: string, timeoutMs: number): Promise<{ ok: boolean; output: string; reason: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", resolve(directory, ...file.split("/"))], {
      cwd: directory, env: recipeCheckEnvironment(), stdio: ["ignore", "pipe", "pipe"], shell: false,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let settled = false;
    const capture = (chunk: Buffer): void => {
      const remaining = RECIPE_CHECK_OUTPUT_BYTES - bytes;
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) { const kept = chunk.subarray(0, remaining); chunks.push(kept); bytes += kept.length; }
    };
    const finish = (ok: boolean, reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      done({ ok, reason, output: Buffer.concat(chunks).toString("utf8") + (truncated ? "\n[output truncated]" : "") });
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      // Do not await close: untrusted descendants can retain the output pipes.
      finish(false, `timeout after ${timeoutMs}ms`);
    }, timeoutMs);
    child.on("error", (error) => finish(false, error.message));
    child.on("close", (code, signal) => finish(code === 0, signal === null ? `exit ${code}` : `signal ${signal}`));
  });
}

export async function runCheckAction(plan: RecipeCheckPlan, timeoutMs = RECIPE_CHECK_TIMEOUT_MS): Promise<number> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RECIPE_CHECK_TIMEOUT_MS) {
    throw new Error(`recipe check timeout must be 1..${RECIPE_CHECK_TIMEOUT_MS}ms`);
  }
  if (plan.dryRun) {
    for (const file of plan.lint.targets) info(`would lint ${file}`);
    for (const file of plan.files) info(`would run ${file}`);
    info(`${plan.files.length} recipe check file(s); dry-run: no code executed`);
    return 0;
  }
  let failed = 0;
  for (const finding of plan.lint.findings) info(`${finding.severity} ${finding.code} ${finding.file}:${finding.line} ${finding.message}`);
  const lintFailed = plan.lint.findings.some((finding) => finding.severity === "error");
  for (const file of plan.files) {
    // Revalidate the tree before each spawn; earlier checks may have changed it.
    const current = await prepareRecipeCheck(plan.name, false);
    if (current.directory !== plan.directory || !current.files.includes(file)) throw new Error(`${file}: recipe check tree changed`);
    const result = await runCheckFile(plan.directory, file, timeoutMs);
    info(`${result.ok ? "ok" : "FAIL"} ${file}${result.ok ? "" : ` (${result.reason})`}`);
    if (!result.ok) { failed++; if (result.output !== "") info(result.output); }
  }
  info(`${plan.files.length - failed} recipe check file(s) passed, ${failed} failed`);
  return failed === 0 && !lintFailed ? 0 : 1;
}
