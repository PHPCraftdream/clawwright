// Shared configuration-path and inspection helpers.

import { readFile } from "node:fs/promises";
import JSON5 from "json5";
import { desiredStateFile } from "#src/runtime/deployment.ts";
import { TargetReadUnknownError, readIfExists } from "#src/runtime/transport/transport.ts";
import type { Context } from "#src/core/context.ts";
import type { CronJob, AgentConfig } from "#src/commands/management/provision-agent/index.ts";
import type { DeclaredState, Problem, MemoryObservation } from "#src/service/inspection.ts";
import { problem } from "#src/service/inspection.ts";
import { desiredStateShapeError } from "#src/set/ownership/validate.ts";
import type { BatchedCliResult } from "#src/service/openclaw-cli.ts";
import { configPathParts as sharedConfigPathParts, configPathPrefix, readConfigPath, setConfigPath } from "#src/core/values/config/config-selectors.ts";
import type { ConfigPathPart } from "#src/core/values/config/config-selectors.ts";

const configPathParts = (path: string): ConfigPathPart[] => sharedConfigPathParts(path);
function pathPartsEqual(left: readonly ConfigPathPart[], right: readonly ConfigPathPart[]): boolean {
  return configPathPrefix(left, right) && configPathPrefix(right, left);
}
function pathIsAncestor(ancestor: readonly ConfigPathPart[], descendant: readonly ConfigPathPart[]): boolean {
  return ancestor.length < descendant.length && configPathPrefix(ancestor, descendant);
}

const memoryRecord = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const memoryCount = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const memoryName = (value: unknown): string | undefined => typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9._/-]{0,79}$/.test(value) ? value : undefined;
function memoryModel(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /\p{Cc}/u.test(value)) return undefined;
  const safe = publicConfigValue("model", value);
  return typeof safe === "string" ? safe : undefined;
}
function memoryReady(value: unknown): "ready" | "disabled" | "unknown" {
  const entry = memoryRecord(value);
  return entry.enabled === false ? "disabled" : entry.available === true ? "ready" : "unknown";
}

/** Normal status only: missing metadata and source scans are independent of FTS capability. */
export function parseMemoryStatus(result: (BatchedCliResult & { readonly stderr?: string }) | undefined, problems: Problem[]): MemoryObservation[] {
  if ((result?.stdout.length ?? 0) > 262144) {
    problems.push(problem("MEMORY_UNKNOWN", "normal memory status exceeds the observation bound"));
    return [];
  }
  let payload: unknown;
  try { payload = JSON.parse(result?.stdout ?? ""); } catch { /* Unknown, never an empty index. */ }
  if (!Array.isArray(payload) || payload.length > 64) {
    problems.push(problem("MEMORY_UNKNOWN", "normal memory status is unavailable or malformed"));
    return [];
  }
  if (result?.code !== 0) problems.push(problem("MEMORY_UNKNOWN", "normal memory status returned partial facts"));
  return payload.map((entry: unknown, agent): MemoryObservation => {
    const root = memoryRecord(entry);
    const status = memoryRecord(root.status);
    const custom = memoryRecord(status.custom);
    const identity = memoryRecord(custom.indexIdentity);
    const providerState = memoryRecord(custom.providerState);
    const files = memoryCount(status.files);
    const chunks = memoryCount(status.chunks);
    const scannedFiles = memoryCount(memoryRecord(root.scan).totalFiles);
    const identityStatus = typeof identity.status === "string" ? identity.status.toLowerCase() : undefined;
    const indexIdentity = identityStatus === "missing" ? "missing" : identityStatus === "mismatched" ? "mismatched" : identityStatus === "valid" || identityStatus === "present" || identityStatus === "ok" ? "present" : "unknown";
    const failed = root.error !== undefined && root.error !== null;
    const state = status.enabled === false ? "disabled" : failed || indexIdentity === "mismatched" ? "unknown" : indexIdentity === "missing" ? "metadata-missing" : files === 0 && chunks === 0 ? "index-empty" : files !== undefined && chunks !== undefined && files > 0 && chunks > 0 && indexIdentity === "present" ? "indexed" : "unknown";
    if (state === "unknown") problems.push(problem("MEMORY_UNKNOWN", `memory agent ${agent + 1}: normal status incomplete`));
    if (state !== "disabled" && scannedFiles !== undefined && scannedFiles > 0 && (state === "metadata-missing" || state === "index-empty")) problems.push(problem("MEMORY_NOT_READY", `memory agent ${agent + 1}: ${state}, ${scannedFiles} source files scanned`));
    return {
      agent: agent + 1, agentId: memoryName(root.agentId), state, backend: memoryName(status.backend), provider: memoryName(status.provider),
      requestedProvider: memoryName(status.requestedProvider), model: memoryModel(status.model),
      scannedFiles, files, chunks, dirty: typeof status.dirty === "boolean" ? status.dirty : undefined,
      indexIdentity, fts: memoryReady(status.fts), vector: memoryReady(status.vector),
      embedding: status.provider === "none" || status.requestedProvider === "none" || providerState.requestedProvider === "none" ? "disabled" : failed ? "unknown" : providerState.mode === "pending" ? "unchecked" : memoryReady(status.embedding),
    };
  });
}
/** Field by field, so the reader is not left to diff a cron job themselves. Mirrors exactly
 *  what cronJobMatches compares — it decides, this only explains its verdict. */
