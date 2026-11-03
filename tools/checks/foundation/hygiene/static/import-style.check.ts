// A file under packages/clawwright must not mix `#src/` subpath imports (package.json's own
// "imports" map, framework-root-relative) with `../` relative imports — one style per file,
// so a reader does not have to hold two path grammars for the same module.

import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, finish } from "#checks/kit/harness.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const frameworkRoot = resolve(repoRoot, "packages", "clawwright");

async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

// A static or re-export `from "..."` specifier — the only place an import style shows up.
const FROM_SPECIFIER = /\bfrom\s+["']([^"']+)["']/g;

function importStyles(source: string): { hasSrcStyle: boolean; hasRelativeStyle: boolean } {
  let hasSrcStyle = false;
  let hasRelativeStyle = false;
  for (const match of source.matchAll(FROM_SPECIFIER)) {
    const specifier = match[1];
    if (specifier.startsWith("#src/")) hasSrcStyle = true;
    else if (specifier.startsWith("../")) hasRelativeStyle = true;
  }
  return { hasSrcStyle, hasRelativeStyle };
}

const files = await walk(frameworkRoot);
const offenders: string[] = [];
for (const file of files.sort()) {
  const source = await readFile(file, "utf8");
  const { hasSrcStyle, hasRelativeStyle } = importStyles(source);
  if (hasSrcStyle && hasRelativeStyle) offenders.push(relative(repoRoot, file).replaceAll("\\", "/"));
}

check("no file under packages/clawwright mixes #src/ and ../ imports", offenders, []);
finish("import style");
