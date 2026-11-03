// Builds packages/clawwright/ into a publishable npm package.
//
// This repo's own ./clawwright runs the framework's TypeScript directly, no build step —
// but Node refuses to type-strip anything it loads from inside node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING, confirmed by actually installing the raw
// .ts sources), so installed-as-dependency needs one. Node strips types for the JS build;
// tsgo emits the declaration graph; both use published .js import paths.
//
// Output goes to packages/clawwright/dist/ by default — git-ignored, regenerated on demand, never
// hand-edited. `build(outDir)` takes another root (the build-output check builds into an OS
// temp dir so running a check never writes into the checkout); executing this file directly
// (`npm run build`, the package's prepack) builds into the default.

import { readdir, readFile, writeFile, mkdir, rm, copyFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const frameworkDir = resolve(toolsDir, "../packages/clawwright");
const distDir = resolve(frameworkDir, "dist");
const declarationConfig = resolve(frameworkDir, "tsconfig.declaration.json");
const tsgo = resolve(frameworkDir, "../../node_modules/@typescript/native-preview/bin/tsgo");

async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(full)));
      continue;
    }
    if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

/** Only rewrites the extension inside a quoted static/dynamic import/export specifier —
 *  never comments or unrelated strings, so this isn't a blanket ".ts" -> ".js" replace.
 *  Also resolves "#src/..." subpath imports (packages/clawwright/package.json's own "imports"
 *  map, source-tree only) down to a plain relative path — dist/ ships with no package.json
 *  of its own, so nothing in it can rely on "#src/" resolving at runtime. */
function rewriteSpecifiers(code: string, fileDir: string, sourceRoot = frameworkDir): string {
  return code.replace(
    /((?:from|import)\s*\(?\s*["'])(\.[^"']+|#src\/[^"']+)\.ts(["'])/g,
    (_match, prefix: string, path: string, suffix: string) => {
      if (path.startsWith("#src/")) {
        const target = resolve(sourceRoot, path.slice("#src/".length));
        const rel = relative(fileDir, target).replaceAll("\\", "/");
        return `${prefix}${rel.startsWith(".") ? rel : `./${rel}`}.js${suffix}`;
      }
      return `${prefix}${path}.js${suffix}`;
    },
  );
}

/** Rewrites generated declaration imports to published JavaScript paths. */
function rewriteDeclarationSpecifiers(code: string, fileDir: string, outDir: string): string {
  return rewriteSpecifiers(code, fileDir, outDir);
}

/** Runs the repository's existing tsgo to emit the declaration graph. */
function emitDeclarations(outDir: string): void {
  const result = spawnSync(process.execPath, [tsgo, "--project", declarationConfig, "--outDir", outDir], {
    cwd: resolve(frameworkDir, "../.."),
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0) {
    const stdout = result.stdout?.toString() ?? "";
    const stderr = result.stderr?.toString() ?? "";
    if (stdout !== "") process.stderr.write(stdout);
    if (stderr !== "") process.stderr.write(stderr);
    const detail = result.error?.message ??
      (result.status === null ? "the process did not exit normally" : `exit code ${result.status}`);
    throw new Error(`tsgo declaration build failed: ${detail}`);
  }
}

/** Applies publication path rewrites to every emitted declaration. */
async function rewriteDeclarations(outDir: string): Promise<void> {
  const files = await collectFiles(outDir, ".d.ts");
  for (const file of files) {
    const source = await readFile(file, "utf8");
    await writeFile(file, rewriteDeclarationSpecifiers(source, dirname(file), outDir), "utf8");
  }
}

/** Collects files ending in `suffix` below `dir`. */
async function collectFiles(dir: string, suffix: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full, suffix)));
    } else if (entry.name.endsWith(suffix)) {
      files.push(full);
    }
  }
  return files;
}

/** Builds the package into `outDir` (default packages/clawwright/dist/), replacing whatever is there. */
export async function build(outDir: string = distDir): Promise<void> {
  outDir = resolve(outDir);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  emitDeclarations(outDir);
  await rewriteDeclarations(outDir);

  const files = await collectTsFiles(frameworkDir);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const stripped = stripTypeScriptTypes(source, { mode: "strip" });
    const rewritten = rewriteSpecifiers(stripped, dirname(file));
    const rel = relative(frameworkDir, file).replace(/\.ts$/, ".js");
    const outFile = resolve(outDir, rel);
    await mkdir(dirname(outFile), { recursive: true });

    // The shebang travels unchanged (bin.ts's own comment says why): this compiled bin.js
    // dynamically imports the CONSUMER's own app.ts at runtime, and the explicit
    // type-stripping flag keeps loading deterministic across supported Node 24 releases.
    await writeFile(outFile, rewritten, "utf8");
  }

  await copyFile(resolve(frameworkDir, "docker-compose.yml"), resolve(outDir, "docker-compose.yml"));
  await copyFile(resolve(frameworkDir, ".env.example"), resolve(outDir, ".env.example"));

  process.stderr.write(`built ${files.length} file(s) into ${outDir}\n`);
}

// Only when executed directly (`npm run build`, prepack) — importing this module builds nothing.
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  await build();
}
