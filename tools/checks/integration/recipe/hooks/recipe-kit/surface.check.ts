import { readFile, readdir } from "node:fs/promises";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";
import type { RecipeContext, RecipeRuntime } from "#framework/recipe-kit/index.ts";
import type { Context } from "#framework/core/context.ts";
import type { Runtime } from "#framework/runtime/runtime.ts";

// Compile-time compatibility, without pulling these imports into public declarations.
const compatibleRuntime = (runtime: Runtime): RecipeRuntime => runtime;
const compatibleContext = (ctx: Context): RecipeContext => ctx;
void compatibleRuntime;
void compatibleContext;
const root = new URL("../../../../../../packages/clawwright/recipe-kit/", import.meta.url);
const entries = await readdir(root);
checkTrue("new source directory at most seven entries", entries.length <= 7);
const graph = ["index.ts", "types.ts", "app.ts", "consumer.ts"];
for (const file of graph) {
  const source = await readFile(new URL(file, root), "utf8");
  checkTrue(`${file} no explicit any`, !/\bany\b/.test(source));
  const typeImports = [...source.matchAll(/import type[^;]+from\s+["']([^"']+)/g)].map((match) => match[1]);
  checkTrue(`${file} types self-contained`, typeImports.every((path) => path === "./types.ts"));
}
const manifest = JSON.parse(await readFile(new URL("../package.json", root), "utf8")) as { exports: Record<string, { types: string; default: string }> };
check("public nested entry", manifest.exports["./recipe-kit"], { types: "./dist/recipe-kit/index.d.ts", default: "./dist/recipe-kit/index.js" });
finish("recipe-kit surface");
