// `clawwright init` — the installed-mode counterpart to the monorepo's `new-app` (scaffold.ts).
//
// scaffold.ts creates one of several deployments under a monorepo's apps/, named by
// argument. This creates the one and only deployment a consumer repo has, in its own root
// — no name argument, no apps/<name> nesting. The declaration below imports from the
// package specifier ("@phpcraftdream/clawwright/app"), which only makes sense once the
// framework is installed as a dependency, never inside this monorepo.
//
// Same measure of usable as scaffold.ts: the generated deployment must run immediately
// after its .env is filled in.

import { mkdir, writeFile, access, readFile, chmod, readdir } from "node:fs/promises";
import { resolve, basename, dirname, relative } from "node:path";
import { frameworkPackage, frameworkRoot, deploymentEnvText, type DeploymentEnv } from "../../core/env.ts";
import { handoverOf, targetFrame, type Launch } from "../../core/io/invocation/frame.ts";
import { serializeInvocation } from "../../core/io/invocation/index.ts";
import { renderAdvice } from "../../core/io/invocation/render.ts";
import { command } from "../../core/io/invocation/advice.ts";
import { commandLine, SHIM_PROGRAM } from "../../core/io/invocation/render.ts";
import { commandBody } from "../../core/command/spec.ts";
import type { ArgumentSpec } from "../../core/command/spec.ts";
import { materializeGate, type GateCommand } from "../gate.ts";
import { log, info, die } from "../../core/io/log.ts";
import { createName, type DeploymentName } from "../../core/values/names.ts";
import { parseEnv } from "../../core/env.ts";
import { setupProjectMcp } from "../mcp/project.ts";
import { createPrivateFile, wslBoundaryNote } from "../../security/privacy/private-file.ts";
import { deploymentEnv as templateEnv, gitignoreLines, nextStepsLines, updateGitignore } from "./deployment-template.ts";

export function declarationFor(name: string): string {
  return `// This deployment.
//
// Says which service this deployment manages and which framework commands it exposes.
// Its configuration lives next to this file: .env, config/, secrets/, recipes/.
//
// Run it with: ${renderAdvice(command(["status"]), SHIM_TARGET)}

import { defineApp } from "@phpcraftdream/clawwright/app";
import { mountPoints } from "@phpcraftdream/clawwright/mounts";
import { openclawCommands } from "@phpcraftdream/clawwright/commands";

export default defineApp({
  name: "${name}",
  description: "self-hosted OpenClaw instance",

  service: { name: "gateway", logTail: "100" },
  mounts: mountPoints,

  // Every framework command. Add your own entries here if this deployment needs something
  // the framework does not provide.
  commands: openclawCommands,
});
`;
}

const DESIRED_STATE = `[
  { "path": "gateway.mode", "value": "local" },
  { "path": "gateway.bind", "value": "lan" }
]
`;

// The committed clawwright shim — invokes the installed
// package directly so Git Bash under WSL works even when only `node.exe` is on PATH.
// Bash-only, same as this monorepo's own; Windows users can use npm's
// generated node_modules/.bin/clawwright.cmd or .ps1 instead. Without a local install it
// hands over to a system-wide `clawwright`.
// The shim's own hand-over, spelled by the frame constructors (design §4.1): the
// deployment shim the committed shim names, and its v1 JSON — one source, so the emitted
// text stays byte-identical with every other writer's (decision O7).
const SHIM_LAUNCH: Launch = { kind: "deployment-shim", root: "" };
const SHIM_TARGET = targetFrame(SHIM_LAUNCH, "posix");
const SHIM_HANDOVER = serializeInvocation(handoverOf(SHIM_TARGET));
const SHIM_SPELLING = handoverOf(SHIM_TARGET).program;