export function cronDifferences(job: CronJob, config: AgentConfig, cronMessage: string): string[] {
  const differences: string[] = [];
  if (job.enabled === false) differences.push("the job is disabled");
  if (job.agentId !== config.agentId) differences.push(`agent is ${job.agentId ?? "(none)"}, declared ${config.agentId}`);
  if (job.schedule?.expr !== config.cronSchedule) differences.push(`runs at ${job.schedule?.expr ?? "(none)"}, declared ${config.cronSchedule}`);
  if (config.cronTimezone !== undefined && job.schedule?.tz !== config.cronTimezone) differences.push(`timezone is ${job.schedule?.tz ?? "(host default)"}, declared ${config.cronTimezone}`);
  if (job.sessionTarget !== "isolated") differences.push(`session is ${job.sessionTarget ?? "(none)"}, declared isolated`);
  if (job.payload?.message !== cronMessage) differences.push("the message differs from agent/cron-message.txt");
  if (job.payload?.timeoutSeconds !== config.cronTimeoutSeconds) {
    differences.push(`timeout is ${job.payload?.timeoutSeconds ?? "(none)"}s, declared ${config.cronTimeoutSeconds}s`);
  }
  if (job.delivery?.mode !== "none") differences.push(`delivery is ${job.delivery?.mode ?? "(none)"}, declared none`);
  return differences;
}

/** Reads a config path without following inherited properties. */
export function valueAt(config: unknown, path: string): unknown {
  try { return readConfigPath(config, path); } catch { return undefined; }
}

/** Compares JSON-shaped values without making object key order significant. */
export function configValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => configValuesEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left as Record<string, unknown>).sort();
  const rightKeys = Object.keys(right as Record<string, unknown>).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => configValuesEqual(
    (left as Record<string, unknown>)[key],
    (right as Record<string, unknown>)[key],
  ));
}

/** Keeps only declarations whose final assignment still controls an outer value. */
export function effectiveDeclarationPaths(
  declared: DeclaredState["config"],
): DeclaredState["config"] {
  const parsed = declared.map((entry) => ({ entry, parts: configPathParts(entry.path) }));
  const candidates = parsed.filter(({ parts }, index) => !parsed.slice(index + 1).some((later) =>
    pathPartsEqual(later.parts, parts) || pathIsAncestor(later.parts, parts)));
  return candidates
    .filter(({ parts }, index) => !candidates.some((candidate, candidateIndex) =>
      candidateIndex !== index && pathIsAncestor(candidate.parts, parts)))
    .map(({ entry }) => entry);
}

/** Writes a declaration through the shared resolver. */
function setAt(config: Record<string, unknown>, path: string, value: unknown): void { setConfigPath(config, path, value); }

/** Overlays declarations without mutating either the live config or declared values. */
export function prospectiveConfig(live: unknown, declared: DeclaredState["config"]): unknown {
  const base: Record<string, unknown> = live !== null && typeof live === "object" && !Array.isArray(live)
    ? structuredClone(live as Record<string, unknown>)
    : {};
  for (const entry of declared) setAt(base, entry.path, structuredClone(entry.value));
  return base;
}

/** The live openclaw.json parsed as JSON5, or undefined only when readIfExists confirms
 *  that the file is absent. Read failures propagate as TargetReadUnknownError so callers
 *  cannot build prospective state from an unknown target config. */
