import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Context } from "../../core/context.ts";
import { collectPortableRecipeFiles } from "../../security/privacy/recipe-portable-content.ts";
import { filesFile, deploymentDir } from "../deployment.ts";
import { assertTargetContained } from "./target-boundary.ts";
import { syncFileTree } from "./files.ts";

export type FileMode = "mirror" | "overlay";
export interface FileDeclaration { readonly source: string; readonly target: string; readonly mode: FileMode }
export interface FilesLedger { readonly version: 1; readonly targets: Readonly<Record<string, readonly string[]>> }
export interface FilesPlanEntry extends FileDeclaration {
  readonly sourceDirectory: string; readonly targetDirectory: string; readonly files: readonly string[];
  readonly actual: readonly string[]; readonly owned: readonly string[]; readonly removals: readonly string[];
}
export interface FilesPlan {
  readonly entries: readonly FilesPlanEntry[];
  readonly retired: readonly { target: string; directory: string; files: readonly string[]; actual: readonly string[] }[];
  readonly warnings: readonly string[]; readonly ledgerPath: string; readonly previous: FilesLedger;
}
const VERSION = 1;
function safeRelative(value: string): boolean {
  if (!value || value.includes("\\") || isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const reserved = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== ".."
    && ![...part].some((ch) => { const n = ch.codePointAt(0)!; return n < 32 || n === 127 || ":*?\"<>|".includes(ch); })
    && !/[. ]$/.test(part) && !reserved.test(part));
}
function overlaps(a: string, b: string): boolean {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}
function validateTarget(target: string): void {
  if (overlaps(target, "clawwright-files.json")) throw new Error(`target overlaps files ledger: ${target}`);
  const parts = target.split("/");
  if (parts[0].toLowerCase() === "workspace" && (parts.length === 1 || /^mcp-/i.test(parts[1]))) throw new Error(`target overlaps reserved workspace/MCP subtree: ${target}`);
}
export function parseFilesDeclaration(raw: unknown): FileDeclaration[] {
  if (!Array.isArray(raw)) throw new Error("files declaration must be an array");
  const result = raw.map((value, index): FileDeclaration => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`files[${index}] must be an object`);
    const row = value as Record<string, unknown>;
    if (typeof row.source !== "string" || !safeRelative(row.source)) throw new Error(`files[${index}].source must be a portable relative path`);
    if (typeof row.target !== "string" || !safeRelative(row.target)) throw new Error(`files[${index}].target must be a portable relative path`);
    if (row.mode !== "mirror" && row.mode !== "overlay") throw new Error(`files[${index}].mode must be mirror or overlay`);
    validateTarget(row.target);
    return { source: row.source, target: row.target, mode: row.mode };
  });
  for (let i = 0; i < result.length; i++) for (let j = i + 1; j < result.length; j++) {
    if (overlaps(result[i].target, result[j].target)) throw new Error(`files targets overlap: ${result[i].target} and ${result[j].target}`);
  }
  return result;
}
export function parseFilesLedger(text: string): FilesLedger {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value) || (value as {version?: unknown}).version !== VERSION) throw new Error("invalid files ledger");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("invalid files ledger record");
  const records = (value as {targets?: unknown}).targets;
  if (records === null || typeof records !== "object" || Array.isArray(records)) throw new Error("invalid files ledger targets");
  const targets = Object.create(null) as Record<string, unknown>, keys = Object.keys(records);
  for (const target of keys) {
    if (!safeRelative(target)) throw new Error(`invalid target in files ledger: ${target}`);
    validateTarget(target);
    const paths = (records as Record<string, unknown>)[target];
    if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string" && safeRelative(path))) throw new Error(`invalid owned paths for ${target}`);
    targets[target] = paths;
  }
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (overlaps(keys[i], keys[j])) throw new Error("overlapping targets in files ledger");
    }
  }
  return { version: VERSION, targets: targets as Record<string, string[]> };
}
export async function readFilesLedgerStrict(ctx: Context): Promise<FilesLedger> { return readLedger(ctx, true); }
export async function readFilesLedger(ctx: Context): Promise<FilesLedger> { return readLedger(ctx, false); }
async function readLedger(ctx: Context, strict: boolean): Promise<FilesLedger> {
  const path = `${ctx.settings.dataDir}/clawwright-files.json`;
  const exists = ctx.transport.existsEntry ? await ctx.transport.existsEntry(path) : await ctx.transport.exists(path);
  if (!exists) return { version: VERSION, targets: Object.create(null) as Record<string, readonly string[]> };
  try {
    await assertTargetContained(ctx.transport, ctx.settings.dataDir, [`${ctx.settings.dataDir}/clawwright-files.json`]);
    return parseFilesLedger(await ctx.transport.readFile(path));
  }
  catch (error) {
    if (strict) throw new Error(`${path} is present but is not a valid ownership ledger: ${(error as Error).message}`);
    return { version: VERSION, targets: Object.create(null) as Record<string, readonly string[]> };
  }
}
async function declarations(): Promise<{ rows: FileDeclaration[]; source: Map<string, {dir: string; files: string[]}>; warnings: string[] }> {
  const path = filesFile();
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") raw = []; else throw new Error(`${path}: ${(error as Error).message}`); }
  const rows = parseFilesDeclaration(raw), base = resolve(deploymentDir()), realBase = await realpath(base);
  const source = new Map<string, {dir: string; files: string[]}>(), warnings: string[] = [];
  for (const row of rows) {
    const dir = resolve(base, ...row.source.split("/"));
    const relativePath = relative(base, dir);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error(`source escapes deployment: ${row.source}`);
    const stat = await lstat(dir), canonical = await realpath(dir);
    if (!stat.isDirectory() || (canonical !== realBase && !canonical.startsWith(realBase + sep))) throw new Error(`source must be a directory inside deployment: ${row.source}`);
    const own = await collectPortableRecipeFiles(dir);
    const ancestorRoots: string[] = [];
    let cursor = resolve(dir, "..");
    while (cursor === base || cursor.startsWith(base + sep)) {
      try {
        await lstat(resolve(cursor, "recipe.json"));
        ancestorRoots.push(cursor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (cursor === base) break;
      cursor = resolve(cursor, "..");
    }
    const selected = new Set(own.files);
    for (const recipeRoot of ancestorRoots) {
      const prefix = relative(recipeRoot, dir).replaceAll("\\", "/");
      const ancestor = await collectPortableRecipeFiles(recipeRoot);
      const selectedByAncestor = new Set<string>();
      for (const file of ancestor.files) {
        if (file.startsWith(`${prefix}/`)) selectedByAncestor.add(file.slice(prefix.length + 1));
      }
      for (const path of selected) {
        if (!selectedByAncestor.has(path)) selected.delete(path);
      }
      for (const exclusion of ancestor.excluded) {
        if (exclusion.path === prefix || exclusion.path.startsWith(`${prefix}/`) || prefix.startsWith(`${exclusion.path}/`)) {
          const recipePath = relative(base, recipeRoot).replaceAll("\\", "/");
          const excludedPath = recipePath === "" ? exclusion.path : `${recipePath}/${exclusion.path}`;
          warnings.push(`${excludedPath}: ${exclusion.reason}`);
        }
      }
    }
    const files = new Set<string>();
    for (const path of selected) {
      if (!safeRelative(path)) throw new Error(`source has non-portable file name: ${path}`);
      const folded = path.toLocaleLowerCase("en-US");
      if (files.has(folded)) throw new Error(`source has case-colliding file paths: ${path}`);
      files.add(folded);
    }
    for (const path of files) {
      const segments = path.split("/");
      for (let i = 1; i < segments.length; i += 1) {
        const parent = segments.slice(0, i).join("/").toLocaleLowerCase("en-US");
        if (files.has(parent)) throw new Error(`source has file/directory shape conflict at ${segments.slice(0, i).join("/")}`);
      }
    }
    const canonicalSegments = new Map<string, string>();
    for (const file of selected) {
      const segments = file.split("/");
      for (let index = 0; index < segments.length; index += 1) {
        const spelling = segments.slice(0, index + 1).join("/");
        const folded = spelling.toLocaleLowerCase("en-US");
        const earlier = canonicalSegments.get(folded);
        if (earlier !== undefined && earlier !== spelling) throw new Error(`source has case-colliding path segments: ${earlier} and ${spelling}`);
        canonicalSegments.set(folded, spelling);
      }
    }
    source.set(row.target, { dir, files: [...selected] });
    warnings.push(...own.excluded.map((entry) => `${row.source}/${entry.path}: ${entry.reason}`));
  }
  return { rows, source, warnings };
}
function targetPath(ctx: Context, target: string): string { return `${ctx.settings.dataDir}/${target}`; }
export async function planFiles(ctx: Context): Promise<FilesPlan> {
  const { rows, source, warnings } = await declarations(), previous = await readFilesLedgerStrict(ctx);
  const names = new Map(rows.map((row) => [row.target.toLowerCase(), row.target]));
  const entries: FilesPlanEntry[] = [];
  for (const row of rows) {
    const directory = targetPath(ctx, row.target), actual = await ctx.transport.listFiles(directory);
    const owned = Object.hasOwn(previous.targets, row.target) ? previous.targets[row.target] : undefined;
    const ownedPaths = owned ?? [], files = source.get(row.target)!.files;
    const eligible = row.mode === "mirror" ? actual : actual.filter((path) => ownedPaths.includes(path));
    entries.push({ ...row, sourceDirectory: source.get(row.target)!.dir, targetDirectory: directory, files, actual, owned: ownedPaths, removals: eligible.filter((path) => !files.includes(path)) });
  }
  const retired: {target: string; directory: string; files: readonly string[]; actual: readonly string[]}[] = [];
  for (const [target, files] of Object.entries(previous.targets)) {
    const same = names.get(target.toLowerCase());
    if (same && same !== target) throw new Error(`case-only target rename from ${target} to ${same} is refused; retire it first`);
    if (same) continue;
    if (rows.some((row) => overlaps(target, row.target))) throw new Error(`retired target ${target} overlaps a new target; retire it in an intermediate apply`);
    const directory = targetPath(ctx, target);
    retired.push({ target, directory, files, actual: await ctx.transport.listFiles(directory) });
  }
  const ledgerPath = `${ctx.settings.dataDir}/clawwright-files.json`;
  const checks = [ledgerPath, ...entries.flatMap((entry) => [entry.targetDirectory, ...entry.files.map((f) => `${entry.targetDirectory}/${f}`), ...entry.removals.map((f) => `${entry.targetDirectory}/${f}`)]), ...retired.flatMap((entry) => [entry.directory, ...entry.files.map((f) => `${entry.directory}/${f}`)])];
  await assertTargetContained(ctx.transport, ctx.settings.dataDir, checks);
  return { entries, retired, warnings, ledgerPath, previous };
}
export async function applyFiles(ctx: Context, suppliedPlan?: FilesPlan): Promise<void> {
  const plan = suppliedPlan ?? await planFiles(ctx);
  const pending = new Map(Object.entries(plan.previous.targets));
  const publish = async (): Promise<void> => {
    await ctx.transport.writeFile(plan.ledgerPath, `${JSON.stringify({ version: VERSION, targets: Object.fromEntries(pending) }, null, 2)}\n`);
  };
  for (const entry of plan.entries) {
    await syncFileTree(ctx.transport, ctx.settings.dataDir, entry.sourceDirectory, entry.targetDirectory, entry.files, entry.mode === "overlay" ? entry.owned : undefined);
    pending.set(entry.target, entry.files);
    await publish();
  }
  for (const entry of plan.retired) {
    for (const path of entry.files) {
      if (!entry.actual.includes(path)) continue;
      if (!(await ctx.transport.existsEntry?.(`${entry.directory}/${path}`) ?? await ctx.transport.exists(`${entry.directory}/${path}`))) continue;
      const current = await ctx.transport.listFiles(entry.directory);
      if (current.includes(path)) await ctx.transport.remove(`${entry.directory}/${path}`);
    }
    await ctx.transport.removeEmptyTree?.(entry.directory);
    pending.delete(entry.target);
    await publish();
  }
  await publish();
}
export interface FilesDrift { readonly target: string; readonly missing: string[]; readonly different: string[]; readonly stale: string[] }
export interface FilesContentState { readonly expected: Readonly<Record<string, Uint8Array>>; readonly actual: Readonly<Record<string, Uint8Array>>; readonly expectedPaths: readonly string[]; readonly actualPaths: readonly string[]; readonly ownedPaths?: readonly string[]; readonly mode: FileMode }
export function compareFilesDrift(state: FilesContentState): Omit<FilesDrift, "target"> {
  const missing: string[] = [], different: string[] = [];
  for (const path of state.expectedPaths) {
    const left = Object.hasOwn(state.expected, path) ? state.expected[path] : undefined;
    const right = Object.hasOwn(state.actual, path) ? state.actual[path] : undefined;
    if (right === undefined) missing.push(path);
    else if (left !== undefined && !Buffer.from(left).equals(Buffer.from(right))) different.push(path);
  }
  const candidates = state.mode === "mirror" ? state.actualPaths : state.actualPaths.filter((path) => state.ownedPaths?.includes(path));
  return { missing, different, stale: candidates.filter((path) => !state.expectedPaths.includes(path)).sort() };
}
export async function inspectFilesDrift(ctx: Context): Promise<FilesDrift[]> {
  const { rows, source } = await declarations(), ledger = await readFilesLedger(ctx), results: FilesDrift[] = [];
  for (const row of rows) {
    const directory = targetPath(ctx, row.target), actualPaths = await ctx.transport.listFiles(directory), expectedPaths = source.get(row.target)!.files;
    await assertTargetContained(ctx.transport, ctx.settings.dataDir, [directory, ...expectedPaths.map((path) => `${directory}/${path}`)]);
    const expected = Object.create(null) as Record<string, Uint8Array>;
    const actual = Object.create(null) as Record<string, Uint8Array>;
    for (const path of expectedPaths) {
      expected[path] = await readFile(resolve(source.get(row.target)!.dir, ...path.split("/")));
      if (actualPaths.includes(path)) {
        const remotePath = `${directory}/${path}`;
        if (ctx.transport.description === "local") {
          actual[path] = await readFile(remotePath);
        } else {
          const encoded = await ctx.transport.exec("base64", [remotePath], { allowFailure: true });
          if (encoded.code !== 0) throw new Error(`could not read binary file ${remotePath}: ${(encoded.stderr || encoded.stdout).trim()}`);
          actual[path] = Buffer.from(encoded.stdout.replaceAll(/\s/g, ""), "base64");
        }
      }
    }
    const ownedPaths = Object.hasOwn(ledger.targets, row.target) ? ledger.targets[row.target] : undefined;
    results.push({ target: row.target, ...compareFilesDrift({ expected, actual, expectedPaths, actualPaths, ownedPaths, mode: row.mode }) });
  }
  return results;
}
