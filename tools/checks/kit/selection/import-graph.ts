// Static import graph of the repository's TypeScript, used to select the *.check.ts files
// affected by a set of changed files (chunk of "check --related"). Parsing is conservative:
// comments and string/template literal bodies are blanked out first, so import-shaped text
// in prose can never produce a specifier.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, posix, sep } from "node:path";

/** Repo root, derived from this module's own location (tools/checks/kit/selection/ is 4 below it). */
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url)).replace(/[\\/]$/, "");

// --- parsing ----------------------------------------------------------------------------------

/** Blanks the contents of // and /* *\/ comments and of strings/template literals, keeping
 *  length, so the import regexes see only real code. A string ends at its matching unescaped
 *  quote; a template at an unescaped backtick. `${...}` interiors are treated as ordinary
 *  code after the template-close scan (a nested backtick inside an interpolation would close
 *  the template early) — accepted conservatism, documented; the scanner never crashes. */
export function stripNonCode(source: string): string {
  const out = source.split("");
  let at = 0;
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i += 1) if (out[i] !== "\n") out[i] = " ";
  };
  while (at < source.length) {
    const char = source[at];
    if (char === "/" && source[at + 1] === "/") {
      const end = source.indexOf("\n", at);
      const stop = end === -1 ? source.length : end;
      blank(at, stop);
      at = stop;
    } else if (char === "/" && source[at + 1] === "*") {
      const end = source.indexOf("*/", at + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(at, stop);
      at = stop;
    } else if (char === "'" || char === '"' || char === "`") {
      let scan = at + 1;
      while (scan < source.length) {
        if (source[scan] === "\\") scan += 2;
        else if (source[scan] === char) break;
        else scan += 1;
      }
      blank(at + 1, Math.min(scan, source.length));
      at = Math.min(scan + 1, source.length);
    } else at += 1;
  }
  return out.join("");
}

/** All import specifiers in `source` (static `import`/`export ... from`, dynamic
 *  `import("...")`, bare `import "..."`), in order, deduplicated. Matching happens on the
 *  stripped text (so fake imports in prose never match); the specifier itself is read back
 *  from the original at the match's index — stripping preserves length. */
export function parseImportSpecifiers(source: string): string[] {
  const code = stripNonCode(source);
  const specifiers: string[] = [];
  const add = (found: RegExpExecArray): void => {
    let specifier: string;
    if (found[1] !== undefined) {
      // Dynamic form: group 1 is the (blanked) interior — recover it by index from the original.
      const interiorStart = found.index + found[0].indexOf('"') + 1;
      specifier = source.slice(interiorStart, interiorStart + found[1].length);
    } else {
      // Static forms: found[0] ends with quote + blanked interior + quote; walk back over it.
      const closingQuote = found.index + found[0].length - 1;
      let openingQuote = closingQuote - 1;
      while (openingQuote > found.index && code[openingQuote] === " ") openingQuote -= 1;
      specifier = source.slice(openingQuote + 1, closingQuote);
    }
    if (!specifiers.includes(specifier)) specifiers.push(specifier);
  };
  // The gap between import/export and from may span lines (multi-name imports); comments and
  // string bodies are already blanked, so a newline there is real code structure.
  const fromRe = /(?:^|[;\s}])(?:import|export)[^"'`]*?from\s*["'][^"'\n]*["']/g;
  const dynamicRe = /import\s*\(\s*["']([^"'\n]*)["']\s*\)/g;
  const bareRe = /(?:^|[;\s}])import\s*["'][^"'\n]*["']/g;
  for (const re of [fromRe, dynamicRe, bareRe]) {
    re.lastIndex = 0;
    for (let found = re.exec(code); found !== null; found = re.exec(code)) add(found);
  }
  return specifiers;
}

// --- resolution -------------------------------------------------------------------------------

export interface AliasMap {
  readonly from: string;
  readonly to: string;
}

interface AliasSource {
  readonly packageJsonPath: string;
  readonly importPathFromRoot: string;
}

/** Alias sources, rooted at REPO_ROOT: the root package.json and the framework package's own. */
const ALIAS_SOURCES: readonly AliasSource[] = [
  { packageJsonPath: "package.json", importPathFromRoot: "" },
  { packageJsonPath: "packages/clawwright/package.json", importPathFromRoot: "packages/clawwright/" },
];

let aliasCache: readonly AliasMap[] | undefined;

/** Reads the "imports" alias maps from both package.json files; cached. Throws if absent —
 *  the alias families are part of the repository contract. */
