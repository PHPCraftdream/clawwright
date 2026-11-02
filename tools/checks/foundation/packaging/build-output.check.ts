// Builds the framework package into a private OS-temp directory (never tools/framework/dist in
// the checkout — checks do not write into the checkout), so it shares no state and runs pooled.
// The compiled dist/entry/bin.js must start with a shebang every POSIX system can execute.
//
// Two ways to get this wrong, and this package has had both. Dropping the type-stripping
// concern entirely leaves the installed package failing with `Unknown file extension ".ts"`
// because bin.js dynamically imports the CONSUMER's own app.ts — a real,
// uncompiled TypeScript file this build never touches. Carrying the flag in the shebang
// instead (`#!/usr/bin/env -S node --experimental-strip-types`) fixes that on GNU coreutils
// and breaks the package outright on busybox, whose `env` has no -S — Alpine is the most
// common Node base image there is. So the shebang stays plain and bin.js re-executes itself
// with the flag when, and only when, loading app.ts turns out to need it; what is asserted
// here is that the shebang is plain, and installed-consumer.check.ts proves the recovery
// works by running the entry point with stripping explicitly disabled.

import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "#tools/build-framework-package.ts";
import { monorepoRoot } from "#framework/core/env.ts";

const base = "fd59e08fa0fbeb9450b5110c6bd0c08a2404d280";

async function walkFiles(dir: string, root = dir): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walkFiles(path, root)));
    else found.push(relative(root, path).replaceAll("\\", "/"));
  }
  return found.sort();
}

