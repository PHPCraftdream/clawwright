#!/usr/bin/env node
// Installs this checkout's framework as the system-wide `clawwright` command.
//
//   npm run install:system                     into npm's global prefix
//   npm run install:system -- --prefix <dir>   into another prefix (the check uses a scratch one)
//
// Packs packages/clawwright exactly as it would be published (prepack builds dist/) and installs
// that tarball with `npm install -g`: a copy, not a link to this working tree, so the command
// does not change under later edits. Then runs the installed command itself.
//
// Remove it with: npm uninstall -g @phpcraftdream/clawwright

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOnPath, shadowMessage } from "./resolve-on-path.ts";
import { INSTALLED_MARK, NOT_ON_PATH_HINT } from "./install-messages.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageDir = resolve(repoRoot, "packages", "clawwright");
const windows = process.platform === "win32";

function refuse(message: string): never {
  process.stderr.write(`install:system: ${message}\n`);
  process.exit(1);
}

function parsePrefix(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args[0] === "--prefix" && args[1] !== undefined && args.length === 2) return resolve(args[1]);
  return refuse(`unknown arguments: ${args.join(" ")} (only --prefix <dir>)`);
}

/** npm's own CLI script, run by this very node: npm.cmd on Windows needs a shell, which
 *  would re-parse every path argument. */
function npmCli(): string {
  const fromRun = process.env.npm_execpath;
  if (fromRun !== undefined && basename(fromRun) === "npm-cli.js" && existsSync(fromRun)) return fromRun;
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ?? refuse(`npm not found next to ${process.execPath} — install npm, or run this through \`npm run install:system\``);
}

function npm(args: string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [npmCli(), ...args], { cwd, encoding: "utf8" });
}

function failed(step: string, result: SpawnSyncReturns<string>): never {
  const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-8).join("\n  ");
  return refuse(`${step} failed (exit ${String(result.status)})${detail === "" ? "" : `:\n  ${detail}`}`);
}

/** Directory npm puts global command shims in, for a given global prefix. */
function binDirectory(prefix: string): string {
  return windows ? prefix : join(prefix, "bin");
}

function onPath(directory: string): boolean {
  const normalize = (path: string): string => {
    const trimmed = resolve(path).replace(/[\\/]+$/, "");
    return windows ? trimmed.toLowerCase() : trimmed;
  };
  const wanted = normalize(directory);
  return (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter((entry) => entry !== "").some((entry) => normalize(entry) === wanted);
}

const requestedPrefix = parsePrefix(process.argv.slice(2));
const version = (JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as { version: string }).version;
if (!existsSync(resolve(repoRoot, "node_modules", "@typescript", "native-preview"))) {
  refuse("the build needs this checkout's dev dependencies — run `npm ci` here first");
}

const scratch = mkdtempSync(join(tmpdir(), "clawwright-install-"));
try {
  process.stderr.write(`==> packing @phpcraftdream/clawwright ${version} (builds dist/)\n`);
  const packed = npm(["pack", "--pack-destination", scratch], packageDir);
  const tarball = readdirSync(scratch).find((entry) => entry.endsWith(".tgz"));
  if (packed.status !== 0 || tarball === undefined) failed("npm pack", packed);

  const where = requestedPrefix === undefined ? "npm's global prefix" : requestedPrefix;
  process.stderr.write(`==> installing into ${where}\n`);
  const prefixArgs = requestedPrefix === undefined ? [] : ["--prefix", requestedPrefix];
  const installed = npm(["install", "--global", join(scratch, tarball), "--prefer-offline", "--no-audit", "--no-fund", ...prefixArgs], scratch);
  if (installed.status !== 0) failed("npm install --global", installed);

  let prefix = requestedPrefix;
  if (prefix === undefined) {
    const asked = npm(["prefix", "--global"], scratch);
    if (asked.status !== 0) failed("npm prefix --global", asked);
    prefix = asked.stdout.trim();
  }
  const bin = binDirectory(prefix);
  const shim = join(bin, windows ? "clawwright.cmd" : "clawwright");
  if (!existsSync(shim)) refuse(`npm reported success, but ${shim} does not exist`);

  // The shim itself, the way a shell runs it: a .cmd needs cmd.exe.
  const ran = windows
    ? spawnSync(`"${shim}" version`, { shell: true, encoding: "utf8", cwd: scratch })
    : spawnSync(shim, ["version"], { encoding: "utf8", cwd: scratch });
  if (ran.status !== 0 || !ran.stdout.includes(`clawwright ${version}`)) failed(`${shim} version`, ran);

  process.stderr.write(`${INSTALLED_MARK} ${shim} (clawwright ${version})\n`);
  if (onPath(bin)) {
    process.stderr.write("    in an app folder: clawwright init, then clawwright bootstrap / status / help\n");
  } else {
    process.stderr.write(`    ${bin} ${NOT_ON_PATH_HINT} — add it to use \`clawwright\` from any folder\n`);
  }
  // Only for npm's own global prefix: a scratch --prefix is never expected to be on PATH.
  const shadow = requestedPrefix === undefined ? shadowMessage(shim, resolveOnPath("clawwright")) : undefined;
  if (shadow !== undefined) process.stderr.write(`${shadow}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
