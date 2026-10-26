import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { locksDir, type Settings } from "../../../core/env.ts";
import type { PathBridge } from "../../../core/paths.ts";
import type { ExecOptions, ExecResult, Transport } from "../../transport/transport.ts";
import { privateWriteCommand } from "../../transport/quoting.ts";
const CONNECTION_ENV = new Set(["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "SSH_AUTH_SOCK"]);

export class RecipeReadError extends Error {
  readonly causeKind: "transport" | "malformed";
  constructor(causeKind: "transport" | "malformed", operation: string) {
    super(`recipe ${operation} is unknown (${causeKind})`);
    this.causeKind = causeKind;
  }
}
/** Structured refusal: `code` is the assertable contract, the message is prose for humans.
 *  migrationFailure preserves it, so command-level refusals stay machine-checkable. */
export class RefusalError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "RefusalError";
    this.code = code;
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RecipeReadError("malformed", "record");
  return value as Record<string, unknown>;
}
export function json(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new RecipeReadError("malformed", "JSON"); }
}
export function text(value: unknown): string {
  if (typeof value !== "string") throw new RecipeReadError("malformed", "string");
  return value;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new RecipeReadError("malformed", "array");
  return value;
}
export function ids(stdout: string): string[] {
  const result = stdout.trim() === "" ? [] : stdout.trim().split(/\s+/);
  if (result.some((id) => !/^[a-f0-9]{12,64}$/.test(id)) || new Set(result).size !== result.length)
    throw new RecipeReadError("malformed", "container IDs");
  return result;
}
export function execResult(value: unknown): ExecResult {
  const r = object(value);
  if (!Number.isSafeInteger(r["code"]) || typeof r["stdout"] !== "string" || typeof r["stderr"] !== "string"
    || (r["timedOut"] !== undefined && typeof r["timedOut"] !== "boolean")) throw new RecipeReadError("malformed", "execution result");
  return r as unknown as ExecResult;
}
export function remainingTimeout(deadline?: number, limit = 120_000): number {
  const remaining = deadline === undefined ? limit : Math.min(limit, deadline - Date.now());
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("recipe readiness deadline exceeded");
  return remaining;
}
export function checkDeadline(deadline?: number): void {
  remainingTimeout(deadline);
}
export const definitionLabel = "io.clawwright.recipe.definition";
export const digestLabel = "io.clawwright.recipe.document-sha256";
function stagingPath(path: string): string {
  if (path.length > 4096 || !path.startsWith("/") || path === "/" || posix.normalize(path) !== path
    || Array.from(path).some((char) => char === "\\" || char === "," || char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127))
    throw new RecipeReadError("malformed", "staging path");
  return path;
}
const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
export function operationPrefix(settings: Pick<Settings, "dataDir">, project: string, definition: string): string {
  const data = stagingPath(settings.dataDir);
  stagingPath(definition);
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(project)) throw new RecipeReadError("malformed", "staging project");
  return `${stagingPath(locksDir(data))}/.clawwright-operation-${createHash("sha256").update(`${data}\0${project}\0${definition}`).digest("hex")}-`;
}
export interface ComposeStaging {
  home: string;
  prefix: string;
  excluded: readonly string[];
}
export function stagingLayout(settings: Settings, project: string, definition: string,
  documents: readonly Record<string, unknown>[], extra: readonly string[] = []): ComposeStaging {
  const prefix = operationPrefix(settings, project, definition);
  const home = posix.dirname(prefix);
  const excluded: string[] = [settings.dataDir, settings.backupDir, settings.snapshotDir, posix.dirname(definition), ...extra];
  for (const document of documents) for (const serviceValue of Object.values(object(document["services"]))) {
    for (const value of array(object(serviceValue)["volumes"] ?? [])) {
      const mount = object(value);
      if (mount["type"] === "bind") excluded.push(text(mount["source"]));
    }
  }
  const unique = [...new Set(excluded)];
  if (unique.length > 256) throw new RecipeReadError("malformed", "staging exclusion inventory");
  for (const path of unique) if (overlaps(home, stagingPath(path))) throw new RecipeReadError("malformed", "staging overlaps storage or source");
  return { home, prefix, excluded: unique };
}
const stagingAncestry = `set -efu
export LC_ALL=C
uid=$(id -u)
check_directory() {
  test ! -L "$1"; test -d "$1"; test -x "$1"
  test "$(realpath -e -- "$1")" = "$1"
  owner=$(stat -c %u -- "$1")
  mode=$(stat -c %a -- "$1")
  case "$mode" in ''|*[!0-7]*) exit 20;; esac
  test "$owner" = "$uid" || test "$owner" = 0
  test $((0$mode & 0022)) -eq 0 || { test "$owner" = 0; test $((0$mode & 01000)) -ne 0; }
}
check_directory /
ancestor=
oldIFS=$IFS
IFS=/
for part in $1; do
  test -n "$part" || continue
  ancestor=$ancestor/$part
  check_directory "$ancestor"
done
IFS=$oldIFS
test "$(stat -c %u -- "$1")" = "$uid"
`;
export async function verifyStaging(io: Pick<StackIO, "transport">, layout: ComposeStaging,
  root?: string, resolved?: string, read = false, deadline?: number, write = !read): Promise<string> {
  if (root !== undefined && (!root.startsWith(layout.prefix)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(root.slice(layout.prefix.length))))
    throw new RecipeReadError("malformed", "staging root");
  if (resolved !== undefined && resolved !== `${root}/resolved.json`) throw new RecipeReadError("malformed", "staging file");
  const parameters = [layout.home, root ?? "", resolved ?? "", ...layout.excluded];
  if (parameters.length > 259 || parameters.some((path) => path !== "" && stagingPath(path) !== path)
    || parameters.reduce((size, path) => size + Buffer.byteLength(path) + 1, 0) > 16_384)
    throw new RecipeReadError("malformed", "staging argument budget");
  const script = `${stagingAncestry}
${write ? 'test $((0$(stat -c %a -- "$1") & 0200)) -ne 0; test -w "$1"' : ""}
if [ -n "$2" ]; then
  check_directory "$2"
  test "$(stat -c '%a:%u' -- "$2")" = "700:$uid"
fi
if [ -n "$3" ]; then
  test ! -L "$3"; test -f "$3"
  test "$(realpath -e -- "$3")" = "$3"
  test "$(stat -c '%a:%u:%h' -- "$3")" = "600:$uid:1"
  test "$(stat -c %s -- "$3")" -le 4194304
fi
home=$1
file=$3
shift 3
for path do
  canonical=$(realpath -m -- "$path")
  case "$canonical" in /) exit 21;; esac
  case "$home/" in "$canonical/"*) exit 21;; esac
  case "$canonical/" in "$home/"*) exit 21;; esac
done
${read ? 'cat -- "$file"' : "printf 'verified'"}`;
  try {
    const result = execResult(await io.transport.exec("sh", ["-c", script,
      read ? "recipe-provenance" : "recipe-staging-proof", ...parameters],
    { allowFailure: true, stream: false, timeoutMs: remainingTimeout(deadline, 10_000) }));
    checkDeadline(deadline);
    if (result.code !== 0 || result.timedOut || result.stderr !== "" || (read
      ? result.stdout.length === 0 || Buffer.byteLength(result.stdout) > 4194304 : result.stdout !== "verified"))
      throw new Error("staging proof refused");
    return result.stdout;
  } catch { checkDeadline(deadline); throw new RecipeReadError("malformed", "native private staging unsafe or unknown"); }
}
export async function preflightStaging(io: StackIO, documents: readonly Record<string, unknown>[], extra: readonly string[] = []): Promise<ComposeStaging> {
  if (!io.transport.mkdirPrivate || !io.transport.writePrivateFile) throw new Error("recipe requires exclusive private durable staging");
  const layout = stagingLayout(io.getSettings(), io.project, await io.file(), documents, extra);
  await verifyStaging(io, layout);
  return layout;
}
export function documentDigest(document: Record<string, unknown>): string {
  const services = Object.fromEntries(Object.entries(object(document["services"])).map(([name, value]) => {
    const service = object(value);
    const labels = { ...object(service["labels"] ?? {}) };
    delete labels[digestLabel];
    return [name, { ...service, labels }];
  }));
  return createHash("sha256").update(JSON.stringify({ ...document, services })).digest("hex");
}
export interface StackIO {
  transport: Transport;
  project: string;
  legacy: readonly string[];
  getSettings: () => Settings;
  file: () => Promise<string>;
  run: (args: string[], environment?: Readonly<Record<string, string>>, timeoutMs?: number, abort?: AbortSignal) => Promise<ExecResult>;
  writePrivateFile: (path: string, content: string | Uint8Array, options?: ExecOptions) => Promise<void>;
  mkdirPrivate: (path: string, options?: ExecOptions) => Promise<void>;
  config: (namespace?: string) => Promise<Record<string, unknown>>;
  sanitize: (value: string) => string;
}
export async function readCompose(io: Pick<StackIO, "file" | "getSettings" | "run" | "project">, args: string[], namespace = io.project): Promise<ExecResult> {
  const target = await io.file();
  return io.run(["compose", "--env-file", "/dev/null", "--project-name", namespace,
    "--file", target, "--project-directory", target.slice(0, target.lastIndexOf("/")), ...args], io.getSettings().env);
}
export function createIO(transport: Transport, paths: PathBridge, getSettings: () => Settings,
  project: string, definitionPath: string, legacy: readonly string[]): StackIO {
  if (transport.sessionScoped === true) {
    throw new RefusalError("Recipe definition delivery is unsupported in a temporary keeper scope.", "SSJACK_RECIPE_STAGING_UNSUPPORTED");
  }
  const file = async (): Promise<string> => {
    const target = await paths.toTarget(definitionPath);
    if (!target.startsWith("/") || posix.normalize(target) !== target || Array.from(target).some((char) => char === "," || char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127))
      throw new RecipeReadError("malformed", "definition path");
    return target;
  };
  const run = async (args: string[], environment?: Readonly<Record<string, string>>, timeoutMs = 120_000, abort?: AbortSignal): Promise<ExecResult> => {
    const deadline = Date.now() + remainingTimeout(undefined, timeoutMs);
    const input = environment === undefined ? undefined : Object.entries(environment).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Array.from(value).some((char) => [0, 10, 13].includes(char.charCodeAt(0))))
        throw new Error("recipe environment cannot be represented safely");
      return CONNECTION_ENV.has(key) ? "" : `export ${key}='${value.replaceAll("'", "'\\''")}'`;
    }).join("\n") + '\nexec docker "$@"\n';
    let result: ExecResult;
    try {
      // Clear target-side ambient interpolation variables too (SSH/WSL inheritance is
      // not described by the operator's process.env). Preserve Docker connection only.
      const launch = 'exec env -i PATH="$PATH" HOME="$HOME" DOCKER_HOST="${DOCKER_HOST-}" DOCKER_CONTEXT="${DOCKER_CONTEXT-}" DOCKER_CONFIG="${DOCKER_CONFIG-}" DOCKER_TLS_VERIFY="${DOCKER_TLS_VERIFY-}" DOCKER_CERT_PATH="${DOCKER_CERT_PATH-}" SSH_AUTH_SOCK="${SSH_AUTH_SOCK-}" ' + (input === undefined ? 'docker "$@"' : 'sh -s -- "$@"');
      result = await transport.exec("sh", ["-c", launch, "recipe-docker", ...args], {
        allowFailure: true, stream: false, timeoutMs: remainingTimeout(deadline, timeoutMs), signal: abort,
        ...(input === undefined ? {} : { input }), unsetEnv: [...new Set([...Object.keys(process.env), ...Object.keys(getSettings().env)])]
          .filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !CONNECTION_ENV.has(key) && key !== "TMPDIR"),
      });
    } catch { throw new RecipeReadError("transport", "Docker operation failed"); }
    checkDeadline(deadline);
    result = execResult(result);
    // Do not echo untrusted daemon output: it can contain observed (not configured) secrets.
    if (result.code !== 0 || result.timedOut) throw new RecipeReadError("transport", "Docker operation failed");
    return result;
  };
  const config = async (namespace = project): Promise<Record<string, unknown>> => {
    const result = await readCompose({ file, getSettings, run, project }, ["config", "--format", "json"], namespace);
    return object(json(result.stdout));
  };
  const sanitize = (value: string): string => {
    let safe = value;
    for (const secret of Object.values(getSettings().env).filter(Boolean).sort((a, b) => b.length - a.length)) safe = safe.split(secret).join("[redacted]");
    safe = safe.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, "[redacted-url]");
    // Match only credential-labelled values, including quoted JSON strings with escapes.
    // Plain labelled values may contain spaces; stop at record/line delimiters, not whitespace.
    safe = safe.replace(/((?:["']?\b(?:password|token|secret|authorization|api[_-]?key)\b["']?)[ \t]*[:=][ \t]*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;}\]]+)/gi, "$1[redacted]");
    return Array.from(safe).filter((char) => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || (code >= 32 && (code < 127 || code > 159));
    }).join("").slice(0, 16_384);
  };
  // Staging changes only the transport operation, not the ownership contract: use the
  // same POSIX exclusive owner-only writer as WSL/SSH, so the trial's mkdir/write can be
  // bounded and cancelled just like every other target mutation (local too).
  const mkdirPrivate = async (path: string, options: ExecOptions = {}): Promise<void> => {
    const result = await transport.exec("mkdir", ["-m", "700", path], { ...options, allowFailure: true });
    if (result.code !== 0) throw new Error(`private directory creation failed (exit ${result.code})`);
  };
  const writePrivateFile = async (path: string, content: string | Uint8Array, options: ExecOptions = {}): Promise<void> => {
    const [command, args] = privateWriteCommand(path);
    const result = await transport.exec(command, args, { ...options, input: content, allowFailure: true });
    if (result.code !== 0) throw new Error(`private file write failed (exit ${result.code})`);
  };
  return { transport, project, legacy: [...new Set(legacy)].filter((p) => p !== project), getSettings, file, run, config, sanitize,
    mkdirPrivate, writePrivateFile };
}
export interface PreparedComposeDocument {
  readonly layout: ComposeStaging;
  readonly root: string;
  readonly resolved: string;
  readonly file: string;
  readonly directory: string;
  readonly project: string;
  readonly digest: string;
  readonly content: string;
}
export function decodeComposeDocument(content: string): Record<string, unknown> {
  const decode = (value: unknown): unknown => typeof value === "string" ? value.replaceAll("$$", "$")
    : Array.isArray(value) ? value.map(decode)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)])) : value;
  return object(decode(json(content)));
}
/** A resolved document must not undergo interpolation a second time: every `$` becomes
 *  `$$`, recursively, so compose's single un-escape on load leaves the original strings.
 *  Exported for the recipe trial, which pins a proven merged document the same way. */
