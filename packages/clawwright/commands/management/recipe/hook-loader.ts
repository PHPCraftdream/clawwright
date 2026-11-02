// Resolve hook for app-owned recipe hooks (imported by register() from
// ./hook-runtime.ts's importHookModule): hooks load from their real path under a
// `?g=<graph checksum>` URL so Node's module map re-executes a hook graph whose files
// changed on disk. Relative resolution from a versioned referrer drops the query, so
// without this hook every helper past the entry would keep serving its first content
// forever. This re-stamps the version (and recipe directory, `?r=`) onto every relative
// resolution.
//
// Package-internal `#specifier` imports are NOT handed to `nextResolve`: Node caches a
// package.json's parsed content per real path for the process lifetime, so delegating
// would keep answering an edited import map with its first-read target. Instead this hook
// recomputes the target fresh off disk via hook-graph.ts's resolvePackageImport and
// short-circuits to its versioned URL. Bare installed packages resolve normally.
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkoutFrameworkSource } from "../../../core/env.ts";
import { resolvePackageImport } from "./hook-graph.ts";

const VERSION_PARAM = "g";
/** The recipe directory a versioned hook graph is bounded to, carried alongside the
 *  checksum so a `#specifier` reached at any depth in the graph can be resolved and
 *  re-validated without threading the recipe directory through every resolve() call. */
const RECIPE_PARAM = "r";

interface ResolveContext {
  readonly parentURL?: string;
}

interface ResolveResult {
  url: string;
  shortCircuit?: boolean;
  format?: string | null;
}

type NextResolve = (specifier: string, context: ResolveContext) => Promise<ResolveResult>;

export async function resolve(specifier: string, context: ResolveContext, nextResolve: NextResolve): Promise<ResolveResult> {
  const parentURL = context.parentURL;
  if (parentURL === undefined) return nextResolve(specifier, context);
  const parentParams = new URL(parentURL).searchParams;
  const version = parentParams.get(VERSION_PARAM);
  if (version === null) return nextResolve(specifier, context);
  const recipeDirectory = parentParams.get(RECIPE_PARAM);

  if (specifier.startsWith("#") && recipeDirectory !== null) {
    const { targetPath } = await resolvePackageImport(specifier, fileURLToPath(parentURL), recipeDirectory);
    const versioned = new URL(pathToFileURL(targetPath).href);
    versioned.searchParams.set(VERSION_PARAM, version);
    versioned.searchParams.set(RECIPE_PARAM, recipeDirectory);
    return { url: versioned.href, shortCircuit: true };
  }

  if (!specifier.startsWith("./") && !specifier.startsWith("../") && !specifier.startsWith("#")) {
    if (specifier === "@phpcraftdream/clawwright" || specifier.startsWith("@phpcraftdream/clawwright/")) {
      try {
        return await nextResolve(specifier, context);
      } catch (error) {
        // No install of the package answers (a checkout deployment): fall back to the
        // checkout's own sources for the package's public exports.
        if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw error;
        const source = checkoutFrameworkSource(specifier);
        if (source === undefined) throw error;
        return { url: pathToFileURL(source).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  }
  const resolved = await nextResolve(specifier, context);
  if (!resolved.url.startsWith("file:")) return resolved;
  const versioned = new URL(resolved.url);
  versioned.searchParams.set(VERSION_PARAM, version);
  if (recipeDirectory !== null) versioned.searchParams.set(RECIPE_PARAM, recipeDirectory);
  return { ...resolved, url: versioned.href };
}