export const SHIM = `#!/usr/bin/env bash
# Delegates to the installed @phpcraftdream/clawwright CLI. Committed so ./clawwright <command> works
# without typing a package path or npx by hand.
set -Eeuo pipefail
# Hints in the CLI say "./clawwright" for this entry, "clawwright" for the system-wide command.
# Both variables: new frameworks read the JSON one, older ones only CLAWWRIGHT_INVOKED_AS.
export CLAWWRIGHT_INVOCATION='${SHIM_HANDOVER}'
export CLAWWRIGHT_INVOKED_AS=${SHIM_SPELLING}
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
node_bin=""
for candidate in node node.exe /usr/local/bin/node "/c/Program Files/nodejs/node.exe" "/mnt/c/Program Files/nodejs/node.exe"; do
  if command -v "$candidate" >/dev/null 2>&1; then
    node_bin="$candidate"
    break
  fi
done
if [[ -z "$node_bin" ]]; then
  echo "error: Node not found — install Node 24 or newer first" >&2
  exit 1
fi
script_path="$DIR/node_modules/@phpcraftdream/clawwright/dist/entry/bin.js"
if [[ ! -f "$script_path" ]]; then
  # No install of its own: run the system-wide package with the node found above (npm's own
  # shim needs node on PATH, which cron and WSL-with-Windows-node lack). Never this file again.
  entry_rel="node_modules/@phpcraftdream/clawwright/dist/entry/bin.js"
  global=""
  search=()
  if global="$(command -v clawwright)" && [[ "$(cd "$(dirname "$global")" && pwd)" != "$DIR" ]]; then
    global_dir="$(cd "$(dirname "$global")" && pwd)"
    if resolved="$(readlink -f "$global" 2>/dev/null)"; then search+=("$resolved"); fi
    search+=("$global_dir/$entry_rel" "$global_dir/../lib/$entry_rel")
  else
    global=""
  fi
  node_dir="$(dirname "$(command -v "$node_bin")")"
  search+=("$node_dir/../lib/$entry_rel" "\${HOME:-/nonexistent}/.local/lib/$entry_rel" "/usr/local/lib/$entry_rel" "/usr/lib/$entry_rel")
  found=""
  for candidate in "\${search[@]}"; do
    if [[ -f "$candidate" && "$candidate" == */dist/entry/bin.js ]]; then
      found="$candidate"
      break
    fi
  done
  if [[ -n "$found" ]]; then
    script_path="$found"
  elif [[ -n "$global" ]]; then
    exec "$global" "$@"
  else
    echo "error: $script_path not found — run npm install, or install clawwright system-wide" >&2
    exit 1
  fi
fi
node_platform="$("$node_bin" -e 'process.stdout.write(process.platform)' 2>/dev/null || echo unknown)"
if [[ "$node_platform" == "win32" ]]; then
  if command -v cygpath >/dev/null 2>&1; then
    script_path="$(cygpath -w "$script_path")"
  elif command -v wslpath >/dev/null 2>&1; then
    script_path="$(wslpath -w "$script_path")"
  fi
fi
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"
# Passing script_path as an argument bypasses bin.js's own shebang (its own
# --experimental-strip-types) — needed here too, or bin.js's dynamic import of this
# deployment's own app.ts fails on the package's declared minimum.
exec "$node_bin" --experimental-strip-types "$script_path" "$@"
`;

/** The committed shim file writer; the durable-output check drives it directly. */
export async function writeShim(root: string): Promise<void> {
  const file = resolve(root, "clawwright");
  await writeFile(file, SHIM, "utf8");
  await chmod(file, 0o755);
}

/** The shared template; the port avoids sibling deployments beside this directory. */
async function deploymentEnv(root: string, name: string): Promise<DeploymentEnv> {
  return deploymentEnvText(await templateEnv(name, dirname(root)));
}

/** Appends the deployment-state entries to .gitignore, creating the file if the consumer
 *  repo does not have one yet. Appended rather than overwritten: this is one repo among
 *  possibly many things it already ignores. */
async function updateInitGitignore(root: string): Promise<void> {
  await updateGitignore(root, gitignoreLines(true));
}

/** What this directory's package.json has to say about module type, and what init must do
 *  about it. `undefined` means there is nothing to do. */
type ModuleTypeAction =
  | { kind: "create"; name: string }
  | { kind: "set"; parsed: Record<string, unknown>; replacing?: string }
  | undefined;

/** Finds type-sensitive source files, excluding dependencies and Git metadata. */
async function typeSensitiveFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(js|ts)$/.test(entry.name)) files.push(relative(root, path));
    }
  }
  await visit(root);
  return files;
}