export const escapeComposeDocument = (value: unknown): unknown => typeof value === "string" ? value.replaceAll("$", () => "$$")
  : Array.isArray(value) ? value.map(escapeComposeDocument)
  : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, escapeComposeDocument(v)])) : value;
export async function prepareComposeDocument(io: StackIO, document: Record<string, unknown>, extra: readonly string[] = []): Promise<PreparedComposeDocument> {
  const file = await io.file();
  const directory = posix.dirname(file);
  const t = io.transport;
  if (!t.mkdirPrivate || !t.writePrivateFile) throw new Error("recipe requires exclusive private durable staging");
  const layout = Object.freeze(await preflightStaging(io, [document], extra));
  Object.freeze(layout.excluded);
  // Each invocation is immutable and retained, including failed invocations. Compose owns
  // its reserved labels; the exact config filename and content digest prove our provenance.
  const root = `${layout.prefix}${randomUUID()}`;
  const resolved = `${root}/resolved.json`;
  const labeled: Record<string, Record<string, unknown> & { labels: Record<string, unknown> }> = Object.fromEntries(Object.entries(object(document["services"])).map(([name, value]) => {
    const service = object(value);
    const labels = object(service["labels"] ?? {});
    if (Object.keys(labels).some((key) => key.startsWith("com.docker.compose.") || key.startsWith("io.clawwright.recipe.")))
      throw new Error("recipe reserved provenance labels are not permitted");
    return [name, { ...service, labels: { ...labels, [definitionLabel]: file } }];
  }));
  const prepared = { ...document, services: labeled };
  const digest = documentDigest(prepared);
  for (const service of Object.values(labeled)) service.labels[digestLabel] = digest;
  // A resolved document must not undergo interpolation a second time.
  const content = JSON.stringify(escapeComposeDocument(prepared));
  if (Buffer.byteLength(content) > 4194304) throw new RecipeReadError("malformed", "staging document too large");
  try {
    await verifyStaging(io, layout);
    await t.mkdirPrivate(root);
    await verifyStaging(io, layout, root);
    await t.writePrivateFile(resolved, content);
    const proof = await verifyStaging(io, layout, root, resolved, true, undefined, true);
    if (proof !== content) throw new Error("private Compose document changed");
  } catch { throw new RecipeReadError("transport", "private Compose staging failed"); }
  return Object.freeze({ layout, root, resolved, file, directory, project: io.project, digest, content });
}
export async function executePreparedDocument(io: StackIO, prepared: PreparedComposeDocument, args: string[], beforeExecute?: () => void): Promise<ExecResult> {
  const layout = stagingLayout(io.getSettings(), io.project, prepared.file,
    [decodeComposeDocument(prepared.content)], prepared.layout.excluded);
  if (io.project !== prepared.project || await io.file() !== prepared.file
    || layout.prefix !== prepared.layout.prefix || layout.home !== prepared.layout.home)
    throw new RecipeReadError("malformed", "prepared Compose identity changed");
  const proof = await verifyStaging(io, layout, prepared.root, prepared.resolved, true, undefined, true);
  const document = decodeComposeDocument(proof);
  if (proof !== prepared.content || documentDigest(document) !== prepared.digest
    || Object.values(object(document["services"])).some((value) => {
      const labels = object(object(value)["labels"]);
      return labels[definitionLabel] !== prepared.file || labels[digestLabel] !== prepared.digest;
    })) throw new RecipeReadError("malformed", "prepared Compose document changed");
  beforeExecute?.();
  return io.run(["compose", "--env-file", "/dev/null", "--project-name", prepared.project, "--project-directory", prepared.directory,
    "--file", prepared.resolved, ...args]);
}
export async function composeDocument(io: StackIO, document: Record<string, unknown>, args: string[], extra: readonly string[] = []): Promise<ExecResult> {
  return executePreparedDocument(io, await prepareComposeDocument(io, document, extra), args);
}
