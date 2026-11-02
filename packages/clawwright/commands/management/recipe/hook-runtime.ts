// Loading and caching app-owned recipe hook modules (prepare.ts, verify.ts, onboard.ts, …)
// against the checksum of each hook's own local import graph.

import { register } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { dependencyGraphChecksum } from "./hook-graph.ts";

/** App-owned hook modules, cached against the checksum of the hook's whole local import
 *  graph (not just the entry file), so `import()`'s URL-keyed module map doesn't keep
 *  serving a stale hook after a dependency changes on disk.
 *
 *  The checksum decides *whether* a reload is due; a versioned URL decides *what gets
 *  re-executed*: importHookModule stamps it as `?g=<checksum>` on the hook's real file
 *  URL, and ./hook-loader.ts's resolve hook re-stamps the same version onto every
 *  specifier reached through relative resolution. A change anywhere in the graph thus
 *  changes every versioned URL at once, so Node re-executes the whole graph; unchanged,
 *  this map answers without importing.
 *
 *  Hooks execute from their real location (no copy to temp): bare imports resolve
 *  against the recipe's package scope, `#imports` resolve through the recipe's own
 *  package.json imports map (hook-graph.ts folds package.json + resolved target into
 *  the checksum; anything it can't safely track — bare package target, absolute path,
 *  `..` escape, symlink, unsupported condition — is refused before the hook executes). */
const hookModules = new Map<string, { checksum: string; loaded: Record<string, unknown> }>();

/** Query parameter carrying the hook graph's checksum on every versioned hook URL. */
const HOOK_GRAPH_VERSION_PARAM = "g";

/** Query parameter carrying the recipe directory alongside the checksum — hook-loader.ts
 *  reads it back to resolve (and re-validate) a `#specifier` at any depth in the graph
 *  without needing the recipe directory threaded through every resolve() call. */
const HOOK_GRAPH_RECIPE_PARAM = "r";

const HOOK_IMPORT_TIMEOUT_MS_DEFAULT = 30_000;

/** The deadline is a backstop against evaluation that never settles — the loader's own
 *  promise graph cannot deadlock anymore (there is none), but a hook's top-level await
 *  still could, and a hung import means a hung MCP call holding the instance lock. The
 *  environment override exists so a check can exercise the timeout path in seconds
 *  instead of half a minute. */
function hookImportTimeoutMs(): number {
  const override = Number(process.env.CLAWWRIGHT_HOOK_IMPORT_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : HOOK_IMPORT_TIMEOUT_MS_DEFAULT;
}

let hookResolveHooksRegistered = false;

export async function importHookModule(path: string): Promise<Record<string, unknown>> {
  const checksum = await dependencyGraphChecksum(path);
  const cached = hookModules.get(path);
  if (cached?.checksum === checksum) return cached.loaded;
  if (!hookResolveHooksRegistered) {
    const loader = new URL(import.meta.url).pathname.endsWith(".ts") ? "./hook-loader.ts" : "./hook-loader.js";
    register(new URL(loader, import.meta.url).href, import.meta.url);
    hookResolveHooksRegistered = true;
  }
  const versioned = new URL(pathToFileURL(path).href);
  versioned.searchParams.set(HOOK_GRAPH_VERSION_PARAM, checksum);
  versioned.searchParams.set(HOOK_GRAPH_RECIPE_PARAM, dirname(path));
  const versionedURL = versioned.href;
  const evaluation = import(versionedURL) as Promise<Record<string, unknown>>;
  // If the deadline ever wins the race the evaluation is still pending in the background;
  // a rejection from it must not surface as an unhandled rejection and crash the process.
  evaluation.catch(() => {});
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      evaluation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `recipe hook ${path}: module evaluation did not settle within ${hookImportTimeoutMs()}ms — ` +
                "the hook's top-level code (a top-level await across its relative imports, typically) never resolves",
            ),
          );
        }, hookImportTimeoutMs());
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
