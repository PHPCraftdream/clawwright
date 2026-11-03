// Checks local rsync filters over synthetic framework and recipe trees when available.

import { execFile, type ExecFileOptions } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXCLUDES, FRAMEWORK_EXCLUDES } from "#framework/security/privacy/deploy-boundary.ts";
import { check, finish, requires } from "#checks/kit/harness.ts";

function execFileAsync(program: string, args: string[], options: ExecFileOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(program, args, { ...options, encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function sourceTree(root: string, names: readonly string[]): Promise<void> {
  await mkdir(root);
  for (const name of names) {
    const path = join(root, ...name.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, name);
  }
}

async function fileList(root: string, target: string, excludes: readonly string[]): Promise<Set<string>> {
  await mkdir(target, { recursive: true });
  const { stdout } = await execFileAsync("rsync", [
    "--recursive",
    "--dry-run",
    "--out-format=%n",
    ...excludes.flatMap((pattern) => ["--exclude", pattern]),
    `${root}/`,
    `${target}/`,
  ]);
  return new Set(stdout.split(/\r?\n/).map((line) => line.replace(/\/$/, "")));
}

const frameworkKept = [
  "clawwright",
  "packages/clawwright/service/recipe.ts",
  "tools/checks/integration/apps/app-hooks.check.ts",
  "tools/checks/integration/build/source.ts",
];
const frameworkOmitted = [
  "apps/local.txt",
  ".git/config",
  "tools/local-checkout/.git",
  "tools/local-checkout/nested/.git/config",
  "node_modules/pkg/index.txt",
  "tools/node_modules/pkg/index.txt",
  "worktrees/agent/private.txt",
  "tools/worktrees/agent/private.txt",
  "packages/clawwright/dist/index.txt",
  "packages/clawwright/build/index.txt",
  "build/index.txt",
  "dist/index.txt",
  "coverage/report.txt",
  ".cache/index.txt",
  ".tmp/index.txt",
  "scratch/index.txt",
  ".claude/state.txt",
  ".idea/state.txt",
  ".vscode/state.txt",
  "secrets/local.txt",
  "packages/clawwright/framework.tgz",
  "packages/clawwright/cache.tsbuildinfo",
];
const recipeKept = [
  "build/recipe.json",
  "example/build/recipe.ts",
  "example/dist/app.js",
  "example/coverage/report.txt",
  "apps/example/dist/app.js",
];
const recipeOmitted = [
  ".git",
  "example/nested/.git/config",
  "node_modules/pkg/index.txt",
  "example/node_modules/pkg/index.txt",
  "worktrees/agent/local.txt",
  "example/worktrees/agent/local.txt",
  "example/secrets/local.txt",
];

check("framework hides generated checkout roots", ["/build/", "/dist/", "/scratch/", "/packages/clawwright/dist/"].every((name) => FRAMEWORK_EXCLUDES.includes(name)), true);
check("recipes retain authored build and dist paths", ["/build/", "/dist/", "build/", "dist/", "scratch/"].some((name) => EXCLUDES.includes(name)), false);
check("both mirrors hide dependencies and worktrees", ["node_modules/", "worktrees/", ".git"].every((name) => EXCLUDES.includes(name)), true);
check("only the framework hides root apps", FRAMEWORK_EXCLUDES.includes("/apps/") && !EXCLUDES.includes("/apps/"), true);

await requires("rsync", "rsync exercised over both payloads", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "clawwright-rsync-list-"));
  try {
    const framework = join(scratch, "framework");
    await sourceTree(framework, frameworkKept.concat(frameworkOmitted));
    const frameworkList = await fileList(framework, join(scratch, "target"), FRAMEWORK_EXCLUDES);
    for (const name of frameworkKept) check(`framework keeps ${name}`, frameworkList.has(name), true);
    for (const name of frameworkOmitted) check(`framework omits ${name}`, frameworkList.has(name), false);

    const recipes = join(scratch, "recipes");
    await sourceTree(recipes, recipeKept.concat(recipeOmitted));
    const recipeList = await fileList(recipes, join(scratch, "target"), EXCLUDES);
    for (const name of recipeKept) check(`recipes keep ${name}`, recipeList.has(name), true);
    for (const name of recipeOmitted) check(`recipes omit ${name}`, recipeList.has(name), false);
    check("available rsync exercised both payloads", frameworkList.size > 0 && recipeList.size > 0, true);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

finish("deploy rsync file-list");
