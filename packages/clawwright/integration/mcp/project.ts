import { readFile, writeFile, mkdir, rm, lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { renameOverPrivateFile } from "../../security/privacy/private-file.ts";
import { warn } from "../../core/io/log.ts";
import { INVOCATION_VERSION } from "../../core/io/invocation/index.ts";
import { SHIM_PROGRAM, spell, type Launch } from "../../core/io/invocation/frame.ts";

export type McpClient = "claude" | "codex" | "both";
export type DeploymentMode = "installed" | "monorepo";
export interface ProjectMcpEntry { command: string; args: string[] }

/** Stable project-local names for Clawwright's two MCP surfaces. */
export const CLAWWRIGHT_MCP_NAME = "clawwright";
export const CLAWWRIGHT_CONTROL_MCP_NAME = "clawwright-control";

/** Filename of the committed launcher, written next to app.ts by new-app, init and
 *  mcp-setup. No secrets, no machine paths — safe to commit (unlike .mcp.json/.codex/). */
export const MCP_LAUNCHER_FILENAME = "mcp-launch.mjs";

// The monorepo launcher's launch, shape only (design §4.1): the checkout gate two levels
// above the apps/<name> directory the launcher is committed into. The program spelling is
// the frame's, not this file's — one source, so the emitted text stays byte-identical.
const LAUNCHER_ROOT = "/clawwright-mcp-launcher";
const LAUNCHER_LAUNCH: Launch = { kind: "checkout-shim", root: LAUNCHER_ROOT };
const MONOREPO_LAUNCHER_PROGRAM = spell(LAUNCHER_LAUNCH, "posix", "posix", `${LAUNCHER_ROOT}/apps/demo`) ?? SHIM_PROGRAM;

/** Runs this monorepo checkout's own source gate, two levels above the deployment. */
const MONOREPO_LAUNCHER = `// Clawwright MCP launcher: committed next to app.ts. Runs this monorepo checkout's own
// source gate (invariant: this file sits two levels under monorepoRoot, next to tools/)
// against this deployment. Written by new-app / mcp-setup; the bootstrap in the client
// config finds this file and sets CLAWWRIGHT_DEPLOYMENT_ROOT before importing it.
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.CLAWWRIGHT_DEPLOYMENT_ROOT;
const action = process.argv.at(-1);
if (root === undefined) throw new Error("CLAWWRIGHT_DEPLOYMENT_ROOT not set");
if (!["mcp-serve", "control-mcp"].includes(action)) throw new Error("invalid MCP action");

const entry = resolve(root, "../../tools/clawwright.ts");
process.chdir(root);
// Hints must resolve from this directory: the shim is two levels up. Both variables: new
// frameworks read the JSON one, older ones only CLAWWRIGHT_INVOKED_AS.
process.env.CLAWWRIGHT_INVOCATION = JSON.stringify({ version: ${INVOCATION_VERSION}, program: "${MONOREPO_LAUNCHER_PROGRAM}", mode: "checkout", app: { name: basename(root), selectedBy: "flag" }, audience: "mcp" });
process.env.CLAWWRIGHT_INVOKED_AS = "${MONOREPO_LAUNCHER_PROGRAM} --app " + basename(root);
process.argv = [process.argv[0], entry, "--app", basename(root), action];
await import(pathToFileURL(entry).href);
`;

/** Runs the deployment's own @phpcraftdream/clawwright package, else the system-wide command. */
const INSTALLED_LAUNCHER = `// Clawwright MCP launcher: committed next to app.ts. Runs this deployment's own
// @phpcraftdream/clawwright package (invariant: resolved through node's own package resolution,
// never a hardcoded path), or the system-wide clawwright command when it has none. Written by
// init / mcp-setup; the bootstrap in the client config finds this file and sets
// CLAWWRIGHT_DEPLOYMENT_ROOT before importing it.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.CLAWWRIGHT_DEPLOYMENT_ROOT;
const action = process.argv.at(-1);
if (root === undefined) throw new Error("CLAWWRIGHT_DEPLOYMENT_ROOT not set");
if (!["mcp-serve", "control-mcp"].includes(action)) throw new Error("invalid MCP action");

let entry;
try {
  entry = resolve(dirname(createRequire(resolve(root, "package.json")).resolve("@phpcraftdream/clawwright/app")), "..", "entry", "bin.js");
} catch {
  entry = undefined;
}
process.chdir(root);
if (entry === undefined) {
  // Same stdio, so the MCP session runs straight through the system-wide command.
  const child = spawn("clawwright", [action], { stdio: "inherit", shell: process.platform === "win32" });
  child.on("error", (error) => {
    process.stderr.write("clawwright: " + error.message + " — install it system-wide or add @phpcraftdream/clawwright to this deployment\\n");
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  process.argv = [process.argv[0], entry, action];
  await import(pathToFileURL(entry).href);
}
`;

/** Earlier canonical launcher texts, by sha256: still ours to rewrite, not a local edit. */
const RETIRED_LAUNCHERS = new Set([
  "47775c0b66345861419a080594347e2d1e2dcc6a0658c1bf90ae8e3d6ecb7129",
  "184fdbb3149ce05cd8b6c970538c93bc162dc0049b2d730cb927802dbb992431",
]);

/** The launcher content for `mode` — the only place either variant is defined. */
export function mcpLauncherContent(mode: DeploymentMode): string {
  return mode === "installed" ? INSTALLED_LAUNCHER : MONOREPO_LAUNCHER;
}

/** Tiny and identical for every client, mode and action: locates this deployment from
 *  wherever the client actually started it (Claude Code sets CLAUDE_PROJECT_DIR to the
 *  project root even when spawned from a subdirectory; other clients fall back to their own
 *  cwd), then hands off to the committed launcher next to app.ts. No machine-specific path
 *  or mode-specific logic enters either client config — that all lives in the launcher file. */
const BOOTSTRAP = 'import {existsSync} from "node:fs"; import {dirname,resolve} from "node:path"; ' +
  'import {pathToFileURL} from "node:url"; ' +
  'let root=resolve(process.env.CLAUDE_PROJECT_DIR||process.cwd()); ' +
  'while(!existsSync(resolve(root,"app.ts"))){const parent=dirname(root); ' +
  'if(parent===root)throw new Error("OpenClaw app.ts not found above the client working directory"); root=parent;} ' +
  'process.env.CLAWWRIGHT_DEPLOYMENT_ROOT=root; ' +
  `await import(pathToFileURL(resolve(root,${JSON.stringify(MCP_LAUNCHER_FILENAME)})).href);`;

/** Both project-local MCP entries. Identical regardless of client or deployment mode — the
 *  bootstrap always finds the same committed launcher, which is the only place that knows
 *  how to run this particular deployment. */
export function projectMcpEntries(): Record<string, ProjectMcpEntry> {
  const forAction = (action: string): ProjectMcpEntry => ({ command: "node", args: ["--experimental-strip-types", "--input-type=module", "-e", BOOTSTRAP, "--", action] });
  return {
    [CLAWWRIGHT_MCP_NAME]: forAction("mcp-serve"),
    [CLAWWRIGHT_CONTROL_MCP_NAME]: forAction("control-mcp"),
  };
}

export function mergeClaudeConfig(text: string | undefined, entries: Record<string, ProjectMcpEntry>): string {
  const parsed: unknown = text === undefined ? {} : JSON.parse(text.replace(/^\uFEFF/, ""));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(".mcp.json must contain an object");
  const config = parsed as Record<string, unknown>;
  const servers = config.mcpServers ?? {};
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) throw new Error(".mcp.json mcpServers must contain an object");
  return `${JSON.stringify({ ...config, mcpServers: { ...servers, ...entries } }, null, 2)}\n`;
}

