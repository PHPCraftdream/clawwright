// The CLI entry ssjack launches for a deployment: the file Node runs, and the fixed arguments
// that go before the command name. It is the entry of the copy that is running now — the
// framework that already won the hand-over for this deployment — never a guess from PATH.

import { access } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { appsRootFor, frameworkRoot, monorepoRoot } from "#src/core/env.ts";
import { die } from "#src/core/io/log.ts";

export interface CliEntry {
  /** Absolute path of the entry file Node runs. */
  readonly path: string;
  /** Arguments between the entry and the command name. */
  readonly args: readonly string[];
}

/** The facts the decision reads, injectable so each layout is provable from any host. */
export interface EntryFacts {
  readonly frameworkRoot: string;
  readonly monorepoRoot: string;
  readonly appsRoot: string;
  exists(path: string): Promise<boolean>;
}

export function realEntryFacts(): EntryFacts {
  return {
    frameworkRoot,
    monorepoRoot,
    appsRoot: appsRootFor(monorepoRoot),
    exists: (path) => access(path).then(() => true, () => false),
  };
}

/** A deployment directly under a checkout's apps/ runs through the checkout gate, which is told
 *  its deployment by --app; every other deployment runs the package entry of this very copy
 *  (dist/entry/bin.js when installed, entry/bin.ts in a source tree). */
export async function resolveCliEntry(deployment: { readonly name: string; readonly dir: string }, facts: EntryFacts = realEntryFacts()): Promise<CliEntry> {
  const gate = resolve(facts.monorepoRoot, "tools", "clawwright.ts");
  const fromSources = resolve(facts.frameworkRoot) === resolve(facts.monorepoRoot, "packages", "clawwright");
  const underApps = relative(resolve(facts.appsRoot), dirname(resolve(deployment.dir))) === "";
  if (fromSources && underApps && (await facts.exists(gate))) return { path: gate, args: ["--app", deployment.name] };
  for (const file of ["bin.js", "bin.ts"]) {
    const path = resolve(facts.frameworkRoot, "entry", file);
    if (await facts.exists(path)) return { path, args: [] };
  }
  return die(`no Clawwright entry point (entry/bin.js or entry/bin.ts) found under ${facts.frameworkRoot}`);
}
