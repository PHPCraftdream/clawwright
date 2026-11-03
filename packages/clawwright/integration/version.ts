// `--version`, `-v` and `version`: the framework version, answered before any deployment is resolved.

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { isWithin } from "../core/paths.ts";
import { frameworkPackage } from "../core/env.ts";
import { emit } from "../core/io/output.ts";
import { die } from "../core/io/log.ts";
import { commandBody, type ArgumentSpec } from "../core/command/spec.ts";
import { materializeGate, type GateCommand } from "./gate.ts";

export const VERSION_COMMAND_NAME = "version";

/** The first-token spellings normalizeVersionAlias rewrites onto the command: declared here once,
 *  read by the gate dispatch and by completion. */
export const VERSION_ALIASES: readonly string[] = ["--version", "-v"];

export type VersionSource = "global" | "local" | "checkout";

/** `--version`/`-v` as the first token become `version`: one declaration serves all spellings. */
export function normalizeVersionAlias(argv: string[]): string[] {
  if (argv[0] !== undefined && VERSION_ALIASES.includes(argv[0])) return [VERSION_COMMAND_NAME, ...argv.slice(1)];
  return argv;
}

function real(path: string): string {
  try {
    // native: the long, canonical name (Windows expands 8.3 short names; macOS /var → /private/var).
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** Which copy `packageDir` is: a checkout's tools/framework, the app's own dependency
 *  (inside `appRoot`), or else the system-wide one. `path` is the checkout root for a checkout. */
export function classifyCopy(packageDir: string, appRoot?: string): { source: VersionSource; path: string } {
  const dir = real(packageDir);
  const root = dirname(dirname(dir));
  if (basename(dir) === "clawwright" && basename(dirname(dir)) === "packages" && existsSync(resolve(root, "tools", "clawwright.ts"))) return { source: "checkout", path: root };
  if (appRoot !== undefined && dir !== real(appRoot) && isWithin(real(appRoot), dir)) return { source: "local", path: dir };
  return { source: "global", path: dir };
}

/** `appRoot`: the deployment this run serves, to tell its own dependency from the global copy. */
export const VERSION_ARGUMENTS = [
  {
    name: "json",
    summary: "Emit {name, version, source, path} instead of text",
    description: "Emit { name, version, source, path } instead of the one-line text",
    kind: "flag",
  },
  { name: "verbose", description: "Also print which copy runs and where", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

export function makeVersionGateCommand(appRoot?: string): GateCommand {
  return materializeGate({
    name: VERSION_COMMAND_NAME,
    summary: `Print clawwright's own version (also: ${VERSION_ALIASES.join(", ")})`,
    details:
      "Reads the framework's package.json, as `inspect` does. No deployment is resolved, no .env is read, no lock is touched. " +
      "{--verbose} / {--json} also say which copy runs: global, local (the app's own dependency) or checkout, and its path.",
    aliases: VERSION_ALIASES,
    body: commandBody({
      needs: "nothing",
      effect: "read",
      arguments: VERSION_ARGUMENTS,
      run: async (_on, plan) => {
        const pkg = await frameworkPackage();
        if (pkg?.version === undefined) die("cannot determine the framework version — package.json is missing or unreadable");
        const copy = classifyCopy(pkg.dir, appRoot);
        if (plan.json === true) emit(`${JSON.stringify({ name: "clawwright", version: pkg.version, ...copy })}`+"\n");
        else if (plan.verbose === true) emit(`clawwright ${pkg.version}`+`\nsource: ${copy.source}\npath: ${copy.path}\n`);
        else emit(`clawwright ${pkg.version}`+"\n");
        return 0;
      },
    }),
  });
}

export const versionGateCommand: GateCommand = makeVersionGateCommand();