export async function readLiveConfigForProspective(ctx: Context): Promise<unknown> {
  const read = await readIfExists(ctx.transport, `${ctx.settings.dataDir}/config/openclaw.json`);
  return read.kind === "absent" ? undefined : JSON5.parse(read.value) as unknown;
}

/** The same read, for a caller about to WRITE based on the result (secrets --apply). Unlike
 *  readLiveConfigForProspective(), a read/parse error must not degrade to "no config": that
 *  would produce an incomplete requirement list which then overwrites config/.env, deleting
 *  secrets the missed requirement was for. Only a genuinely absent file is a legitimate
 *  empty base; anything else aborts before applyStore() writes a byte. */
export async function readLiveConfigOrThrow(ctx: Context): Promise<unknown> {
  const path = `${ctx.settings.dataDir}/config/openclaw.json`;
  // The read contract (S3.4): absent stays the legitimate empty base; an unreadable file is
  // unknown and travels with Advice (previously a plain Error stripped it).
  let read: Awaited<ReturnType<typeof readIfExists>>;
  try {
    read = await readIfExists(ctx.transport, path);
  } catch (error) {
    // The operator-facing sentence stays the one this refusal always had; the contract's
    // Advice and the cause ride along.
    if (error instanceof TargetReadUnknownError) throw new TargetReadUnknownError(`${path} exists but could not be read: ${(error.cause as Error | undefined)?.message ?? error.message}`, { cause: error.cause });
    throw error;
  }
  if (read.kind === "absent") return undefined;
  try {
    return JSON5.parse(read.value) as unknown;
  } catch (error) {
    throw new Error(`${path} exists but is not valid JSON5: ${(error as Error).message}`);
  }
}

/** The raw {path,value} declarations from config/desired-state.json, with no problem
 *  reporting and none of declaredState()'s (declared.ts) recipe/image extras — for a caller
 *  that only needs prospectiveConfig's input. Absence is a legitimate empty declaration;
 *  any other read or shape failure aborts the write. */
export async function readDeclaredConfig(): Promise<DeclaredState["config"]> {
  const path = desiredStateFile();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`${path} exists but could not be read: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} exists but is not valid JSON: ${(error as Error).message}`);
  }
  const shapeError = desiredStateShapeError(parsed);
  if (shapeError !== undefined) throw new Error(`${path} is not a valid desired-state declaration: ${shapeError}`);
  return (parsed as { path: string; value: unknown }[]).map((entry) => ({ path: entry.path, value: entry.value }));
}

/** One outbound endpoint the live configuration names, with the path that names it. */
export interface EgressEndpoint {
  readonly path: string;
  readonly url: string;
}

/** Outbound endpoints a live configuration actually names: each provider's baseUrl and each
 *  channel's proxy, nothing else. From the LIVE config, not the declaration: the running
 *  instance reads config at startup, so the prospective overlay could name endpoints not
 *  yet in force. */
export function egressEndpoints(liveConfig: unknown): EgressEndpoint[] {
  const found: EgressEndpoint[] = [];
  const gather = (node: unknown, prefix: string, leaf: string): void => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return;
    for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
      const value = entry !== null && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)[leaf]
        : undefined;
      if (typeof value !== "string" || value.trim() === "") continue;
      // A key containing path punctuation stays unambiguous in bracket form, the way valueAt reads it.
      const head = /[.["\]]/.test(key) ? `${prefix}[${JSON.stringify(key)}]` : `${prefix}${key}`;
      found.push({ path: `${head}.${leaf}`, url: value });
    }
  };
  gather(valueAt(liveConfig, "models.providers"), "models.providers.", "baseUrl");
  gather(valueAt(liveConfig, "channels"), "channels.", "proxy");
  return found;
}

const SECRET_CONFIG_KEY = /(?:password|passwd|secret|token|credential|authorization|(?:api|private|client|access|auth|encryption|signing)[_-]?key|^auth$|^key$|^signature$|^sig$)/i;
const SPECIAL_URL_SCHEME = ["http", "https", "ftp", "ws", "wss", "file"]
  .map((scheme) => [...scheme].join(String.raw`[\t\r\n]*`) + String.raw`[\t\r\n]*`).join("|");