export function loadAliases(): readonly AliasMap[] {
  if (aliasCache !== undefined) return aliasCache;
  const maps: AliasMap[] = [];
  for (const source of ALIAS_SOURCES) {
    const raw = JSON.parse(readFileSync(join(REPO_ROOT, source.packageJsonPath), "utf8")) as {
      imports?: Record<string, string>;
    };
    for (const [from, to] of Object.entries(raw.imports ?? {})) {
      maps.push({ from: from.replace(/\*$/, ""), to: posix.join(source.importPathFromRoot, to.replace(/^\.\//, "").replace(/\*$/, "")) });
    }
  }
  aliasCache = maps;
  return maps;
}

/** Pure specifier resolution with an injectable existence check (defaults to the real
 *  filesystem): returns the repo-root-relative POSIX path the specifier denotes, or null
 *  when it is a bare package specifier or the target does not exist. An extensionless
 *  target gets ".ts" appended (the repo writes extensions, but tolerate both spellings). */
export function resolveSpecifier(
  specifier: string,
  fromFile: string,
  exists: (repoRelativePath: string) => boolean = (path) => existsSync(join(REPO_ROOT, path)),
): string | null {
  let target: string | null = null;
  if (specifier.startsWith("#")) {
    for (const alias of loadAliases()) {
      if (specifier.startsWith(alias.from)) {
        target = posix.join(alias.to, specifier.slice(alias.from.length));
        break;
      }
    }
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    target = posix.normalize(posix.join(posix.dirname(fromFile.split(sep).join("/")), specifier));
  }
  // Bare specifiers (node:, json5, npm packages) resolve to nothing.
  if (target === null) return null;
  if (exists(target)) return target;
  if (exists(target + ".ts")) return target + ".ts";
  return null;
}

// --- graph ------------------------------------------------------------------------------------

export type ImportGraph = ReadonlyMap<string, readonly string[]>;

/** Recursively lists *.ts files under `rootDir` (repo-relative POSIX paths), skipping nothing
 *  except dot-directories. */
function listTypeScriptFiles(rootDir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(REPO_ROOT, rootDir), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const relative = posix.join(rootDir, entry.name);
    if (entry.isDirectory()) listTypeScriptFiles(relative, out);
    else if (entry.name.endsWith(".ts")) out.push(relative);
  }
  return out;
}

/** Parses every *.ts file under the default tooling and product roots and maps each file to the repo-relative files it
 *  imports (unresolvable specifiers are dropped). Explicit rootDir keeps its single-root behavior. */
export function buildImportGraph(rootDir?: string): ImportGraph {
  const graph = new Map<string, string[]>();
  const roots = rootDir === undefined ? ["tools", "packages/clawwright"] : [rootDir];
  for (const root of roots) for (const file of listTypeScriptFiles(root)) {
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    const targets: string[] = [];
    for (const specifier of parseImportSpecifiers(source)) {
      const resolved = resolveSpecifier(specifier, file);
      if (resolved !== null && !targets.includes(resolved)) targets.push(resolved);
    }
    graph.set(file, targets);
  }
  return graph;
}

/** Inverts the graph: file -> the files that import it. */
export function importersOf(graph: ImportGraph): ReadonlyMap<string, readonly string[]> {
  const inverted = new Map<string, string[]>();
  for (const [file, targets] of graph) {
    for (const target of targets) {
      const list = inverted.get(target) ?? [];
      if (!list.includes(file)) list.push(file);
      inverted.set(target, list);
    }
  }
  return inverted;
}

export interface RelatedCheck {
  /** The *.check.ts file, repo-relative. */
  readonly file: string;
  /** BFS depth from the changed file (1 = the check imports a changed file directly). */
  readonly depth: number;
  /** The changed file that reaches this check. */
  readonly via: string;
}

export interface RelatedSelection {
  readonly checks: readonly RelatedCheck[];
  /** Plain set of reachable *.check.ts files, for a later meta-check. */
  readonly reachableChecks: ReadonlySet<string>;
}

/** BFS from the changed files over the inverted graph; selects every *.check.ts under
 *  tools/checks/ that transitively imports a changed file, with the changed file and the
 *  chain depth as the reason. */
export function selectRelatedChecks(graph: ImportGraph, changedFiles: readonly string[]): RelatedSelection {
  const inverted = importersOf(graph);
  const frontier = new Map<string, { via: string; depth: number }>();
  const checks = new Map<string, RelatedCheck>();
  for (const changed of changedFiles) {
    frontier.set(changed, { via: changed, depth: 0 });
    // A changed check file must run even when nothing else imports it — the diff is the reason.
    if (changed.endsWith(".check.ts") && changed.startsWith("tools/checks/")) {
      checks.set(changed, { file: changed, depth: 0, via: changed });
    }
  }
  let current = [...frontier.keys()];
  for (let depth = 1; current.length > 0; depth += 1) {
    const next: string[] = [];
    for (const file of current) {
      const origin = frontier.get(file);
      if (origin === undefined) continue;
      for (const importer of inverted.get(file) ?? []) {
        if (frontier.has(importer)) continue;
        frontier.set(importer, origin);
        next.push(importer);
        if (importer.endsWith(".check.ts") && importer.startsWith("tools/checks/")) {
          checks.set(importer, { file: importer, depth, via: origin.via });
        }
      }
    }
    current = next;
  }
  return {
    checks: [...checks.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.depth - b.depth)),
    reachableChecks: new Set(checks.keys()),
  };
}
