// The recipe portable-content policy: what may LEAVE the recipe's directory. Each carrier
// gets its own verb: `recipe import` EXCLUDES; set build EXCLUDES (service/checksums.ts
// reads this walker); provision-agent's workspace mirror EXCLUDES and WARNS; deploy REFUSES
// while any private file (declared or sensitive-named) exists in the recipes tree or synced
// config/.
//
// SENSITIVE_RECIPE_NAME is a generic credential heuristic; privateFiles is the app's own
// declaration, matched LITERALLY, never as a glob. declaredPrivateFiles fails closed
// (unreadable/invalid stops the carrier); an absent manifest is honest.
//
// Symlink containment: a link resolving OUTSIDE the recipe is refused, including the walk
// ROOT. The policy applies to both the logical and resolved path (a public-named link to a
// private target is still held back), and directory links are walked in their CANONICAL
// context so a declaration can't be dodged via an alias.

import { access, lstat, readdir, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { warn } from "../../core/io/log.ts";
import { declaredPrivateFiles } from "../../service/recipe.ts";

/** Name-shape heuristic over the framework's own credential conventions. */
export const SENSITIVE_RECIPE_NAME = /(^|[\\/])(?:\.env(?:\..*)?|secrets(?:[\\/]|$)|.*\.token$|.*\.secrets\.env$)/i;

/** The declared privateFiles of one recipe directory, an honest empty list when there's no
 *  manifest at all. Otherwise as strict as declaredPrivateFiles: unreadable/invalid throws. */
export async function declaredPortablePrivateFiles(recipeDirectory: string, readRecipeManifest?: (path: string) => Promise<Buffer | undefined>): Promise<string[]> {
  const manifest = resolve(recipeDirectory, "recipe.json");
  let raw: string;
  if (readRecipeManifest !== undefined) {
    const bytes = await readRecipeManifest(manifest).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`could not read ${manifest}: ${(error as Error).message}`);
    });
    if (bytes === undefined) return [];
    raw = bytes.toString("utf8");
  } else {
    try {
      await access(manifest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return declaredPrivateFiles(recipeDirectory);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`could not parse ${manifest}: ${(error as Error).message}`); }
  if (parsed === null || typeof parsed !== "object") throw new Error(`${manifest} must contain an object`);
  const declared = (parsed as { privateFiles?: unknown }).privateFiles;
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) throw new Error(`${manifest}: privateFiles must be an array of recipe-relative paths`);
  return declared.map((entry) => {
    if (typeof entry !== "string" || entry === "") throw new Error(`${manifest}: privateFiles entries must be non-empty strings`);
    if (entry.includes("\\")) throw new Error(`${manifest}: privateFiles entries are /-separated paths relative to the recipe directory: ${entry}`);
    if (entry.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) throw new Error(`${manifest}: privateFiles entries must stay inside the recipe directory: ${entry}`);
    return entry;
  });
}

/** The ONE path-boundary matcher over a privateFiles declaration. Literal matching only —
 *  an entry matches itself and everything under it, and never behaves like a glob. */
export function excludesPortablePath(relativePath: string, declared: readonly string[]): boolean {
  return declared.some((entry) => relativePath === entry || relativePath.startsWith(`${entry}/`));
}

/** Walks a recipe tree for carrying elsewhere, applying the portable-content policy to every
 *  entry: declared privateFiles and sensitive names are held back and REPORTED, and symlinks
 *  are resolved and contained before anything is read through them.
 *
 *  Paths in `files` are POSIX-style, relative to `walkRoot` (defaults to the recipe
 *  directory). The POLICY is applied to recipe-relative paths, so a walk rooted at
 *  `<recipe>/agent` still matches `agent/foo`. `excludeTop` skips one top-level directory
 *  (the mirror's `agent` carve-out).
 *
 *  A symlink resolving outside the recipe throws, including the WALK ROOT itself. Privacy is
 *  decided on the resolved path as well as the logical one (a public-named link to a private
 *  target is still held back), and a directory link is walked in its canonical context so a
 *  declaration can't be dodged via an alias; one already on the walk path is refused. */
