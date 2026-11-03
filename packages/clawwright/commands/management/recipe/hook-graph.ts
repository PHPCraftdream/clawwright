import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** Hash a hook and every relative or package-internal (`#specifier`) module it statically
 *  reaches. */
interface ImportSpan { readonly start: number; readonly end: number; readonly specifier: string }

interface HookToken {
  readonly kind: "identifier" | "string" | "template" | "punctuation";
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** Tokenize enough JavaScript/TypeScript to distinguish module syntax from comments and
 *  literals. Template substitutions are tokenized as code too. */
function hookTokens(source: string): HookToken[] {
  const tokens: HookToken[] = [];
  const identifierStart = /[\p{ID_Start}_$]/u;
  const identifierPart = /[\p{ID_Continue}_$]/u;
  const scanCode = (initial: number, templateExpression = false): number => {
    let index = initial;
    let braceDepth = 0;
    while (index < source.length) {
      const char = source[index] as string;
      if (/\s/u.test(char)) { index += 1; continue; }
      if (char === "/" && source[index + 1] === "/") {
        index += 2;
        while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
        continue;
      }
      if (char === "/" && source[index + 1] === "*") {
        const end = source.indexOf("*/", index + 2);
        if (end < 0) throw new Error("recipe hook contains an unterminated comment; cannot checksum its imports");
        index = end + 2;
        continue;
      }
      if (char === "/") {
        const previous = tokens[tokens.length - 1];
        const regexMayStart = previous === undefined ||
          (previous.kind === "punctuation" && ["(", "{", "[", ",", ":", ";", "=", "!", "?", "&", "|", "+", "-", "*", "%", "~", "^", "<", ">", "=>"].includes(previous.value)) ||
          (previous.kind === "identifier" && ["return", "throw", "case", "delete", "void", "typeof", "yield", "await", "else", "do", "instanceof", "in", "of"].includes(previous.value));
        if (regexMayStart) {
          const start = index++;
          let inClass = false;
          let closed = false;
          while (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
            if (source[index] === "\\") { index += 2; continue; }
            if (source[index] === "[") inClass = true;
            else if (source[index] === "]") inClass = false;
            else if (source[index] === "/" && !inClass) { index += 1; closed = true; break; }
            index += 1;
          }
          if (!closed) throw new Error("recipe hook contains an invalid regular expression; cannot checksum its imports");
          while (index < source.length && identifierPart.test(source[index] as string)) index += 1;
          tokens.push({ kind: "punctuation", value: "<regex>", start, end: index });
          continue;
        }
      }
      if (templateExpression && char === "}" && braceDepth === 0) return index + 1;
      if (char === "'" || char === '"') {
        const start = index++;
        let closed = false;
        while (index < source.length) {
          if (source[index] === "\\") { index += 2; continue; }
          if (source[index] === char) { index += 1; closed = true; break; }
          if (source[index] === "\n" || source[index] === "\r") break;
          index += 1;
        }
        if (!closed) throw new Error("recipe hook contains an invalid string literal; cannot checksum its imports");
        tokens.push({ kind: "string", value: source.slice(start + 1, index - 1), start, end: index });
        continue;
      }
      if (char === "`") {
        const start = index++;
        let interpolated = false;
        let closed = false;
        while (index < source.length) {
          if (source[index] === "\\") { index += 2; continue; }
          if (source[index] === "`") { index += 1; closed = true; break; }
          if (source[index] === "$" && source[index + 1] === "{") {
            interpolated = true;
            index = scanCode(index + 2, true);
            continue;
          }
          index += 1;
        }
        if (!closed) throw new Error("recipe hook contains an unterminated template; cannot checksum its imports");
        tokens.push({ kind: "template", value: interpolated ? "" : source.slice(start + 1, index - 1), start, end: index });
        continue;
      }
      if (identifierStart.test(char)) {
        const start = index++;
        while (index < source.length && identifierPart.test(source[index] as string)) index += 1;
        tokens.push({ kind: "identifier", value: source.slice(start, index), start, end: index });
        continue;
      }
      if (templateExpression && char === "{") braceDepth += 1;
      if (templateExpression && char === "}") braceDepth -= 1;
      const start = index;
      const pair = source.slice(index, index + 2);
      index += ["?.", "=>", "++", "--", "&&", "||", "??", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=", "**", "<<", ">>"].includes(pair) ? 2 : 1;
      tokens.push({ kind: "punctuation", value: source.slice(start, index), start, end: index });
    }
    if (templateExpression) throw new Error("recipe hook contains an unterminated template expression; cannot checksum its imports");
    return index;
  };
  scanCode(0);
  return tokens;
}

/** Find every statically versionable import edge. Unknown dynamic forms fail closed so a
 *  helper cannot silently escape the checksum graph and stay stale in an MCP session. */
function relativeImportSpans(source: string): ImportSpan[] {
  const tokens = hookTokens(source);
  const spans: ImportSpan[] = [];
  const addLiteral = (token: HookToken): void => {
    if (token.kind !== "string" && token.kind !== "template") return;
    if (token.value.includes("\\")) {
      throw new Error("recipe hook uses an escaped import specifier; use a plain literal so its dependency can be versioned");
    }
    if (token.value.startsWith(".") || token.value.startsWith("#")) {
      const quoteLength = token.kind === "template" ? 1 : 1;
      spans.push({ start: token.start + quoteLength, end: token.end - quoteLength, specifier: token.value });
    }
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as HookToken;
    const next = tokens[index + 1];
    if (token.kind !== "identifier") continue;
    if (token.value === "import" && next?.value === "(" && tokens[index - 1]?.value !== "." && tokens[index - 1]?.value !== "?.") {
      let close = index + 2;
      let depth = 0;
      for (; close < tokens.length; close += 1) {
        const current = tokens[close] as HookToken;
        if (current.value === "(") depth += 1;
        else if (current.value === ")") {
          if (depth === 0) break;
          depth -= 1;
        }
      }
      const first = tokens[index + 2];
      const after = tokens[index + 3];
      const literal = first !== undefined && (first.kind === "string" || (first.kind === "template" && first.value !== ""));
      if (close >= tokens.length || !literal || (after !== undefined && after.value !== "," && after.value !== ")")) {
        throw new Error("recipe hook uses a computed dynamic import; use a string literal so its dependency can be versioned");
      }
      addLiteral(first);
      continue;
    }
    if (token.value === "import" && next?.kind === "string" && tokens[index - 1]?.value !== "." && tokens[index - 1]?.value !== "?.") {
      addLiteral(next);
      continue;
    }
    // `from "..."` occurs in static import and export declarations. Tokenization has
    // already removed comments and string contents, so comments cannot mask the edge.
    if (token.value === "from" && next !== undefined && (next.kind === "string" || next.kind === "template")) {
      addLiteral(next);
      continue;
    }
    if (token.value === "require" && next?.value === "(" && tokens[index - 1]?.value !== ".") {
      const argument = tokens[index + 2];
      if (argument?.kind === "string" && argument.value.startsWith(".")) {
        throw new Error("recipe hook uses a relative require(); use ESM imports so its dependency can be versioned");
      }
      if (argument !== undefined && argument.value !== ")" && argument.kind !== "string") {
        throw new Error("recipe hook uses a computed require(); use ESM imports so dependencies can be versioned");
      }
    }
  }
  return spans;
}

/** Nearest `package.json` at or above `path`, never searched for past `boundary` (the
 *  recipe directory): a scope declared outside the recipe is not the recipe's to trust,
 *  and walking past it would let an unrelated ancestor manifest decide where a recipe's
 *  `#specifier` lands. */
async function packageScopeFileWithin(path: string, boundary: string): Promise<string> {
  let directory = dirname(path);
  while (true) {
    const candidate = resolve(directory, "package.json");
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (directory === boundary) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`cannot resolve package import from ${path}: no package.json scope inside the recipe directory ${boundary}`);
}

/** The only conditions a recipe hook actually runs under: plain ESM, under Node, with no
 *  custom `--conditions`. All three are active for that exact shape, so — once every other
 *  key has been rejected — the first key an object declares is the one Node's own resolver
 *  would pick too, and no separate priority order needs reimplementing. */
const SUPPORTED_IMPORT_CONDITIONS = new Set(["node", "import", "default"]);

/** Resolves one `imports` map entry to its string target. Rejects (rather than guesses at)
 *  any condition outside node/import/default, any non-string/non-object target, and an
 *  empty condition object — the checksum cannot promise freshness for a shape it does not
 *  fully understand, so it fails closed instead of silently picking a branch. */
function resolveConditionalTarget(entry: unknown, key: string, packageJsonPath: string): string {
  if (typeof entry === "string") return entry;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`recipe hook package import ${key}: ${packageJsonPath} target must be a string or a {node,import,default} object`);
  }
  const record = entry as Record<string, unknown>;
  const keys = Object.keys(record);
  const unsupported = keys.filter((condition) => !SUPPORTED_IMPORT_CONDITIONS.has(condition));
  if (unsupported.length > 0) {
    throw new Error(
      `recipe hook package import ${key}: ${packageJsonPath} uses unsupported condition(s) ${unsupported.join(", ")} (only node/import/default can be freshness-tracked)`,
    );
  }
  if (keys.length === 0) {
    throw new Error(`recipe hook package import ${key}: ${packageJsonPath} declares an empty condition object`);
  }
  return resolveConditionalTarget(record[keys[0] as string], key, packageJsonPath);
}

