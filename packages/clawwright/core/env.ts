// Repository configuration: the .env next to this checkout.
//
// The repository is always on our own filesystem, so it is read with node:fs/promises.
// Anything belonging to the target instance goes through the transport instead.
//
// The shell version used `source .env`, which executes whatever the file contains; here it
// is parsed as data.

import { commandLine } from "./io/invocation/render.ts";
import { existsSync } from "node:fs";
import { readFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomInt } from "node:crypto";
import { UserError, die, log, warn } from "./io/log.ts";
import { durationMs } from "./values/durations.ts";
import { envFile } from "../runtime/deployment.ts";

// Two roots, kept apart on purpose (tools/framework/ also ships as an installed npm
// dependency, not only colocated here — see deployment.ts for the matching note):
//   frameworkRoot  where THIS file lives, zero climbing — used only for the framework's
//                  own shipped files (docker-compose.yml). Installed as a package this
//                  sits at node_modules/<pkg>/, so climbing a fixed number of parents to
//                  guess at anything above would be a hidden assumption (see paths.ts).
//   monorepoRoot   two levels up — the clawwright checkout, valid only when the framework
//                  runs colocated with apps/ the way it does today; every other call site
//                  (apps/<name>, deploy's rsync source, scaffold templates) means this.
// This module lives in core/ so the package root is one level above it in source and dist.
export const frameworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const monorepoRoot = resolve(frameworkRoot, "..", "..");

// Check-only seam (stage 7 S0.4): a check process sets CLAWWRIGHT_CHECKS_APPS_DIR so
// deployments resolve under a temp root; nothing user-facing sets it, so unset means
// the checkout's own apps/.
export function appsRootFor(root: string): string {
  const override = process.env["CLAWWRIGHT_CHECKS_APPS_DIR"];
  return override === undefined || override === "" ? resolve(root, "apps") : resolve(override);
}

/** The WSL distro every default target assumes; one owner — layout.check.ts's single-
 *  definition audit refuses a second literal default elsewhere. */
export const DEFAULT_WSL_DISTRO = "Ubuntu-24.04";

/** The framework package this process runs: its version and directory (frameworkRoot in
 *  source, its parent in dist/). */
