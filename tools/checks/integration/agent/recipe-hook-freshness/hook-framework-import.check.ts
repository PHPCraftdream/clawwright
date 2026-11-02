// check:exclusive — drops a scratch deployment into apps/ for the gate, which other checks that enumerate deployments must not see.
// The documented hook import — `@phpcraftdream/clawwright/private-config` — loads in both kinds of
// deployment: a checkout one (no dist build; the hook loader maps the package's public exports
// onto the checkout's own framework sources) and an installed one (the recipe's own node_modules
// answers first, and the checkout mapping never shadows it).

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { recipe } from "#framework/commands/management/recipe/index.ts";
import { checkoutFrameworkSource, FRAMEWORK_EXPORT_SOURCES } from "#framework/core/env.ts";
import { monorepoRoot } from "#framework/core/env.ts";
import { useRecipesDir } from "#framework/service/recipe.ts";
import { withOutputSink } from "#framework/core/io/output.ts";
import { check, finish, isolatedAppsRoot } from "#checks/kit/harness.ts";
import { runProcess } from "#checks/kit/spawn.ts";
import { scratchDeployment, stubContext } from "./fixture.ts";
const { outerRecipes } = scratchDeployment();
const apps = await isolatedAppsRoot("hook-framework-import");

async function verifyRevision(name: string): Promise<{ revision?: number }> {
  const { ctx } = stubContext({});
  let output = "";
  await withOutputSink((chunk) => { output += chunk; }, () => recipe(ctx, ["verify", name]));
  return JSON.parse(output) as { revision?: number };
}

// Checkout-style: the recipe has no node_modules at all, so the specifier can only come
// from the checkout's own framework sources.
{
  const root = resolve(tmpdir(), `clawwright-recipe-hook-sources-${Date.now()}`);
  try {
    await mkdir(resolve(root, "sources"), { recursive: true });
    await writeFile(resolve(root, "sources", "recipe.json"), JSON.stringify({ description: "Framework sources probe" }), "utf8");
    await writeFile(
      resolve(root, "sources", "verify.ts"),
      "import { generatePrivateSecret } from \"@phpcraftdream/clawwright/private-config\";\nexport async function verify() { return { ok: true, revision: generatePrivateSecret().length }; }\n",
      "utf8",
    );
    useRecipesDir(root);
    check("sources: the documented @phpcraftdream/clawwright/private-config import loads from the checkout's framework sources", Number((await verifyRevision("sources")).revision) > 0, true);
  } finally {
    useRecipesDir(outerRecipes);
    await rm(root, { recursive: true, force: true });
  }
}

// Installed-style: a real package in the recipe's own node_modules answers first.
{
  const root = resolve(tmpdir(), `clawwright-recipe-hook-installed-${Date.now()}`);
  try {
    await mkdir(resolve(root, "installed", "node_modules", "@phpcraftdream", "clawwright"), { recursive: true });
    await writeFile(resolve(root, "installed", "recipe.json"), JSON.stringify({ description: "Installed package probe" }), "utf8");
    await writeFile(
      resolve(root, "installed", "node_modules", "@phpcraftdream", "clawwright", "package.json"),
      JSON.stringify({ name: "@phpcraftdream/clawwright", version: "0.0.0-check", type: "module", exports: { "./private-config": "./private-config.js" } }),
      "utf8",
    );
    await writeFile(
      resolve(root, "installed", "node_modules", "@phpcraftdream", "clawwright", "private-config.js"),
      "export function stubRevision() { return 42; }\n",
      "utf8",
    );
    await writeFile(
      resolve(root, "installed", "verify.ts"),
      "import { stubRevision } from \"@phpcraftdream/clawwright/private-config\";\nexport async function verify() { return { ok: true, revision: stubRevision() }; }\n",
      "utf8",
    );
    useRecipesDir(root);
    check("installed: the recipe's own @phpcraftdream/clawwright package answers before any checkout mapping", (await verifyRevision("installed")).revision, 42);
  } finally {
    useRecipesDir(outerRecipes);
    await rm(root, { recursive: true, force: true });
  }
}

// The mapping table mirrors the package's export map: every public export resolves to the
// source file its dist target is built from, and nothing else does.
{
  const manifest = JSON.parse(await readFile(resolve(monorepoRoot, "packages", "clawwright", "package.json"), "utf8")) as { exports: Record<string, { default: string }> };
  for (const [key, target] of Object.entries(manifest.exports)) {
    const expected = target.default.replace("./dist/", "").replace(/\.js$/, ".ts");
    const mapped = checkoutFrameworkSource(`@phpcraftdream/clawwright/${key.slice(2)}`);
    check(`export ${key} maps to its source file`, mapped !== undefined && mapped.replaceAll("\\", "/").endsWith(`/packages/clawwright/${expected}`), true);
  }
  check("an unknown subpath maps to nothing", checkoutFrameworkSource("@phpcraftdream/clawwright/not-an-export"), undefined);
  check("a foreign package maps to nothing", checkoutFrameworkSource("json5"), undefined);
  check("the mapping table covers no more than the package's exports", Object.keys(FRAMEWORK_EXPORT_SOURCES).sort(), Object.keys(manifest.exports).sort());
}