interface LexState { quote?: string; triple: boolean; escaped: boolean; square: number; curly: number }
const lexState = (): LexState => ({ triple: false, escaped: false, square: 0, curly: 0 });
const complete = (state: LexState) => state.quote === undefined && state.square === 0 && state.curly === 0;

/** Track multiline values so text inside a string is never mistaken for a TOML table. */
function scan(line: string, state: LexState): void {
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (state.quote !== undefined) {
      if (state.escaped) { state.escaped = false; continue; }
      if (state.quote === '"' && char === "\\") { state.escaped = true; continue; }
      if (state.triple && line.slice(index, index + 3) === state.quote.repeat(3)) {
        state.quote = undefined; state.triple = false; index += 2;
      } else if (!state.triple && char === state.quote) state.quote = undefined;
      continue;
    }
    if (char === "#") break;
    if (char === '"' || char === "'") {
      state.quote = char;
      state.triple = line.slice(index, index + 3) === char.repeat(3);
      if (state.triple) index += 2;
    } else if (char === "[") state.square += 1;
    else if (char === "]") state.square -= 1;
    else if (char === "{") state.curly += 1;
    else if (char === "}") state.curly -= 1;
  }
  if (state.escaped && state.triple) state.escaped = false;
}

function keyParts(text: string): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest !== "") {
    const match = /^(?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)/.exec(rest);
    if (match === null) throw new Error("unsupported TOML key syntax; configuration was left untouched");
    const key = match[0];
    parts.push(key.startsWith('"') ? JSON.parse(key) : key.startsWith("'") ? key.slice(1, -1) : key);
    rest = rest.slice(key.length).trim();
    if (rest === "") break;
    if (!rest.startsWith(".")) throw new Error("unsupported TOML key syntax; configuration was left untouched");
    rest = rest.slice(1).trim();
    if (rest === "") throw new Error("incomplete TOML key");
  }
  return parts;
}