/** Chooses the package type without changing existing source semantics. */
async function moduleTypeAction(root: string): Promise<ModuleTypeAction> {
  const file = resolve(root, "package.json");

  const refuseForDependents = (declaration: string, reason: string, dependents: string[]): never => {
    die(
      `${file} ${declaration}, and this directory already holds ` +
        `${dependents.length} file(s) read under it (${dependents.slice(0, 3).join(", ")}${dependents.length > 3 ? ", …" : ""}).\n` +
        `The deployment declaration ${NEEDS_ESM}, and ${reason}. Set "type": "module" yourself once they can take it,\n` +
        "or initialise this deployment in a directory of its own.",
    );
  };

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const dependents = await typeSensitiveFiles(root);
      if (dependents.length > 0) {
        refuseForDependents(
          NOT_EXIST,
          "adding a package.json with \"type\": \"module\" would change how those files are read",
          dependents,
        );
      }
      return { kind: "create", name: basename(root) };
    }
    return die(`${file} could not be read: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return die(
      `${file} ${NOT_VALID_JSON} (${(error as Error).message}) — init needs to know whether this ` +
        'directory is ESM, and a file it cannot parse is not an answer. Fix it, or add "type": "module" by hand.',
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return die(`${file} is not a JSON object — init cannot tell whether this directory is ESM`);
  }

  const declared = (parsed as { type?: unknown }).type;
  if (declared === "module") return undefined;
  const dependents = await typeSensitiveFiles(root);
  if (dependents.length > 0) {
    const declaration = declared === undefined
      ? 'does not declare a "type"'
      : `declares "type": ${JSON.stringify(declared)}`;
    const reason = declared === undefined
      ? "adding \"type\": \"module\" would change how those files are read"
      : "changing the field for you would change how those files are read";
    refuseForDependents(declaration, reason, dependents);
  }
  if (declared === undefined) return { kind: "set", parsed: parsed as Record<string, unknown> };
  return { kind: "set", parsed: parsed as Record<string, unknown>, replacing: String(declared) };
}

async function applyModuleType(root: string, action: ModuleTypeAction): Promise<void> {
  if (action === undefined) return;
  const file = resolve(root, "package.json");

  // private: nothing here is meant for a registry, and a deployment directory carrying a
  // publishable package.json is an accident waiting for a stray `npm publish`.
  const content = action.kind === "create"
    ? { name: action.name, version: "0.0.0", private: true, type: "module" }
    : { ...action.parsed, type: "module" };

  await writeFile(file, `${JSON.stringify(content, undefined, 2)}\n`, "utf8");

  if (action.kind === "create") {
    log(`created ${file} ("type": "module")`);
    return;
  }
  log(`set "type": "module" in ${file}`);
  if (action.replacing !== undefined) {
    info(`  it said "type": ${JSON.stringify(action.replacing)}, which no file in this directory depends on — the deployment is ESM`);
  }
}

/** The placement decision the installed entry already made — how far inside a Clawwright
 *  checkout it is and whether its types are local — which `init` reads to decide where to
 *  print the editor-types line (see resolveInstalledEntry). */
/** The refusals init prints when the target directory already holds deployment state. */
export const ALREADY_EXISTS = "already exists";

export const ALREADY_INITIALISED = "already initialised";

export const NOT_EXIST = "does not exist";

export const NEEDS_ESM = "needs ESM";

export const NOT_VALID_JSON = "is not valid JSON";

/** Printed, never run: the editor-types install line. */
export function noSaveInstall(spec: string): string {
  return `npm install --no-save ${spec}`;
}

export interface InitPlacement {
  readonly localTypesOnly?: boolean;
  readonly ancestor?: string;
}

export const INIT_ARGUMENTS = [
  {
    name: "local",
    summary: "Print the npm command for editor types",
    description: "Print the npm command for editor types (also in an already initialised directory)",
    kind: "flag",
  },
] as const satisfies readonly ArgumentSpec[];

/** Fixed parts of init's own messages, exported so checks assert the same text the product
 *  prints instead of restating it. */
export const INIT_REFUSES_NOTE = "Refuses if app.ts already exists";

/** The installed entry's own gate command, declared without side effects — the same shape
 *  makeVersionGateCommand and makeCompletionGateCommand offer, so the help surfaces and the
 *  checks read the declaration straight from here. `placement.localTypesOnly`/`placement.ancestor`
 *  carry the placement decision the entry already made (see resolveInstalledEntry). */
export function makeInitGateCommand(
  appRoot: string,
  placement: InitPlacement = {},
): GateCommand {
  return materializeGate({
    name: "init",
    summary: "Initialise this directory as an OpenClaw deployment",
    details:
      "Writes app.ts, config/desired-state.json and .env (own data directory and project-specific port) " +
      "directly into the current directory, plus config/, secrets/, recipes/, .gitignore " +
      "entries for the deployment state and node_modules/, and a committed clawwright entrypoint " +
      "that delegates to this package's CLI. Project MCP settings for Claude Code and Codex " +
      "are created automatically, without changing global client settings.\n" +
      "The port is randomized; it is not a host availability check. Bootstrap checks active Docker deployments on the target before preparing data or pulling an image.\n" +
      `${INIT_REFUSES_NOTE} — run this once, then {clawwright bootstrap}. ` +
      "`init {--local}` in an already initialised directory only prints the editor-types npm line and writes nothing.",
    body: commandBody({
      needs: "nothing",
      effect: "change",
      arguments: INIT_ARGUMENTS,
      run: async (_on, plan) => {
        const localTypesOnly = placement.localTypesOnly === true;
        const ancestor = placement.ancestor;
        if (localTypesOnly && ancestor !== appRoot) {
          for (const line of await localTypesLines()) info(line);
          return 0;
        }
        await initApp(appRoot, { local: plan.local });
        return 0;
      },
    }),
  });
}

/** `--local`: editors resolve `@phpcraftdream/clawwright` only from a node_modules the app has.
 *  The package is unpublished, so a registry spec would fail; the running copy's own directory
 *  works today. --no-save: `--save-dev <dir>` would commit a machine path (file:…) into
 *  package.json. Printed, never run — init does not run npm. */
export async function localTypesLines(): Promise<string[]> {
  const directory = (await frameworkPackage())?.dir;
  const spec = directory === undefined ? "@phpcraftdream/clawwright" : `"${directory}"`;
  return [
    `editor types: run  ${noSaveInstall(spec)}`,
    "  (not on the registry yet; once it is: npm install --save-dev @phpcraftdream/clawwright)",
  ];
}

export async function initApp(root: string, options: { local?: boolean } = {}): Promise<void> {
  // The directory's own name becomes the compose project name (deploymentDir()'s basename
  // — see deployment.ts) — checked first, since there's no argument to fall back to here.
  const rawBase = basename(root);
  let base: DeploymentName;
  try {
    base = createName("deployment", rawBase);
  } catch (error) {
    die(
      `${(error as Error).message} — this becomes the compose project name and the archive ` +
        "prefix, taken from this directory's own name; rename the directory and run init again",
    );
  }

  const appFile = resolve(root, "app.ts");
  const exists = await access(appFile).then(
    () => true,
    () => false,
  );
  // --local on an initialised directory only prints the editor-types line; nothing is written.
  if (exists && options.local === true) {
    for (const line of await localTypesLines()) info(line);
    return;
  }
  if (exists) die(`${appFile} ${ALREADY_EXISTS} — this directory is ${ALREADY_INITIALISED}`);

  // Checked BEFORE anything is written: app.ts isn't the only leftover state init could
  // overwrite — an .env or desired-state.json from a failed prior init must be refused by name.
  const envFile = resolve(root, ".env");
  const desiredStateFile = resolve(root, "config", "desired-state.json");
  for (const conflict of [envFile, desiredStateFile]) {
    const conflictExists = await access(conflict).then(() => true, () => false);
    if (conflictExists) die(`${conflict} ${ALREADY_EXISTS} — refusing to overwrite it. Remove it (or move it aside) first if this directory should be re-initialised.`);
  }

  // Read before the first write for the same reason as the conflicts above: a directory this
  // deployment cannot run in must be refused whole, not left half-initialised.
  const moduleType = await moduleTypeAction(root);

  await mkdir(resolve(root, "config"), { recursive: true });
  await mkdir(resolve(root, "secrets"), { recursive: true });
  await mkdir(resolve(root, "recipes"), { recursive: true });

  await applyModuleType(root, moduleType);
  await writeFile(appFile, declarationFor(base), "utf8");
  await writeFile(resolve(root, "config", "desired-state.json"), DESIRED_STATE, "utf8");
  const env = await deploymentEnv(root, base);
  // boundary: false — the WSL-boundary note (if any) is printed after "next:" below, not
  // before it; see wslBoundaryNote's own call at the end of this function.
  await createPrivateFile(envFile, env, { boundary: false });
  await updateInitGitignore(root);
  await writeShim(root);
  await setupProjectMcp(root, "installed");

  log(`initialised ${root} as an OpenClaw deployment`);
  info("next:");
  for (const line of nextStepsLines(envFile, parseEnv(env, envFile).OC_DATA_DIR ?? "", commandLine(["bootstrap"]))) info(line);
  info("Claude Code and Codex project MCP settings are ready; trust the project and reconnect the clients.");
  info(`secrets stay inside this directory (snapshots go to the snapshot directory, OC_SNAPSHOT_DIR); commit ${SHIM_PROGRAM}, mcp-launch.mjs, app.ts,`);
  info("package.json, config/ and recipes/ — .gitignore keeps .env, secrets/, state/ and sets/ out");
  // Types resolve already when this CLI runs from the app's own node_modules.
  const ownInstall = frameworkRoot.startsWith(resolve(root, "node_modules"));
  if (!ownInstall && options.local === true) for (const line of await localTypesLines()) info(line);
  else if (!ownInstall) info(`editors cannot resolve @phpcraftdream/clawwright types without a local install: ${commandLine(["init", "--local"])}`);

  const boundaryNote = await wslBoundaryNote(envFile);
  if (boundaryNote !== undefined) info(boundaryNote);
}