function isInside(root: string, path: string): boolean {
  const within = relative(root, path);
  return !within.startsWith("..") && !isAbsolute(within);
}

/** The recipe directory in the same spelling as `fromFile`: Node reports a hook's own URL
 *  realpath'd (macOS /var → /private/var), so a lexical boundary would read the recipe's own
 *  package.json as outside it. */
async function boundaryFor(fromFile: string, recipeDirectory: string): Promise<string> {
  if (isInside(recipeDirectory, fromFile)) return recipeDirectory;
  try {
    const real = await realpath(recipeDirectory);
    if (isInside(real, fromFile)) return real;
  } catch {
    // Unreadable: the lexical boundary stands and the check below refuses.
  }
  return recipeDirectory;
}

// checkoutFrameworkSource (the package's public exports mapped onto checkout sources) lives
// in core/env.ts beside the package's other framework-location knowledge.

export interface PackageImportResolution {
  readonly packageJsonPath: string;
  readonly targetPath: string;
}

/** Resolves a `#specifier` against the nearest package.json `imports` map, reading the
 *  manifest fresh off disk every call. Exported so hook-loader.ts's resolve hook can reuse
 *  the exact same validated resolution instead of Node's own resolver, which caches a
 *  package.json's parsed content per process for its lifetime — the same staleness this
 *  whole loader exists to prevent. A target is accepted only when it's a package-relative
 *  path resolving (even through a symlink) inside the recipe directory; bare specifiers,
 *  absolute paths, and `..` escapes are rejected explicitly. */