function assignmentKeys(line: string): string[] | undefined {
  let quote: string | undefined; let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (quote === '"' && char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") return undefined;
    else if (char === "=") return keyParts(line.slice(0, index));
  }
  return undefined;
}

/** Edit only owned server keys, preserving other tables, comments and multiline values. */
export function mergeCodexConfig(text: string, entries: Record<string, ProjectMcpEntry>): string {
  text = text.replace(/^\uFEFF/, "");
  const lines = text.match(/[^\n]*(?:\n|$)/g)?.filter((line) => line !== "") ?? [];
  const sections: { start: number; end: number; keys: string[] }[] = [];
  const state = lexState();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (complete(state)) {
      const header = /^\s*(\[\[|\[)(.*?)(\]\]|\])\s*(?:#.*)?\r?\n?$/.exec(line);
      if (header !== null) {
        if (header[1].length !== header[3].length) throw new Error("invalid TOML table header");
        if (sections.length > 0) sections.at(-1)!.end = index;
        const keys = keyParts(header[2]);
        if (header[1].length === 2 && keys[0] === "mcp_servers") throw new Error("MCP server array tables cannot be merged safely");
        sections.push({ start: index, end: lines.length, keys });
        continue;
      }
      if (sections.length === 0 && assignmentKeys(line)?.[0] === "mcp_servers") {
        throw new Error("use [mcp_servers.<name>] tables instead of inline MCP definitions before running mcp-setup");
      }
    }
    scan(line, state);
  }
  if (!complete(state)) throw new Error("unterminated TOML value; configuration was left untouched");

  const edits: { start: number; end: number; text: string }[] = [];
  const appended: string[] = [];
  for (const [name, entry] of Object.entries(entries)) {
    const matches = sections.filter((section) => section.keys.length === 2 && section.keys[0] === "mcp_servers" && section.keys[1] === name);
    if (matches.length > 1) throw new Error(`duplicate MCP table for ${name}; configuration was left untouched`);
    for (const parent of sections.filter((section) => section.keys.length === 1 && section.keys[0] === "mcp_servers")) {
      for (const line of lines.slice(parent.start + 1, parent.end)) {
        const equal = line.indexOf("=");
        if (equal < 0 || line.trimStart().startsWith("#")) continue;
        if (keyParts(line.slice(0, equal))[0] === name) throw new Error(`inline MCP entry ${name} cannot be merged safely`);
      }
    }
    const section = matches[0];
    const retained: string[] = [];
    const seen = new Set<string>();
    if (section !== undefined) {
      for (let index = section.start + 1; index < section.end; index += 1) {
        const line = lines[index];
        const assignment = /^\s*("(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/.exec(line);
        const key = assignment === null ? undefined : keyParts(assignment[1])[0];
        if (key !== undefined) seen.add(key);
        if (key === "url") throw new Error(`MCP entry ${name} is an HTTP server; rename it before configuring OpenClaw`);
        const value = lexState();
        scan(assignment === null ? line : line.slice(assignment[0].length), value);
        const statement = [line];
        while (!complete(value) && index + 1 < section.end) {
          index += 1; statement.push(lines[index]); scan(lines[index], value);
        }
        if (key === "command" || key === "args" || key === "cwd") continue;
        retained.push(...statement);
      }
    }
    const settings = `command = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n` +
      (seen.has("startup_timeout_sec") || seen.has("startup_timeout_ms") ? "" : "startup_timeout_sec = 60\n") +
      (seen.has("tool_timeout_sec") ? "" : "tool_timeout_sec = 600\n");
    if (section === undefined) appended.push(`[mcp_servers.${JSON.stringify(name)}]\n${settings}`);
    else edits.push({ start: section.start + 1, end: section.end, text: settings + retained.join("") });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) lines.splice(edit.start, edit.end - edit.start, edit.text);
  let result = lines.join("");
  if (appended.length > 0) result = `${result}${result === "" || result.endsWith("\n") ? "" : "\n"}\n${appended.join("\n")}`;
  return result;
}

async function existingFile(path: string): Promise<string | undefined> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`refusing to replace a linked configuration file: ${path}`);
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function replaceFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.clawwright-${randomBytes(6).toString("hex")}.tmp`;
  try { await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 }); await renameOverPrivateFile(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export interface SetupProjectMcpOptions {
  /** Rewrite mcp-launch.mjs even if a local edit made it differ from the canonical content —
   *  the explicit ask required before a user's own edit is ever overwritten. */
  rewriteLauncher?: boolean;
}

export async function setupProjectMcp(root: string, mode: DeploymentMode, client: McpClient = "both", options: SetupProjectMcpOptions = {}): Promise<string[]> {
  if (!["claude", "codex", "both"].includes(client)) throw new Error("unknown MCP client");
  const updates: { path: string; previous?: string; content: string }[] = [];
  const entries = projectMcpEntries();
  if (client === "both" || client === "claude") {
    const path = resolve(root, ".mcp.json"); const previous = await existingFile(path);
    updates.push({ path, previous, content: mergeClaudeConfig(previous, entries) });
  }
  if (client === "both" || client === "codex") {
    const directory = resolve(root, ".codex");
    const directoryStat = await lstat(directory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    });
    if (directoryStat?.isSymbolicLink()) throw new Error("refusing to write through a linked .codex directory");
    const path = resolve(root, ".codex", "config.toml"); const previous = await existingFile(path);
    updates.push({ path, previous, content: mergeCodexConfig(previous ?? "", entries) });
  }
  const ignorePath = resolve(root, ".gitignore");
  const previousIgnore = await existingFile(ignorePath);
  let ignore = previousIgnore ?? "";
  const ignored = ignore.split(/\r?\n/).map((line) => line.trim());
  for (const file of updates.map((entry) => entry.path.endsWith(".mcp.json") ? ".mcp.json" : ".codex/config.toml")) {
    if (!ignored.includes(file) && !ignored.includes(`/${file}`)) ignore += `${ignore.endsWith("\n") || ignore === "" ? "" : "\n"}/${file}\n`;
  }
  updates.push({ path: ignorePath, previous: previousIgnore, content: ignore });

  // The launcher is committed, not gitignored — kept out of the loop above. A local edit is
  // never overwritten silently: without an explicit ask it is left alone and reported. A
  // mode switch is not a local edit (still one of the two canonical variants), so it applies.
  const launcherPath = resolve(root, MCP_LAUNCHER_FILENAME);
  const launcherPrevious = await existingFile(launcherPath);
  const launcherContent = mcpLauncherContent(mode);
  const launcherIsCanonical = launcherPrevious === undefined || launcherPrevious === MONOREPO_LAUNCHER || launcherPrevious === INSTALLED_LAUNCHER ||
    RETIRED_LAUNCHERS.has(createHash("sha256").update(launcherPrevious).digest("hex"));
  if (launcherIsCanonical || options.rewriteLauncher === true) {
    updates.push({ path: launcherPath, previous: launcherPrevious, content: launcherContent });
  } else {
    warn(`${launcherPath} was edited locally and left as is — rerun mcp-setup with --rewrite-launcher to overwrite it`);
  }
  const written: typeof updates = [];
  try {
    for (const update of updates) {
      if (update.previous === update.content) continue;
      if (await existingFile(update.path) !== update.previous) throw new Error(`configuration changed during setup: ${update.path}`);
      await replaceFile(update.path, update.content); written.push(update);
    }
  } catch (error) {
    for (const update of written.reverse()) {
      if (await existingFile(update.path) !== update.content) continue;
      if (update.previous === undefined) await rm(update.path, { force: true });
      else await replaceFile(update.path, update.previous);
    }
    throw error;
  }
  return written.map((update) => update.path);
}
