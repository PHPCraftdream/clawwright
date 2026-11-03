import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnLocal } from "#framework/runtime/transport/transport.ts";
import { runApp } from "#framework/entry/cli.ts";
import { deploymentDir, useDeployment, useApplicationRecipesDir, recipesDir } from "#framework/runtime/deployment.ts";
import { clearSetSource, setSourceDir, useSetSource } from "#framework/set/artifacts/source.ts";
import { clearRecipesDir, listRecipes, recipesDirectory, useRecipesDir } from "#framework/service/recipe.ts";
import { withOutputSink, emit } from "#framework/core/io/output.ts";
import type { AppDefinition } from "#framework/core/app.ts";
import { useLinuxHost } from "#checks/foundation/hygiene/linux-host.ts";
import { CHILD_NODE_DEADLINE_MS } from "#checks/kit/spawn.ts";

useLinuxHost();

const root = await mkdtemp(join(tmpdir(), "clawwright-app-recipes-"));
const custom = join(root, "custom-recipes");
const defaultRoot = join(root, "recipes");
const sourceRoot = join(root, "source");
const previousDeployment = (() => {
  try { return deploymentDir(); } catch { return undefined; }
})();
const previousRecipes = (() => {
  try { return recipesDirectory(); } catch { return undefined; }
})();
const previousSource = setSourceDir();

/** Writes a minimal recipe fixture. */
async function recipe(directory: string, name: string): Promise<void> {
  await mkdir(join(directory, name), { recursive: true });
  await writeFile(join(directory, name, "recipe.json"), JSON.stringify({ description: name }));
}

try {
  await recipe(custom, "custom");
  await recipe(defaultRoot, "default");
  await recipe(join(sourceRoot, "recipes"), "source");
  await writeFile(join(root, ".env"), `OC_DATA_DIR=${join(root, "data")}\nOC_TARGET_LOCATION=local\n`);

  const command = {
    summary: "list recipes",
    readOnly: true,
    run: async () => {
      emit(JSON.stringify((await listRecipes()).map((entry) => entry.name)));
    },
  };
  const app: AppDefinition = { name: "fixture", description: "fixture", recipesDir: "custom-recipes", commands: { recipes: command } };

  useDeployment(root);
  clearSetSource();
  useRecipesDir(defaultRoot);
  const customOutput: string[] = [];
  await withOutputSink((chunk) => customOutput.push(chunk), () => runApp(app, ["recipes"]));
  assert.deepEqual(JSON.parse(customOutput.join("")), ["custom"]);
  assert.equal(recipesDir(), custom);

  // A temporary deployment uses its own root and returning restores the application's root.
  const temporaryDeployment = join(root, "temporary");
  useDeployment(temporaryDeployment);
  assert.equal(recipesDirectory(), join(temporaryDeployment, "recipes"));
  useDeployment(root);
  assert.equal(recipesDirectory(), custom);

  // A set source wins while active and the application root returns afterwards.
  useSetSource(sourceRoot);
  const sourceOutput: string[] = [];
  await withOutputSink((chunk) => sourceOutput.push(chunk), () => runApp(app, ["recipes"]));
  assert.deepEqual(JSON.parse(sourceOutput.join("")), ["source"]);
  clearSetSource();
  assert.equal(recipesDir(), custom);

  // An app without an override falls back to its deployment and does not inherit the prior app.
  const defaultApp: AppDefinition = { name: "fixture", description: "fixture", commands: { recipes: command } };
  const defaultOutput: string[] = [];
  await withOutputSink((chunk) => defaultOutput.push(chunk), () => runApp(defaultApp, ["recipes"]));
  assert.deepEqual(JSON.parse(defaultOutput.join("")), ["default"]);
  assert.equal(recipesDir(), defaultRoot);

  // MCP dispatch uses the same application root as the console path.
  const moduleUrl = (name: string) => new URL(`../../../../packages/clawwright/${name}.ts`, import.meta.url).href;
  const script = `
    const { serveMcp } = await import(${JSON.stringify(moduleUrl("integration/mcp/server"))});
    const { useDeployment } = await import(${JSON.stringify(moduleUrl("runtime/deployment"))});
    const { listRecipes } = await import(${JSON.stringify(moduleUrl("service/recipe"))});
    const { emit } = await import(${JSON.stringify(moduleUrl("core/io/output"))});
    useDeployment(${JSON.stringify(root)});
    await serveMcp({name:"fixture",description:"fixture",recipesDir:${JSON.stringify(custom)},service:{name:"gateway"},commands:{recipes:{summary:"list recipes",run:async()=>emit(JSON.stringify((await listRecipes()).map((r)=>r.name)))}}});
  `;
  const mcp = await spawnLocal(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recipes", arguments: {} } })}\n`,
    timeoutMs: CHILD_NODE_DEADLINE_MS,
  });
  assert.equal(mcp.code, 0);
  const response = JSON.parse(mcp.stdout.trim()) as { result: { content: [{ text: string }] } };
  assert.deepEqual(JSON.parse(response.result.content[0].text), ["custom"]);
} finally {
  if (previousSource === undefined) clearSetSource();
  else useSetSource(previousSource);
  useApplicationRecipesDir(undefined);
  if (previousRecipes === undefined) clearRecipesDir();
  else useRecipesDir(previousRecipes);
  if (previousDeployment !== undefined) useDeployment(previousDeployment);
  await rm(root, { recursive: true, force: true });
}

process.stderr.write("all application recipes directory checks passed\n");