export async function resolvePackageImport(specifier: string, fromFile: string, recipeDirectory: string): Promise<PackageImportResolution> {
  const key = specifier.split("?")[0] as string;
  const boundary = await boundaryFor(fromFile, recipeDirectory);
  const packageJsonPath = await packageScopeFileWithin(fromFile, boundary);
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (error) {
    throw new Error(`recipe hook package import ${specifier}: ${packageJsonPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const imports = (manifest as { imports?: unknown } | null)?.imports;
  if (imports === undefined || imports === null || typeof imports !== "object" || Array.isArray(imports)) {
    throw new Error(`recipe hook package import ${specifier}: ${packageJsonPath} declares no "imports" map`);
  }
  const entry = (imports as Record<string, unknown>)[key];
  if (entry === undefined) {
    throw new Error(
      `recipe hook package import ${specifier}: ${packageJsonPath} has no exact "imports" entry for ${key} (subpath patterns are not supported for freshness tracking)`,
    );
  }
  const target = resolveConditionalTarget(entry, key, packageJsonPath);
  const packageDirectory = dirname(packageJsonPath);

  if (/^[A-Za-z]:[\\/]/.test(target) || target.startsWith("/") || target.startsWith("\\")) {
    throw new Error(`recipe hook package import ${specifier}: target "${target}" is an absolute path; only paths inside the recipe directory are supported`);
  }
  if (!target.startsWith("./") && !target.startsWith("../")) {
    throw new Error(`recipe hook package import ${specifier}: target "${target}" is a bare package specifier; only relative paths inside the recipe directory are supported`);
  }

  const targetPath = resolve(packageDirectory, target);
  const withinRecipe = relative(boundary, targetPath);
  if (withinRecipe.startsWith("..") || isAbsolute(withinRecipe)) {
    throw new Error(`recipe hook package import ${specifier}: target "${target}" escapes the recipe directory`);
  }

  try {
    const [realTarget, realRecipe] = await Promise.all([realpath(targetPath), realpath(recipeDirectory)]);
    const realWithinRecipe = relative(realRecipe, realTarget);
    if (realWithinRecipe.startsWith("..") || isAbsolute(realWithinRecipe)) {
      throw new Error(`recipe hook package import ${specifier}: target "${target}" resolves through a symlink outside the recipe directory`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Missing target: left for Node to report when the hook is actually imported.
  }

  return { packageJsonPath, targetPath };
}

/** Hash a hook and its local import graph — relative imports and package-internal
 *  `#specifier` imports alike; missing files are left for Node to report. */
export async function dependencyGraphChecksum(entryPath: string): Promise<string> {
  // Every hook phase file resolves as resolve(recipe.directory, "<phase>.ts"), so the
  // entry's own directory is always the recipe directory — the boundary every
  // `#specifier` resolution below must stay inside.
  const recipeDirectory = dirname(entryPath);
  const files = new Map<string, string>();
  const queue = [entryPath];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (files.has(current)) continue;
    let content: string;
    try {
      content = await readFile(current, "utf8");
    } catch {
      continue;
    }
    files.set(current, content);
    for (const span of relativeImportSpans(content)) {
      if (span.specifier.startsWith("#")) {
        const { packageJsonPath, targetPath } = await resolvePackageImport(span.specifier, current, recipeDirectory);
        if (!files.has(packageJsonPath)) queue.push(packageJsonPath);
        if (!files.has(targetPath)) queue.push(targetPath);
        continue;
      }
      const dependency = resolve(dirname(current), span.specifier.split(/[?#]/, 1)[0] as string);
      if (!files.has(dependency)) queue.push(dependency);
    }
  }
  const graph = [...files.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, content]) => `${path}\n${content}`)
    .join("\u0000");
  return createHash("sha256").update(graph).digest("hex");
}