export async function collectPortableRecipeFiles(
  recipeDirectory: string,
  options: { walkRoot?: string; excludeTop?: string; requiredFiles?: readonly string[]; readRecipeManifest?: (path: string) => Promise<Buffer | undefined> } = {},
): Promise<{ files: string[]; excluded: { path: string; reason: string }[] }> {
  const walkRoot = options.walkRoot ?? recipeDirectory;
  const realRoot = await realpath(recipeDirectory);
  const realWalkRoot = await resolveContainedWalkRoot(walkRoot, realRoot);

  const state: PortableWalkState = {
    recipeDirectory,
    realRoot,
    declared: await declaredPortablePrivateFiles(recipeDirectory, options.readRecipeManifest),
    excludeTop: options.excludeTop,
    requiredFiles: options.requiredFiles ?? [],
    files: [],
    excluded: [],
  };
  await walkPortableDirectory(state, walkRoot, "", realWalkRoot, new Set([realRoot, realWalkRoot]));

  reportExcluded(state.excluded);
  return { files: state.files, excluded: state.excluded };
}

/** The root itself is vetted before the first readdir: a walk root that resolves outside the
 *  recipe would have every file under it arrive as an ordinary child. Fails the whole walk. */
async function resolveContainedWalkRoot(walkRoot: string, realRoot: string): Promise<string> {
  let realWalkRoot: string;
  try {
    realWalkRoot = await realpath(walkRoot);
  } catch (error) {
    // Genuinely-not-there rethrows for the caller to interpret; a root that EXISTS but
    // doesn't resolve (a dangling link) is untrusted, not absent, and must fail the walk.
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT"
      && (await lstat(walkRoot).catch(() => undefined))?.isSymbolicLink()
    ) {
      throw new Error(`walk root ${walkRoot} is a symlink that does not resolve — refusing to walk it`);
    }
    throw error;
  }
  if (realWalkRoot !== realRoot && !realWalkRoot.startsWith(realRoot + sep)) {
    throw new Error(
      `walk root ${walkRoot} resolves outside the recipe directory — refusing to walk it to ${realWalkRoot}`,
    );
  }
  return realWalkRoot;
}

function reportExcluded(excluded: readonly { path: string; reason: string }[]): void {
  if (excluded.length === 0) return;
  warn(
    `recipe portable-content policy held back: ${excluded.map((entry) => `${entry.path} (${entry.reason})`).join(", ")}`,
  );
}

/** State threaded through one collectPortableRecipeFiles walk — a plain object rather than
 *  closures, so each step is its own checkable function. */
interface PortableWalkState {
  readonly recipeDirectory: string;
  readonly realRoot: string;
  readonly declared: readonly string[];
  readonly excludeTop: string | undefined;
  readonly requiredFiles: readonly string[];
  readonly files: string[];
  readonly excluded: { path: string; reason: string }[];
}

async function walkPortableDirectory(
  state: PortableWalkState,
  current: string,
  base: string,
  realCurrent: string,
  activeDirs: Set<string>,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (base === "" && state.excludeTop !== undefined && entry.name === state.excludeTop) continue;
    await visitPortableEntry(state, entry, current, base, realCurrent, activeDirs);
  }
}

/** Declared privateFiles or the sensitive-name heuristic, matched against one path — used
 *  both for the entry's own (logical) path and, separately, for a symlink's real target. */
function excludedByPolicy(state: PortableWalkState, path: string, reasonSuffix: string): string | undefined {
  if (excludesPortablePath(path, state.declared)) return `declared privateFiles${reasonSuffix}`;
  if (SENSITIVE_RECIPE_NAME.test(path)) return `sensitive-name policy${reasonSuffix}`;
  return undefined;
}