async function verifyRelocationParity(distDir: string): Promise<void> {
  const parityRoot = await mkdtemp(join(tmpdir(), "clawwright-relocation-parity-"));
  const originalBuilder = join(parityRoot, "tools", "build-framework-package.ts");
  const originalDist = join(parityRoot, "original-dist");

  async function baselineFile(path: string): Promise<Buffer> {
    const result = spawnSync("git", ["show", `${base}:${path}`], { cwd: monorepoRoot, encoding: "buffer" });
    if (result.status !== 0) throw new Error(`cannot read baseline ${path}: ${result.stderr.toString()}`);
    return result.stdout;
  }

  try {
    const listing = spawnSync("git", ["ls-tree", "-r", "--name-only", base, "tools/framework"], { cwd: monorepoRoot, encoding: "utf8" });
    if (listing.status !== 0) throw new Error(`cannot list baseline package: ${listing.stderr}`);
    for (const path of listing.stdout.trim().split("\n")) {
      if (!path) continue;
      const target = resolve(parityRoot, path);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, await baselineFile(path));
    }
    await mkdir(join(parityRoot, "tools"), { recursive: true });
    await writeFile(originalBuilder, await baselineFile("tools/build-framework-package.ts"));
    await writeFile(resolve(parityRoot, "tsconfig.json"), await baselineFile("tsconfig.json"));
    await writeFile(resolve(parityRoot, "package.json"), await baselineFile("package.json"));
    await symlink(resolve(monorepoRoot, "node_modules"), join(parityRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");

    const oldPackage = JSON.parse((await baselineFile("tools/framework/package.json")).toString("utf8")) as Record<string, unknown>;
    const newPackage = JSON.parse(await readFile(resolve(monorepoRoot, "packages/clawwright/package.json"), "utf8")) as Record<string, unknown>;
    const oldRepo = oldPackage.repository as Record<string, unknown>;
    const newRepo = newPackage.repository as Record<string, unknown>;
    if (oldRepo.directory !== "tools/framework" || newRepo.directory !== "packages/clawwright") throw new Error("package repository directory relocation changed unexpectedly");
    oldRepo.directory = newRepo.directory;
    const oldScripts = oldPackage.scripts as Record<string, unknown>;
    const newScripts = newPackage.scripts as Record<string, unknown>;
    if (oldScripts.prepack !== "node --experimental-strip-types ../build-framework-package.ts" || newScripts.prepack !== "node --experimental-strip-types ../../tools/build-framework-package.ts") throw new Error("package prepack relocation changed unexpectedly");
    oldScripts.prepack = newScripts.prepack;
    if (JSON.stringify(oldPackage) !== JSON.stringify(newPackage)) throw new Error("package manifest has changes beyond repository.directory and prepack relocation");

    const script = `import { build } from ${JSON.stringify(pathToFileURL(originalBuilder).href)}; await build(${JSON.stringify(originalDist)});`;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { cwd: parityRoot, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`baseline package build failed: ${result.stderr}`);
    const originalFiles = await walkFiles(originalDist);
    const relocatedFiles = await walkFiles(distDir);
    if (JSON.stringify(originalFiles) !== JSON.stringify(relocatedFiles)) throw new Error(`relocated output inventory differs: baseline=${originalFiles.length}, current=${relocatedFiles.length}`);

    const frameOld = 'resolve(dir, "tools", "framework", "package.json")';
    const frameNew = 'resolve(dir, "packages", "clawwright", "package.json")';
    const resolveOld = 'resolve(root, "tools", "framework", "package.json")';
    const resolveNew = 'resolve(root, "packages", "clawwright", "package.json")';
    const scaffoldOld = 'return JSON.stringify(`../../tools/framework/${module}`);';
    const scaffoldNew = 'return JSON.stringify(`../../packages/clawwright/${module}`);';
    // The build's rewriteSpecifiers regex also rewrites import-like text inside this generated comment.
    const scaffoldSeamOld = '// checkout-sourced for importsCheckoutSourcesIn: import { defineApp } from "../../tools/framework/core/app.js";';
    const scaffoldSeamNew = '// checkout-sourced for importsCheckoutSourcesIn: import { defineApp } from "../../packages/clawwright/core/app.js";';
    const scaffoldResolveOld = 'pathToFileURL(resolve(monorepoRoot, "tools", "framework", module)).href';
    const scaffoldResolveNew = 'pathToFileURL(resolve(monorepoRoot, "packages", "clawwright", module)).href';
    const versionOld = 'const tools = dirname(dir);\n  if (basename(tools) === "tools" && existsSync(resolve(tools, "clawwright.ts"))) return { source: "checkout", path: dirname(tools) };';
    const versionNew = 'const root = dirname(dirname(dir));\n  if (basename(dir) === "clawwright" && basename(dirname(dir)) === "packages" && existsSync(resolve(root, "tools", "clawwright.ts"))) return { source: "checkout", path: root };';
    const privacyOld = 'base === "tools/framework" && (entry.name === "dist" || entry.name === "build")';
    const privacyNew = 'base === "packages/clawwright" && (entry.name === "dist" || entry.name === "build")';
    // The compatibility resolver intentionally adds behavior, unlike the path-only moves.
    // Pin both reviewed sources; the installed-consumer check exercises its old/new CLI paths.
    const oldDelegate = (await baselineFile("tools/framework/entry/delegate.ts")).toString("utf8").replaceAll("\r\n", "\n");
    const newDelegate = (await readFile(resolve(monorepoRoot, "packages/clawwright/entry/delegate.ts"), "utf8")).replaceAll("\r\n", "\n");
    const digest = (source: string): string => createHash("sha256").update(source).digest("hex");
    if (digest(oldDelegate) !== "d095cac086459b161289e0d67fe5acb77928ca54ee7cfeccd250fcbc0fba4a7d"
      || digest(newDelegate) !== "0e3b960ea943eaec1fab25f18acb3685823d36cafa22b4dea25ef550d24e819b") {
      throw new Error("compatibility resolver differs from the reviewed source pair");
    }
    const expectedDelegate = stripTypeScriptTypes(newDelegate, { mode: "strip" }).replace(
      /((?:from|import)\s*\(?\s*["'])(\.[^"']+)\.ts(["'])/g,
      "$1$2.js$3",
    );
    const anchors = new Map<string, [string, string][]>([
      ["core/io/invocation/frame.js", [[frameOld, frameNew]]],
      ["entry/checkout-gate.js", [["../../checks/kit", "../../../tools/checks/kit"]]],
      ["entry/resolve.js", [["tools\\/framework\\/", "(?:packages\\/clawwright|tools\\/framework)\\/"], [resolveOld, resolveNew]]],
      ["integration/deployment/scaffold.js", [[scaffoldResolveOld, scaffoldResolveNew], [scaffoldOld, scaffoldNew], [scaffoldSeamOld, scaffoldSeamNew]]],
      ["integration/version.js", [[versionOld, versionNew]]],
      ["security/privacy/deploy-boundary.js", [["/tools/framework/dist/", "/packages/clawwright/dist/"], ["/tools/framework/build/", "/packages/clawwright/build/"], [privacyOld, privacyNew]]],
    ]);
    for (const path of originalFiles) {
      const oldText = await readFile(resolve(originalDist, path));
      const currentText = await readFile(resolve(distDir, path));
      if (path === "entry/delegate.js") {
        if (currentText.toString("utf8") !== expectedDelegate) throw new Error("built compatibility resolver differs from the reviewed source");
        continue;
      }
      const pathAnchors = anchors.get(path) ?? [];
      if (pathAnchors.length === 0 && !oldText.equals(currentText)) throw new Error(`built output unexpectedly changed: ${path}`);
      let expected = oldText.toString("utf8");
      for (const [before, after] of pathAnchors) {
        const count = expected.split(before).length - 1;
        if (count !== 1) throw new Error(`expected one baseline relocation anchor in ${path}, found ${count}: ${before}`);
        expected = expected.replace(before, after);
      }
      if (expected !== currentText.toString("utf8")) throw new Error(`built output differs beyond exact relocation anchors: ${path}`);
    }
  } finally {
    await rm(parityRoot, { recursive: true, force: true });
  }
}

// A fresh build, exactly what `npm run build` produces, into a temp root removed in finally —
// never whatever a previous build left in the checkout's dist/.
const distDir = await mkdtemp(join(tmpdir(), "clawwright-build-output-"));

try {
  await build(distDir);
  await verifyRelocationParity(distDir);

  // Recipe-kit public declarations must remain self-contained and Node-free.
  const recipeDeclarations = ["index", "types", "app", "consumer"];
  for (const name of recipeDeclarations) {
    const declaration = await readFile(resolve(distDir, "recipe-kit", `${name}.d.ts`), "utf8");
    const imports = [...declaration.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]);
    if (/node:|NodeJS|\bany\b/.test(declaration) || imports.some((specifier) =>
      /core\/|\.\.\/runtime|safety|curl/.test(specifier))) {
      throw new Error(`recipe-kit ${name} declaration leaks a private or Node-dependent type`);
    }
  }
  await readFile(resolve(distDir, "recipe-kit", "index.js"), "utf8");
  process.stderr.write("recipe-kit runtime entry and Node-free declaration graph passed\n");

  const binPath = resolve(distDir, "entry", "bin.js");
  const firstLine = (await readFile(binPath, "utf8")).split("\n")[0];
  if (firstLine.trim() !== "#!/usr/bin/env node") {
    throw new Error(
      `dist/entry/bin.js must start with "#!/usr/bin/env node" (got: ${JSON.stringify(firstLine)}) — ` +
        "anything else, `env -S` above all, is not executable on a busybox system such as Alpine",
    );
  }
  process.stderr.write("build output starts with a shebang every POSIX system can execute\n");

  // The source tree uses "#src/..." subpath imports (packages/clawwright/package.json's own
  // "imports" map) for readability. dist/ ships with no package.json of its own, so a
  // literal "#src/" specifier surviving into a built file would fail at runtime with
  // ERR_INVALID_MODULE_SPECIFIER / ERR_MODULE_NOT_FOUND — build-framework-package.ts's
  // rewriteSpecifiers must resolve every one of these down to a plain relative path first.
  const distEntries = await readdir(distDir, { recursive: true });
  for (const relPath of distEntries) {
    if (!relPath.endsWith(".js")) continue;
    const content = await readFile(resolve(distDir, relPath), "utf8");
    if (content.includes('"#src/') || content.includes("'#src/")) {
      throw new Error(`dist/${relPath} still contains a "#src/" subpath-import specifier — it must be rewritten to a plain relative path before shipping`);
    }
  }
  process.stderr.write('build output carries no unresolved "#src/" subpath-import specifiers\n');
} finally {
  await rm(distDir, { recursive: true, force: true });
}