const SPECIAL_URL_PREFIX = String.raw`(?:${SPECIAL_URL_SCHEME}):[ /\\\t\r\n]*`;
const OTHER_URL_PREFIX = String.raw`(?!(?:${SPECIAL_URL_SCHEME}):)[a-z][a-z\d+.\-\t\r\n]*:[\t\r\n]*\/[\t\r\n]*\/`;
const URL_USERINFO = new RegExp(String.raw`\b(${SPECIAL_URL_PREFIX})[^/\\?#]*@|\b(${OTHER_URL_PREFIX})[^/?#]*@`, "gi");
const DIAGNOSTIC_URL = new RegExp(String.raw`\b(?:${SPECIAL_URL_PREFIX}(?:[^/\\?#<>"]*@[^/\\?#<>"]*)?[^\s<>"]*|${OTHER_URL_PREFIX}(?:[^/?#<>"]*@[^/?#<>"]*)?[^\s<>"]*)`, "gi");

/** Removes URL credentials while preserving diagnostic host/path and ordinary query values.
 *  Use the probe's WHATWG parser before publishing credentials: special schemes accept
 *  backslashes/missing slashes and strip TAB/LF/CR, while spaces in userinfo are encoded.
 *  Invalid authorities still need conservative masking, not a parser-error escape hatch. */
export function redactEndpoint(url: string): string {
  let withoutUserinfo = url;
  if (url.includes("@")) {
    try {
      const parsed = new URL(url);
      if (parsed.username !== "" || parsed.password !== "") {
        parsed.username = "***";
        parsed.password = "";
        withoutUserinfo = parsed.href;
      }
    } catch {
      const raw = url.replace(/[\t\n\r]/g, "");
      const special = /^(?:https?|ftp|wss?|file):/i.test(raw.trimStart());
      const authority = special
        ? /^(\s*[a-z][a-z\d+.-]*:[ /\\]*)([^/\\?#]*@)/i
        : /^(\s*[a-z][a-z\d+.-]*:\/\/)([^/?#]*@)/i;
      withoutUserinfo = raw.replace(authority, "$1***@");
    }
    withoutUserinfo = withoutUserinfo.replace(URL_USERINFO, (_match, specialPrefix, otherPrefix) => `${specialPrefix ?? otherPrefix}***@`);
  }
  const fragment = withoutUserinfo.indexOf("#");
  const base = fragment < 0 ? withoutUserinfo : withoutUserinfo.slice(0, fragment);
  const query = base.indexOf("?");
  const redacted = query < 0 ? base : `${base.slice(0, query + 1)}${base.slice(query + 1).split("&").map((parameter) => {
    const key = new URLSearchParams(parameter.replace(/[\t\n\r]/g, "")).keys().next().value ?? "";
    return SECRET_CONFIG_KEY.test(key) ? `${parameter.split("=", 1)[0]}=***` : parameter;
  }).join("&")}`;
  // Fragments can carry either named credentials or opaque bearer values.
  return fragment < 0 ? redacted : `${redacted}#***`;
}

/** Uses the same URL policy inside probe diagnostics, even without a known endpoint.
 *  First consume a complete credential authority across whitespace, then its host/path.
 *  A whitespace tokenizer alone would publish the password suffix after SPACE/TAB/LF/CR.
 *  Conservative over-masking of an ambiguous malformed authority is intentional. */
export function redactEndpointText(text: string, endpoint?: string): string {
  const known = endpoint === undefined || endpoint === "" ? text : text.split(endpoint).join(redactEndpoint(endpoint));
  return known.replace(DIAGNOSTIC_URL, (url) => {
    const suffix = /[),.;]+$/.exec(url)?.[0] ?? "";
    return `${redactEndpoint(url.slice(0, url.length - suffix.length))}${suffix}`;
  });
}

/** Keep config comparisons private while making their reported values safe to inspect. */
export function publicConfigValue(path: string, value: unknown): unknown {
  const segments = (() => {
    try { return configPathParts(path).map((part) => part.kind === "key" ? part.key : part.field); }
    catch { return [path]; }
  })();
  if (segments.some((segment) => SECRET_CONFIG_KEY.test(segment))) return "[redacted]";
  return redactConfigValue(value);
}

function redactConfigValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (/^\s*[a-z][a-z\d+.\-\t\r\n]*:/i.test(value) && redactEndpoint(value) !== value) return "[redacted]";
    if (redactEndpointText(value) !== value) return "[redacted]";
    return value;
  }
  if (Array.isArray(value)) return value.map(redactConfigValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    SECRET_CONFIG_KEY.test(key) ? "[redacted]" : redactConfigValue(child),
  ]));
}

// Re-exported rather than reimplemented, so "which framework is this" has exactly one
// answer, not two copies that could drift.
export { frameworkVersion } from "#src/commands/management/lock.ts";