// The gate's own resolver (a deployment's app.ts) answers with the same sources.
{
  const probe = await import("#framework/entry/delegate.ts");
  check("the gate resolver is exported for tools/clawwright.ts", typeof probe.resolveFrameworkFromSources, "function");
}

// The gate itself: a checkout deployment whose app.ts imports the public
// `@phpcraftdream/clawwright/app` specifier loads only while tools/clawwright.ts registers
// resolveFrameworkFromSources() — a probe of the loader's own functions cannot tell.
{
  // Unique per run: a fixed name would overwrite and delete a directory someone else owns,
  // and a killed run would leave it behind under apps/ as a phantom deployment (R32-10).
  // The fixture is marked with a token file no real deployment has; stale leftovers from
  // killed runs are swept ONLY when they carry that mark — `gateprobe-*` is a legal
  // deployment name and this check must never delete what it did not create (R33-02).
  const prefix = "gateprobe-";
  const marker = ".clawwright-check-fixture";
  const appsDir = apps.root;
  await mkdir(appsDir, { recursive: true });
  // A sweep deletes only marked leftovers: a user's own gateprobe-* deployment — same
  // prefix, no marker — must survive a check run untouched (R33-02, reproduced with
  // `new-app gateprobe-prod` losing .env, secrets/ and lock).
  const decoy = resolve(appsDir, `gateprobe-user-${randomBytes(4).toString("hex")}`);
  await mkdir(resolve(decoy, "config"), { recursive: true });
  await writeFile(resolve(decoy, "config", "deployment.lock.json"), "{}", "utf8");
  await writeFile(resolve(decoy, ".env"), "GATEWAY_TOKEN=not-ours", "utf8");

  async function sweepStaleFixtures(): Promise<void> {
    for (const entry of await readdir(appsDir)) {
      if (!entry.startsWith(prefix)) continue;
      const dir = resolve(appsDir, entry);
      let marked = false;
      try {
        await readFile(resolve(dir, marker), "utf8");
        marked = true;
      } catch {
        marked = false;
      }
      if (marked) await rm(dir, { recursive: true, force: true });
    }
  }
  await sweepStaleFixtures();

  const name = `${prefix}${randomBytes(6).toString("hex")}`;
  const appDir = resolve(appsDir, name);
  // No recursive: an existing directory is never adopted or silently cleared — and if the
  // random name ever collides with a real deployment, this fails loudly instead of deleting.
  await mkdir(appDir);
  await writeFile(resolve(appDir, marker), "gate probe fixture of check hook-framework-import; safe to delete", "utf8");
  await writeFile(
    resolve(appDir, "app.ts"),
    [
      "import { defineApp } from \"@phpcraftdream/clawwright/app\";",
      "export default defineApp({ name: \"gateprobe\", description: \"checkout gate probe\", commands: { ping: { summary: \"probe\" } } });",
      "",
    ].join("\n"),
    "utf8",
  );
  try {
    const result = await runProcess(
      process.execPath,
      ["--experimental-strip-types", resolve(monorepoRoot, "tools", "clawwright.ts"), "--app", name, "status"],
      { cwd: apps.root, timeoutMs: 120_000 },
    );
    // Positive assertion: the app LOADED far enough for the dispatcher to answer — a loader
    // failure, a timeout or an otherwise empty output must fail here, not pass vacuously.
    const loaded = result.output.includes("unknown command: status");
    check(
      "a checkout deployment's app.ts importing @phpcraftdream/clawwright/app loads through the gate",
      loaded && !result.output.includes("cannot load deployment") && !result.output.includes("Cannot find package '@phpcraftdream/clawwright'"),
      true,
    );
    if (!loaded) process.stderr.write(`    ${result.output.split("\n").filter((line) => /unknown command|cannot load|Cannot find|Error/.test(line)).slice(0, 4).join("\n    ")}\n`);
  } finally {
    await rm(appDir, { recursive: true, force: true });
    const decoyStillThere = await readFile(resolve(decoy, ".env"), "utf8")
      .then(() => true)
      .catch(() => false);
    check("a user's unmarked gateprobe-* deployment survives the stale-fixture sweep", decoyStillThere, true);
    await rm(decoy, { recursive: true, force: true });
    await apps.dispose();
  }
}

finish("recipe hook framework import");