export async function frameworkPackage(): Promise<{ version: string | undefined; dir: string } | undefined> {
  for (const dir of [frameworkRoot, resolve(frameworkRoot, "..")]) {
    try {
      const parsed = JSON.parse(await readFile(resolve(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (parsed.name === "@phpcraftdream/clawwright") return { version: parsed.version, dir };
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/** Whether `root` is a Clawwright checkout — proven by the gate script every checkout is
 *  built around (tools/clawwright.ts), not assumed from this file's location. monorepoRoot
 *  is only a good guess in colocated mode: installed as a package, the same two climbed
 *  levels land inside node_modules, nothing to do with this deployment. Any command
 *  deriving a path from monorepoRoot must ask this first — acting on the guess is how a
 *  wrong tree gets mirrored somewhere with --delete. */
export async function isMonorepoCheckout(root: string = monorepoRoot): Promise<boolean> {
  return access(resolve(root, "tools", "clawwright.ts")).then(
    () => true,
    () => false,
  );
}

/** Shared by every deployment (same service, different settings), so it stays with the
 *  framework rather than being copied into each one; ships inside tools/framework/ itself. */
export const composeFile = resolve(frameworkRoot, "docker-compose.yml");

/** The package's public exports, mapped onto this checkout's sources: a hook (or a
 *  deployment's app.ts) importing `@phpcraftdream/clawwright/<export>` in a checkout has no
 *  dist build and no install to resolve against, so the loaders fall back to this table —
 *  keyed off the package's own root (frameworkRoot), which in an installed package points
 *  inside it and matches no source file, leaving normal resolution in charge. */
const FRAMEWORK_PACKAGE = "@phpcraftdream/clawwright";
/** Exported for checks only: the table must mirror package.json's exports in both
 *  directions, and an extra entry here is exactly what a one-way check cannot see. */
export const FRAMEWORK_EXPORT_SOURCES: Record<string, string> = {
  "./app": "core/app.ts",
  "./mounts": "runtime/mounts.ts",
  "./commands": "commands/interface/index.ts",
  "./private-config": "security/privacy/private-config.ts",
  "./recipe-kit": "recipe-kit/index.ts",
};

/** The checkout source file a `@phpcraftdream/clawwright` specifier maps to, or undefined when
 *  this code does not run from the checkout sources or the specifier is not a public export. */
export function checkoutFrameworkSource(specifier: string): string | undefined {
  if (specifier !== FRAMEWORK_PACKAGE && !specifier.startsWith(`${FRAMEWORK_PACKAGE}/`)) return undefined;
  const sub = specifier === FRAMEWORK_PACKAGE ? "./" : `./${specifier.slice(FRAMEWORK_PACKAGE.length + 1).split(/[?#]/, 1)[0]}`;
  const source = FRAMEWORK_EXPORT_SOURCES[sub];
  if (source === undefined) return undefined;
  const target = resolve(frameworkRoot, source);
  return existsSync(target) ? target : undefined;
}

export type DeploymentEnv = string & { readonly __deploymentEnv: unique symbol };
export function deploymentEnvText(text: string): DeploymentEnv { return text as DeploymentEnv; }

export type Env = Record<string, string>;

/** The framework's own scratch directory on the target, beside the data directory — not
 *  inside, since `restore` replaces the data directory whole. The data directory's own
 *  name stays in it so two deployments sharing a parent don't collide. Pure/path-based so
 *  instance-lock.ts and runtime-docker.ts agree on "here" without importing each other. */
export function locksDir(dataDir: string): string {
  const separator = pathSeparator(dataDir);
  const cut = lastSeparator(dataDir);
  const parent = cut < 0 ? "" : dataDir.slice(0, cut) || separator;
  const name = dataDir.slice(cut + 1);
  return `${parent}${parent === separator ? "" : separator}${name}-locks`;
}

function pathSeparator(path: string): "/" | "\\" {
  return path.includes("\\") ? "\\" : "/";
}

function lastSeparator(path: string): number {
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

const EXPORT_PREFIX = /^export\s+/;

/** The key and raw (unparsed) value half of one line, so every reader that needs "which
 *  variable does this line assign" (parseEnv, upsertEnvLine) agrees on the same parse.
 *  undefined for a blank line, a comment, or one whose key would be empty (leading `=`);
 *  { malformed: true } for a non-blank non-comment line with no `=` at all. */
function splitEnvLine(rawLine: string): { key: string; valueRaw: string } | { malformed: true } | undefined {
  const line = rawLine.trim();
  if (line === "" || line.startsWith("#")) return undefined;
  const stripped = line.replace(EXPORT_PREFIX, "");
  const eq = stripped.indexOf("=");
  if (eq === 0) return undefined;
  if (eq < 0) return { malformed: true };
  return { key: stripped.slice(0, eq).trim(), valueRaw: stripped.slice(eq + 1) };
}

/** The structured shape of parseEnv's refusal: a non-blank non-comment line without `=`.
 *  Carries the 1-based line and the file (when the caller named one) so checks and callers
 *  can assert on fields instead of message prose. The message never quotes the offending
 *  line, which may hold a secret. */
export class EnvSyntaxError extends UserError {
  readonly code = "ENV_LINE_WITHOUT_EQUALS";
  readonly line: number;
  readonly file: string | undefined;
  constructor(line: number, file?: string) {
    super(`${file === undefined ? "" : `${file}: `}line ${line}: expected a KEY=value line, found one without "="`);
    this.name = "EnvSyntaxError";
    this.line = line;
    this.file = file;
  }
}

/** Parses dotenv basics, the level compose reads the same file at: leading `export ` is
 *  stripped, `#` starts a comment (whole line, or partway through an UNQUOTED value after
 *  whitespace), one outer quote pair is stripped literally. No interpolation. Throws a
 *  UserError on a non-blank non-comment line without `=` — a typo like "OC_DATA_DIR /srv/x"
 *  must surface, not be silently dropped. The message never quotes the offending line,
 *  which may hold a secret. */
export function parseEnv(text: string, file?: string): Env {
  const env: Env = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const split = splitEnvLine(lines[i]);
    if (split === undefined) continue;
    if ("malformed" in split) {
      throw new EnvSyntaxError(i + 1, file);
    }
    env[split.key] = parseEnvValue(split.valueRaw);
  }
  return env;
}

/** parseEnv without the refusal: skips a line with no `=`. For scanning content where one
 *  broken file must not break the whole listing (e.g. listing sibling deployments). */
export function parseEnvLenient(text: string): Env {
  const env: Env = {};
  for (const rawLine of text.split("\n")) {
    const split = splitEnvLine(rawLine);
    if (split === undefined || "malformed" in split) continue;
    env[split.key] = parseEnvValue(split.valueRaw);
  }
  return env;
}

/** NAME's value the way parseEnv would hand it to loadEnv's caller: export-aware,
 *  quote-aware, last line wins on a duplicate key. undefined when NAME is not assigned. */
export function readEnvValue(text: string, name: string, file?: string): string | undefined {
  return parseEnv(text, file)[name];
}

/** Replaces NAME's assignment in place, recognizing `export NAME=` and spacing round `=`
 *  the same way parseEnv reads them. Every existing line assigning NAME is rewritten to
 *  the same value (parseEnv's last-line-wins already treats duplicates as one variable);
 *  appends one only when none exists. Line endings collapse to `\n`. */
export function upsertEnvLine(text: string, name: string, value: string): string {
  const line = serializeEnvLine(name, value);
  const lines = text.split(/\r?\n/);
  while (lines.at(-1) === "") lines.pop();
  let replaced = false;
  const next = lines.map((existing) => {
    const split = splitEnvLine(existing);
    if (split === undefined || "malformed" in split || split.key !== name) return existing;
    replaced = true;
    return line;
  });
  if (!replaced) next.push(line);
  return `${next.join("\n")}\n`;
}

/** The value half of a line, taken UNTRIMMED so `KEY= # c` reads as empty with a comment.
 *  A quoted value keeps everything inside its outer pair; only an empty or `#` tail may follow
 *  the closing quote, otherwise the whole text is kept as written. */
function parseEnvValue(raw: string): string {
  const body = raw.trimStart();
  const quote = body[0];
  if (quote === '"' || quote === "'") {
    const close = body.lastIndexOf(quote);
    if (close > 0) {
      const after = body.slice(close + 1).trim();
      if (after === "" || after.startsWith("#")) return body.slice(1, close);
    }
    return body;
  }
  const commentAt = raw.search(/\s#/);
  return commentAt === -1 ? raw.trim() : raw.slice(0, commentAt).trim();
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 1-based findings for lines whose key is not a valid variable name (a stray space before
 *  `=` is typical). Never includes the value — some are secrets. */
export function suspiciousEnvLines(text: string): string[] {
  const findings: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    const stripped = line.replace(EXPORT_PREFIX, "");
    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (!ENV_KEY_PATTERN.test(key)) {
      findings.push(`line ${i + 1}: "${key}" is not a valid environment variable name`);
    }
  }
  return findings;
}

/** Parses a retention count (OC_BACKUP_KEEP, OC_SNAPSHOT_KEEP): unset → `fallback`; 0 →
 *  "never rotate", reported; anything but a non-negative integer → warning and `fallback`. */
export function parseRetention(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    warn(`${name}=${JSON.stringify(raw)} is not a non-negative integer — using the default of ${fallback}`);
    return fallback;
  }
  const value = Number.parseInt(trimmed, 10);
  if (value === 0) {
    log(`${name}=0 — rotation is disabled, nothing will be removed`);
    return 0;
  }
  return value;
}

/** Parses a duration threshold (OC_BACKUP_MAX_AGE): unset -> fallbackMs; "0" or "off"
 *  (case-insensitive) -> 0, "this finding is disabled" reported; anything but Nm/Nh/Nd ->
 *  warning and fallbackMs. Mirrors parseRetention's shape for a duration instead of a count. */
export function parseDurationThreshold(name: string, raw: string | undefined, fallbackMs: number, fallbackLabel: string): number {
  if (raw === undefined) return fallbackMs;
  const trimmed = raw.trim();
  if (trimmed === "0" || trimmed.toLowerCase() === "off") {
    log(`${name}=${trimmed} — disabled, this finding will never be reported`);
    return 0;
  }
  const parsed = durationMs(trimmed);
  if (parsed === undefined) {
    warn(`${name}=${JSON.stringify(raw)} is not a duration like 2d or 36h, nor 0/off — using the default of ${fallbackLabel}`);
    return fallbackMs;
  }
  return parsed;
}

/** Parses a free-space floor in MB (OC_DISK_MIN_FREE_MB): unset -> fallback; 0 -> disabled,
 *  reported; anything but a non-negative integer -> warning and fallback. Same shape as
 *  parseRetention, with wording of its own: 0 here means "never check", not "never rotate". */
export function parseDiskMinFreeMb(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    warn(`${name}=${JSON.stringify(raw)} is not a non-negative integer — using the default of ${fallback}`);
    return fallback;
  }
  const value = Number.parseInt(trimmed, 10);
  if (value === 0) {
    log(`${name}=0 — disabled, this finding will never be reported`);
    return 0;
  }
  return value;
}

/** Selects a deployment port candidate outside the usual ephemeral range. */
export function projectPort(taken: ReadonlySet<number> = new Set(), start = randomInt(12768)): number {
  const portCount = 12768;
  const first = 20000 + (start % portCount);
  for (let offset = 0; offset < portCount; offset += 1) {
    const port = 20000 + ((first - 20000 + offset) % portCount);
    if (!taken.has(port)) return port;
  }
  throw new Error("no deployment port is available in the configured range (20000–32767)");
}

/** The write side of the grammar above — parseEnv(serializeEnvLine(name, value))[name] is
 *  byte-identical to value for every value without a line terminator. The bare form
 *  survives only when the value has no edge whitespace, no quote character and no
 *  whitespace-then-`#`; anything else is written single-quoted and read back literally. A
 *  newline or carriage return cannot live on one line and is refused with the key named. */
export function serializeEnvLine(name: string, value: string): string {
  if (!ENV_KEY_PATTERN.test(name)) throw new Error(`invalid environment variable name: ${name}`);
  if (/[\r\n]/.test(value)) throw new Error(`environment value for ${name} contains a newline or carriage return`);
  if (value === value.trim() && !value.includes(`"`) && !value.includes(`'`) && !/\s#/.test(value)) {
    return `${name}=${value}`;
  }
  return `${name}='${value}'`;
}

// Every OC_* read from the deployment's .env. OC_APP and OC_DEBUG are read from the shell
// on purpose and absent here.
export const ENV_FILE_ONLY_VARS = [
  "OC_DATA_DIR",
  "OC_BACKUP_DIR",
  "OC_SNAPSHOT_DIR",
  "OC_BIND_ADDRESS",
  "OC_TARGET_LOCATION",
  "OC_WSL_DISTRO",
  "OC_SSH_HOST",
  "OC_REMOTE_PATH",
  "OC_COMPOSE_PROJECT",
  "OC_WATCH_WEBHOOK",
  "OC_WATCH_HEARTBEAT_URL",
  "OC_WATCH_WEBHOOK_FORMAT",
  "OC_WATCH_TELEGRAM_CHAT_ID",
  "OC_WATCH_DISK_MIN_MB",
  "OC_BACKUP_KEEP",
  "OC_SNAPSHOT_KEEP",
  "OC_BACKUP_MAX_AGE",
  "OC_DISK_MIN_FREE_MB",
  "OC_AUDIT_BLOCK",
] as const;

/** Names (never values — some are secrets) of exported variables that `fileEnv` lacks or
 *  disagrees with. */
export function shellOnlyEnvNames(fileEnv: Env, shellEnv: Readonly<Record<string, string | undefined>>): string[] {
  return ENV_FILE_ONLY_VARS.filter((name) => {
    const shellValue = shellEnv[name];
    return shellValue !== undefined && shellValue !== fileEnv[name];
  });
}

/** The one-line stderr warning for shell-exported variables loadEnv() ignores. */
export function shellOnlyEnvWarning(fileEnv: Env, shellEnv: Readonly<Record<string, string | undefined>>, file: string): string | undefined {
  const names = shellOnlyEnvNames(fileEnv, shellEnv);
  if (names.length === 0) return undefined;
  const plural = names.length > 1;
  return `warning: ${names.join(", ")} ${plural ? "are" : "is"} set in the shell but ignored — ` +
    `this tool reads .env only (${file}); set ${plural ? "them" : "it"} there`;
}

let shellOnlyEnvWarned = false;

// Check-only read counter (stage 7 S2.6a): every text read of the deployment's .env goes
// through here (loadEnv) or through LocalScope.env (core/command/spec.ts). A check resets
// the counter and asserts zero, proving a needs-"local" unit never reads or parses the .env.
let envTextReads = 0;
export function countEnvRead(): void { envTextReads += 1; }
export function envReads(): number { return envTextReads; }
export function resetEnvReads(): void { envTextReads = 0; }

/** The one counted text read of the deployment .env (stage 7 tails): loadEnv, provisioning
 *  and LocalScope.readText all go through here, so a zero read count in a check covers every
 *  product reader of the file, not just the ones a check knows by name. Throws ENOENT like
 *  a bare readFile did. */
export function readEnvFileText(): Promise<string> {
  countEnvRead();
  return readFile(envFile(), "utf8");
}
export async function loadEnv(): Promise<Env> {
  const file = envFile();
  try {
    await access(file);
  } catch {
    die(`${file} not found. Run ${commandLine(["bootstrap"])} first.`);
  }
  const env = parseEnv(await readEnvFileText(), file);
  if (!shellOnlyEnvWarned) {
    const warning = shellOnlyEnvWarning(env, process.env, file);
    if (warning !== undefined) {
      process.stderr.write(`${warning}\n`);
      shellOnlyEnvWarned = true;
    }
  }
  return env;
}

export interface Settings {
  env: Env;
  /** Paths below are paths ON THE TARGET, not necessarily on this machine. */
  dataDir: string;
  backupDir: string;
  snapshotDir: string;
  bindAddress: string;
  gatewayPort: string;
  serviceUrl: string;
  image: string;
  /** Transport selection: auto | local | wsl | ssh. */
  location: string;
  wslDistro: string;
  /** user@host, required when location is ssh. */
  sshHost: string;
  /** Where this repository lives on the remote host. */
  remotePath: string;
}

const DATA_DIR_HINT =
  "OC_DATA_DIR must be an absolute, already-normalized path with at least two segments below " +
  'its root (e.g. "/srv/openclaw/data"), never "/" or a bare top-level directory.';

// A Windows drive prefix ("C:\" or "C:/") counts as a root the same way a leading "/" does:
// OC_TARGET_LOCATION=local on a Windows host can hand toSettings a native Windows path.
const WINDOWS_ROOT = /^[A-Za-z]:[\\/]/;

/** Guards the one string that later reaches a recursive `chown -R 1000:1000` in
 *  ensureDataDirs() (runtime/files/datadir.ts) — an unvalidated OC_DATA_DIR=/ would turn
 *  bootstrap into `chown -R 1000:1000 /`. Rejects rather than repairs: a mistake the
 *  operator didn't intend to write should surface, not be silently fixed. Plain
 *  string/regex checks, not node:path's normalize, since that would canonicalize to this
 *  host's separator style even when the target is a different platform (wsl/ssh are
 *  always POSIX; local can be native Windows). The depth-2 floor is a backstop, not the
 *  primary control — every system top-level directory has exactly one segment below root,
 *  so it rejects them all without a deny-list; the real check is filesystem-level in
 *  ensureDataDirs (canonical-ancestor resolution, chown only for what that run created). */
function assertSafeDataDir(dataDir: string): void {
  const isPosixRoot = dataDir.startsWith("/");
  const isWindowsRoot = WINDOWS_ROOT.test(dataDir);
  if (!isPosixRoot && !isWindowsRoot) {
    die(`OC_DATA_DIR "${dataDir}" is not an absolute path. ${DATA_DIR_HINT}`);
  }
  if (/[\\/]{2,}/.test(dataDir) || /[\\/]$/.test(dataDir)) {
    die(`OC_DATA_DIR "${dataDir}" is not a normalized path (repeated or trailing separators). ${DATA_DIR_HINT}`);
  }
  if (dataDir.includes("/") && dataDir.includes("\\")) {
    die(`OC_DATA_DIR "${dataDir}" mixes path separators. ${DATA_DIR_HINT}`);
  }
  // The first split segment is "" for a POSIX root or the drive letter ("C:") for a Windows
  // one — both mark the root itself, never a directory name, so neither counts toward depth.
  const segments = dataDir.split(/[\\/]+/).slice(1);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    die(`OC_DATA_DIR "${dataDir}" contains a "." or ".." segment. ${DATA_DIR_HINT}`);
  }
  if (segments.length < 2) {
    die(`OC_DATA_DIR "${dataDir}" is a top-level directory. ${DATA_DIR_HINT}`);
  }
}

/** Backup and snapshot roots use the same path spelling contract as the data root. */
function assertSafeSiblingDir(name: "OC_BACKUP_DIR" | "OC_SNAPSHOT_DIR", directory: string): void {
  const isPosixRoot = directory.startsWith("/");
  const isWindowsRoot = WINDOWS_ROOT.test(directory);
  if (!isPosixRoot && !isWindowsRoot) die(`${name} "${directory}" is not an absolute path`);
  if (/[\\/]{2,}/.test(directory) || /[\\/]$/.test(directory)) {
    die(`${name} "${directory}" is not a normalized path (repeated or trailing separators)`);
  }
  if (directory.includes("/") && directory.includes("\\")) die(`${name} "${directory}" mixes path separators`);
  const segments = directory.split(/[\\/]+/).slice(1);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    die(`${name} "${directory}" contains a "." or ".." segment`);
  }
  if (segments.length < 2) die(`${name} "${directory}" is a top-level directory`);
}

export const DATA_DIR_UNSET = "OC_DATA_DIR is not set in .env";

/** deploy's default remote root, shared with its prepare stage so the kind-refused --path
 *  and the .env default are judged against the same sentence (stage 7 S2.5). */
export const DEFAULT_REMOTE_PATH = "/opt/openclaw";

export function toSettings(env: Env): Settings {
  const dataDir = env.OC_DATA_DIR;
  if (!dataDir) die(DATA_DIR_UNSET);
  assertSafeDataDir(dataDir);

  const bindAddress = env.OC_BIND_ADDRESS ?? "127.0.0.1";
  const gatewayPort = env.OPENCLAW_GATEWAY_PORT ?? "18789";
  const separator = pathSeparator(dataDir);
  const cut = lastSeparator(dataDir);
  const parentOfData = cut < 0 ? "" : dataDir.slice(0, cut) || separator;
  const siblingSeparator = parentOfData === separator ? "" : separator;
  const backupDir = env.OC_BACKUP_DIR ?? `${parentOfData}${siblingSeparator}backups`;
  const snapshotDir = env.OC_SNAPSHOT_DIR ?? `${parentOfData}${siblingSeparator}snapshots`;
  assertSafeSiblingDir("OC_BACKUP_DIR", backupDir);
  assertSafeSiblingDir("OC_SNAPSHOT_DIR", snapshotDir);

  return {
    env,
    dataDir,
    backupDir,
    // Snapshots hold secrets, so they default outside the repository and away from Windows
    // mounts, where chmod is accepted and then silently ignored.
    snapshotDir,
    bindAddress,
    gatewayPort,
    serviceUrl: `http://${bindAddress}:${gatewayPort}`,
    image: env.OPENCLAW_IMAGE ?? "ghcr.io/openclaw/openclaw:extended-stable",
    location: env.OC_TARGET_LOCATION ?? "auto",
    wslDistro: env.OC_WSL_DISTRO ?? DEFAULT_WSL_DISTRO,
    sshHost: env.OC_SSH_HOST ?? "",
    remotePath: env.OC_REMOTE_PATH ?? DEFAULT_REMOTE_PATH,
  };
}

export async function settings(): Promise<Settings> {
  return toSettings(await loadEnv());
}