async function visitPortableEntry(
  state: PortableWalkState,
  entry: Dirent,
  current: string,
  base: string,
  realCurrent: string,
  activeDirs: Set<string>,
): Promise<void> {
  const full = resolve(current, entry.name);
  const relativePath = base === "" ? entry.name : `${base}/${entry.name}`;
  const recipeRelative = relative(state.recipeDirectory, full).replaceAll("\\", "/");

  const nameReason = excludedByPolicy(state, recipeRelative, "");
  if (nameReason !== undefined) {
    state.excluded.push({ path: recipeRelative, reason: nameReason });
    return;
  }

  // Where the bytes of this entry actually live. Resolution only changes the answer when it
  // MOVES the path (a link, or reached through one), and then the same checks must hold for
  // the real path too — a public name pointing at a private target is still the private
  // target.
  const real = await resolvePortableEntryTarget(entry, full, realCurrent, recipeRelative);
  const realRecipeRelative = relative(state.realRoot, real).replaceAll("\\", "/");
  if (realRecipeRelative !== recipeRelative) {
    const targetReason = excludedByPolicy(state, realRecipeRelative, " (symlink target)");
    if (targetReason !== undefined) {
      state.excluded.push({ path: recipeRelative, reason: targetReason });
      return;
    }
  }

  // Containment is decided on the RESOLVED path of every entry, whatever the Dirent
  // reports: the type bit is bookkeeping, not evidence of where the bytes live.
  if (real !== state.realRoot && !real.startsWith(state.realRoot + sep)) {
    throw new Error(
      `${recipeRelative} resolves outside the recipe directory — refusing to follow it to ${real}`,
    );
  }

  if (entry.isDirectory() && state.requiredFiles.includes(recipeRelative)) {
    state.files.push(relativePath);
    return;
  }
  if (entry.isSymbolicLink()) {
    // Required JSON paths must be plain files — a link, whatever it targets, is carried
    // under its own name and fails closed at the read.
    if (state.requiredFiles.includes(recipeRelative)) {
      state.files.push(relativePath);
      return;
    }
    const stats = await stat(real);
    if (stats.isDirectory()) await walkPortableSubdirectory(state, full, relativePath, real, recipeRelative, realRecipeRelative, activeDirs);
    else state.files.push(relativePath);
    return;
  }
  if (entry.isDirectory()) await walkPortableSubdirectory(state, full, relativePath, real, recipeRelative, realRecipeRelative, activeDirs);
  else state.files.push(relativePath);
}

async function resolvePortableEntryTarget(
  entry: Dirent,
  full: string,
  realCurrent: string,
  recipeRelative: string,
): Promise<string> {
  if (!entry.isSymbolicLink()) return resolve(realCurrent, entry.name);
  return realpath(full).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      // A child link resolving nowhere is a broken bundle, not an absent one: fail under the
      // link's own name rather than a bare ENOENT.
      throw new Error(`${recipeRelative} is a symlink that does not resolve`);
    }
    throw error;
  });
}

// Stack-scoped, never a memo of every directory seen: the same directory may be reached
// through two unrelated aliases legitimately. What must never happen is following a link
// into a directory the walk is ALREADY inside — refused by name, since that recursion has
// no bottom.
async function walkPortableSubdirectory(
  state: PortableWalkState,
  full: string,
  relativePath: string,
  real: string,
  recipeRelative: string,
  realRecipeRelative: string,
  activeDirs: Set<string>,
): Promise<void> {
  if (activeDirs.has(real)) {
    throw new Error(
      `${recipeRelative} resolves to ${realRecipeRelative || "."}, which the walk is already inside — following it would loop`,
    );
  }
  activeDirs.add(real);
  try {
    await walkPortableDirectory(state, full, relativePath, real, activeDirs);
  } finally {
    activeDirs.delete(real);
  }
}

/** The one walk of a recipe's `agent/` bundle, shared by every reader that needs it, so a
 *  declared-private prompt file can't stay out of the checksum map while provisioning copies
 *  it anyway. Returns undefined only for the walk root's OWN absence (no agent/ is normal) —
 *  a dangling link or any policy violation still throws. */
export async function collectPortableAgentBundleFiles(
  recipeDirectory: string,
): Promise<{ files: string[]; excluded: { path: string; reason: string }[] } | undefined> {
  const agentDir = resolve(recipeDirectory, "agent");
  try {
    await lstat(agentDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return collectPortableRecipeFiles(recipeDirectory, { walkRoot: agentDir });
}
