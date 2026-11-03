import { posix } from "node:path";
import type { ExecResult } from "#src/runtime/transport/transport.ts";
import { MemoryError, object } from "./declaration.ts";

export const LOCAL_PLUGIN_ID = "llama-cpp";
export const LOCAL_PLUGIN_PACKAGE = "@openclaw/llama-cpp-provider";
/** Owner-declared purpose; adapters must not infer resource effects from argv or scripts. */
export interface NativeIntent {
  readonly role: "read" | "record-inspect" | "install" | "resource-read" | "deep-probe";
}
/** Transport supplied by the caller: all reads/writes share its helper and remaining budget. */
export interface NativeIO {
  cli(args: string[], intent: NativeIntent): Promise<ExecResult>;
  node(script: string, args: string[], intent: NativeIntent): Promise<ExecResult>;
}
export interface NativePlugin {
  id: typeof LOCAL_PLUGIN_ID;
  version: string;
  status: string;
  installPath: string;
  integrity?: string;
}
export interface NativeScope {
  denied: boolean;
  globallyDisabled: boolean;
  selectedDisabled: boolean;
  allowAddition: boolean;
}
export interface NativeSnapshot {
  nativeVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  configRoot: string;
  scope: NativeScope;
  plugin?: NativePlugin;
}
export interface NativeInstallResult {
  changed: boolean;
  nativePersistenceAttempted: boolean;
  snapshot: NativeSnapshot;
}
export interface NativeFailure {
  code: string;
  exitCode?: number;
  timedOut?: boolean;
  mutationAttempted: boolean;
  nativePersistenceAttempted: boolean;
}
export function nativeFailure(error: unknown): NativeFailure {
  const e = error instanceof MemoryError ? error : undefined, cause = object(e?.cause);
  return { code: e?.code ?? "UNSUPPORTED", mutationAttempted: cause.mutationAttempted === true,
    nativePersistenceAttempted: cause.nativePersistenceAttempted === true,
    ...(typeof cause.exitCode === "number" ? { exitCode: cause.exitCode } : {}),
    ...(cause.timedOut === true ? { timedOut: true } : {}) };
}
function refuse(message: string): never { throw new MemoryError("UNSUPPORTED", message); }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse("Native record shape unknown; inspect before setup.");
  return object(value);
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) refuse("Native metadata absent or unsupported.");
  return value;
}
// Exact registry versions only, never tags, ranges, paths, aliases or npm selectors.
function exactVersion(value: unknown): string {
  const v = text(value);
  const numeric = "(?:0|[1-9][0-9]*)";
  const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
  const semver = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
  if (v.length > 128 || /\s/.test(v) || !semver.test(v)) refuse("Require an exact approved plugin version.");
  return v;
}
function successful(result: ExecResult, mutationAttempted = false): string {
  if (result.code !== 0 || result.timedOut) throw new MemoryError(result.timedOut ? "DEADLINE" : "UNSUPPORTED",
    "Native operation failed; inspect compatibility/policy and persistent state before retrying. No automatic overwrite, upgrade or rollback.",
    { exitCode: result.code, timedOut: result.timedOut === true, mutationAttempted });
  return result.stdout;
}
function json(result: ExecResult): unknown {
  const output = successful(result);
  try { return JSON.parse(output); } catch { return refuse("Native JSON capability unsupported; inspect installed tools."); }
}
function canonical(value: unknown): string {
  const path = text(value);
  if (!posix.isAbsolute(path) || posix.normalize(path) !== path || path === "/") refuse("Require canonical persistent native paths.");
  return path;
}
function inside(root: string, path: string): boolean { return path.startsWith(`${root}/`); }
function strings(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v) || new Set(value).size !== value.length) refuse("Native plugin policy shape unsupported.");
  return value as string[];
}
function scopeOf(raw: unknown): NativeScope {
  const cfg = record(raw), allow = strings(cfg.allow), deny = strings(cfg.deny);
  if (cfg.enabled !== undefined && typeof cfg.enabled !== "boolean") refuse("Native enabled policy unsupported.");
  const entries = cfg.entries === undefined ? {} : record(cfg.entries);
  const selected = entries[LOCAL_PLUGIN_ID] === undefined ? {} : record(entries[LOCAL_PLUGIN_ID]);
  if (selected.enabled !== undefined && typeof selected.enabled !== "boolean") refuse("Selected plugin enabled policy unsupported.");
  return { denied: deny.includes(LOCAL_PLUGIN_ID), globallyDisabled: cfg.enabled === false,
    selectedDisabled: selected.enabled === false, allowAddition: allow.length > 0 && !allow.includes(LOCAL_PLUGIN_ID) };
}
/** Framework helper probe, not a native DTO. Reject symlinks and nested/ephemeral mounts.
 * State/config environment must agree with the framework's persistent config mapping.
 * No assumed extensions/npm subdirectory: installPath comes exclusively from inspect. */
export const NATIVE_PATH_CHECK_SCRIPT = `const fs=require('node:fs'),p=require('node:path');try{const [root,install,source]=process.argv.slice(1);const canonical=x=>p.isAbsolute(x)&&p.normalize(x)===x&&fs.realpathSync(x)===x;const decode=x=>x.replace(/\\\\([0-7]{3})/g,(_,n)=>String.fromCharCode(parseInt(n,8)));const mounts=fs.readFileSync('/proc/self/mountinfo','utf8').trim().split('\\n').map(l=>decode(l.split(' ')[4]));const owner=x=>mounts.filter(m=>x===m||x.startsWith(m+'/')).sort((a,b)=>b.length-a.length)[0];if(process.platform!=='linux'||!canonical(root)||!fs.statSync(root).isDirectory()||owner(root)!==root||process.env.OPENCLAW_STATE_DIR!==root||process.env.OPENCLAW_CONFIG_DIR!==root||process.env.OPENCLAW_CONFIG_PATH!==p.join(root,'openclaw.json'))throw Error();if(install){if(!install.startsWith(root+'/')||!canonical(install)||!fs.statSync(install).isDirectory()||owner(install)!==root)throw Error();if(!source||!canonical(source)||(source!==install&&!source.startsWith(install+'/'))||owner(source)!==root)throw Error()}console.log(JSON.stringify({platform:process.platform,arch:process.arch,nodeVersion:process.version,configRoot:root}))}catch{process.exit(2)}`;

/** Inspect-all attaches records only to discovered plugins (receipt lines 79-89).
 * For an absent selected row, call the captured native reader exports: o=store path,
 * r=persisted records, t=canonical+recovered loader (receipt line 512).
 * Discover the hashed module locally; absent/ambiguous exports fail closed, not a
 * fabricated SQLite filename/schema. This capability is checked only before install. */
export interface NativeAbsenceDependencies {
  fs: Pick<typeof import("node:fs"), "readdirSync" | "lstatSync" | "realpathSync" | "readFileSync">;
  path: Pick<typeof import("node:path"), "join" | "isAbsolute" | "normalize" | "sep">;
  fileURL(path: string): string;
  load?(url: string): Promise<Record<string, unknown>>;
}
export async function nativeAbsentOperation(root: string, id: string, name: string, cwd: string, deps: NativeAbsenceDependencies): Promise<{ absent: true }> {
  const { fs, path } = deps;
  const dist = path.join(cwd, "dist");
  const files = fs.readdirSync(dist).filter((file) => file.startsWith("installed-plugin-index-record-reader-") && file.endsWith(".js"));
  if (files.length !== 1) throw Error("Native record-reader capability ambiguous or absent.");
  const moduleURL = deps.fileURL(path.join(dist, files[0]!));
  const module = deps.load ? await deps.load(moduleURL) : await import(moduleURL) as Record<string, unknown>;
  if (typeof module.o !== "function" || typeof module.r !== "function" || typeof module.t !== "function") throw Error("Native record-reader exports unsupported.");
  const options = { stateDir: root };
  const store: unknown = module.o(options);
  if (typeof store !== "string" || !path.isAbsolute(store) || path.normalize(store) !== store || !store.startsWith(`${root}${path.sep}`)) throw Error("Native record store is outside persistent state.");
  const inspectRecords = (records: unknown): void => {
    if (records === null || typeof records !== "object" || Array.isArray(records)) throw Error("Native record inventory unsupported.");
    const paths = new Set<string>();
    for (const [key, value] of Object.entries(records)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Native install record unsupported.");
      const record = value as Record<string, unknown>;
      if (!["npm", "path", "git", "clawhub"].includes(record.source as string)) throw Error("Native install source unknown.");
      if (key === id || record.resolvedName === name || record.spec === name ||
          (typeof record.spec === "string" && record.spec.startsWith(`${name}@`))) throw Error("Existing/orphan official install record; no installation authorized.");
      if (record.installPath !== undefined) {
        if (typeof record.installPath !== "string" || !path.isAbsolute(record.installPath) || path.normalize(record.installPath) !== record.installPath || paths.has(record.installPath)) throw Error("Native install path unknown or colliding.");
        paths.add(record.installPath);
      }
    }
  };
  const exists = (file: string): boolean => {
    try { fs.lstatSync(file); return true; }
    catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; return false; }
  };
  // Native recovery skips failed stats/manifests (receipt 365-383); independently
  // reject unreadable project metadata or residual selected package bytes.
  const inspectProject = (directory: string, depth: number): void => {
    if (!exists(directory)) return;
    if (depth > 12 || fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()) throw Error("Managed npm project boundary unsupported.");
    const manifest = path.join(directory, "package.json");
    if (exists(manifest)) {
      if (fs.realpathSync(manifest) !== manifest) throw Error("Managed npm manifest symlink unsupported.");
      const metadata: unknown = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw Error("Managed npm metadata unreadable.");
      const packageMetadata = metadata as Record<string, unknown>;
      for (const field of ["dependencies", "optionalDependencies", "devDependencies"]) {
        const dependencies = packageMetadata[field];
        if (dependencies !== undefined && (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies))) throw Error("Managed npm dependency metadata unsupported.");
        if (dependencies && Object.hasOwn(dependencies, name)) throw Error("Residual official managed npm dependency; review before installation.");
      }
    }
    if (exists(path.join(directory, "node_modules", ...name.split("/")))) throw Error("Residual official package bytes; review before installation.");
    for (const entry of fs.readdirSync(directory)) {
      if (entry === "node_modules") continue;
      const child = path.join(directory, entry), stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) throw Error("Managed npm project symlink unsupported.");
      if (stat.isDirectory()) inspectProject(child, depth + 1);
    }
  };
  inspectProject(path.join(root, "npm"), 0);
  if (exists(store)) {
    if (fs.realpathSync(store) !== store) throw Error("Native store symlink unsupported.");
    // Native persistence errors collapse to null; never treat that as empty inventory.
    inspectRecords(await module.r(options));
  }
  // Native loader also recovers managed npm projects, including unpersisted records.
  inspectRecords(await module.t(options));
  return { absent: true };
}
export const NATIVE_ABSENCE_CHECK_SCRIPT = `const fs=require('node:fs'),path=require('node:path'),url=require('node:url');(${nativeAbsentOperation.toString()})(...process.argv.slice(1),process.cwd(),{fs,path,fileURL:p=>url.pathToFileURL(p).href}).then(value=>console.log(JSON.stringify(value)),()=>process.exit(2))`;

function pluginOf(raw: unknown, root: string, approvedVersion?: string): { plugin?: NativePlugin; source: string } {
  if (!Array.isArray(raw) || raw.length > 4096) refuse("Native inspect-all inventory unsupported.");
  const ids = new Set<string>(), paths = new Set<string>();
  let selected: Record<string, unknown> | undefined;
  for (const value of raw) {
    const row = record(value), plugin = record(row.plugin), id = text(plugin.id);
    if (ids.has(id)) refuse("Plugin id collision; repair native inventory before setup.");
    ids.add(id);
    if (row.install !== undefined && row.install !== null) {
      const install = record(row.install);
      if (!["npm", "path", "git", "clawhub"].includes(text(install.source))) refuse("Unknown native install record source; review before setup.");
      if (install.installPath !== undefined) {
        const path = canonical(install.installPath);
        if (paths.has(path)) refuse("Install path collision; repair native inventory before setup.");
        paths.add(path);
      }
      if (id !== LOCAL_PLUGIN_ID && (install.resolvedName === LOCAL_PLUGIN_PACKAGE ||
          (typeof install.spec === "string" && (install.spec === LOCAL_PLUGIN_PACKAGE || install.spec.startsWith(`${LOCAL_PLUGIN_PACKAGE}@`))))) refuse("Official package is recorded under a different plugin id; no mutation authorized.");
    }
    if (id === LOCAL_PLUGIN_ID) selected = row;
  }
  if (!selected) return { source: "" };
  const plugin = record(selected.plugin), install = record(selected.install);
  if (install.source !== "npm" || install.resolvedName !== LOCAL_PLUGIN_PACKAGE) refuse("Existing llama-cpp provenance is unknown or different; no overwrite authorized.");
  // Missing resolvedVersion may only fall back to a matching exact recorded spec/version.
  let version: string;
  if (install.resolvedVersion !== undefined) version = exactVersion(install.resolvedVersion);
  else {
    version = exactVersion(install.version);
    if (install.spec !== `${LOCAL_PLUGIN_PACKAGE}@${version}`) refuse("Missing resolved version requires exact official recorded spec/version.");
  }
  if (approvedVersion !== undefined && version !== approvedVersion) refuse("Existing plugin differs from the approved version; no overwrite authorized.");
  if (install.version !== undefined && install.version !== version) refuse("Native install versions disagree.");
  if (plugin.version !== undefined && plugin.version !== version) refuse("Native plugin status version disagrees with install provenance.");
  const installPath = canonical(install.installPath), source = canonical(plugin.source);
  if (!inside(root, installPath) || !(source === installPath || inside(installPath, source))) refuse("Plugin source is shadowed or outside the persistent config mount.");
  const integrity = install.integrity === undefined ? undefined : text(install.integrity);
  return { plugin: { id: LOCAL_PLUGIN_ID, version, status: text(plugin.status), installPath, ...(integrity ? { integrity } : {}) }, source };
}
async function readSnapshot(io: NativeIO, configRoot: string, approvedVersion?: string): Promise<NativeSnapshot> {
  const root = canonical(configRoot), approved = approvedVersion === undefined ? undefined : exactVersion(approvedVersion);
  const versionOutput = successful(await io.cli(["--version"], { role: "resource-read" })).trim();
  const match = /^OpenClaw\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s+\([^\r\n]*\))?$/.exec(versionOutput);
  if (!match) refuse("Native version unreadable; inspect current helper capabilities.");
  const inspectHelp = successful(await io.cli(["plugins", "inspect", "--help"], { role: "read" }));
  if (!/--all\b/.test(inspectHelp) || !/--json\b/.test(inspectHelp)) refuse("Native inspect capabilities unsupported.");
  const scope = scopeOf(json(await io.cli(["config", "get", "plugins", "--json"], { role: "read" })));
  const selected = pluginOf(json(await io.cli(["plugins", "inspect", "--all", "--json"], { role: "record-inspect" })), root, approved);
  const helper = record(json(await io.node(NATIVE_PATH_CHECK_SCRIPT, [root, selected.plugin?.installPath ?? "", selected.source], { role: "resource-read" })));
  if (helper.platform !== "linux" || helper.configRoot !== root) refuse("Helper persistent filesystem contract unsupported.");
  return { nativeVersion: match[1]!, nodeVersion: text(helper.nodeVersion), platform: "linux", arch: text(helper.arch),
    configRoot: root, scope, ...(selected.plugin ? { plugin: selected.plugin } : {}) };
}
export async function readNativeSnapshot(io: NativeIO, configRoot: string, approvedVersion?: string): Promise<NativeSnapshot> {
  try { return await readSnapshot(io, configRoot, approvedVersion); }
  catch (error) {
    const failure = nativeFailure(error);
    throw new MemoryError(failure.code, "Native provenance/helper read unsupported or failed; inspect capabilities, policy and persistent paths before setup.", failure);
  }
}
export function requireNativeLoaded(snapshot: NativeSnapshot): NativePlugin {
  const { scope, plugin } = snapshot;
  if (scope.denied || scope.globallyDisabled || scope.selectedDisabled || scope.allowAddition) throw new MemoryError("PLUGIN", "Selected official plugin is blocked by explicit native policy; review before enabling.");
  if (!plugin || plugin.status !== "loaded") throw new MemoryError("PLUGIN", "Official llama-cpp with verified native provenance must be loaded; no implicit installation.");
  return plugin;
}
async function installCapabilities(io: NativeIO): Promise<void> {
  const inspect = successful(await io.cli(["plugins", "inspect", "--help"], { role: "read" }));
  const install = successful(await io.cli(["plugins", "install", "--help"], { role: "read" }));
  if (!/--all\b/.test(inspect) || !/--json\b/.test(inspect) || !/--pin\b/.test(install)) refuse("Native inspect/install capabilities unsupported; no patch-version assumption.");
}
/** Caller owns the instance lock. Approval permits a new install's selected enable/allow
 * addition, never overrides an explicit selected disable or repairs existing code.
 * Native installer owns package/API compatibility and persistence. Never force or remove deny.
 * A failed mutation is not proof of rollback: safe failure marks attempted work for inspection. */
export async function installNativePlugin(io: NativeIO, configRoot: string, approvedVersion: string, allowInstall: boolean): Promise<NativeInstallResult> {
  const version = exactVersion(approvedVersion);
  let mutationAttempted = false, nativePersistenceAttempted = false;
  try {
    const before = await readNativeSnapshot(io, configRoot, version);
    if (before.scope.denied || before.scope.globallyDisabled || before.scope.selectedDisabled) refuse("Explicit native deny/disable refuses setup before mutation.");
    if (before.plugin?.status === "loaded" && !before.scope.selectedDisabled && !before.scope.allowAddition) return { changed: false, nativePersistenceAttempted: false, snapshot: before };
    if (!allowInstall) refuse("Explicit allow-install required for package installation and selected enable/allow addition.");
    if (before.plugin) refuse("Existing plugin is not loaded/allowed; no automatic installation repair or enable override.");
    await installCapabilities(io);
    // Native database opening may initialize/migrate; approval covers this resource
    // attempt, and failure must not be presented as a guaranteed unchanged read.
    nativePersistenceAttempted = true;
    const absence = record(json(await io.node(NATIVE_ABSENCE_CHECK_SCRIPT, [before.configRoot, LOCAL_PLUGIN_ID, LOCAL_PLUGIN_PACKAGE], { role: "record-inspect" })));
    if (absence.absent !== true) refuse("Canonical/recovered native record absence not established; no installation authorized.");
    mutationAttempted = true;
    successful(await io.cli(["plugins", "install", `${LOCAL_PLUGIN_PACKAGE}@${version}`, "--pin"], { role: "install" }), true);
    const after = await readNativeSnapshot(io, configRoot, version);
    requireNativeLoaded(after);
    return { changed: true, nativePersistenceAttempted, snapshot: after };
  } catch (error) {
    const failure = nativeFailure(error);
    throw new MemoryError(failure.code, "Native setup did not establish a verified loaded official plugin; inspect persistent compatibility/policy state. No automatic retry or rollback.",
      { ...failure, mutationAttempted: mutationAttempted || failure.mutationAttempted,
        nativePersistenceAttempted: nativePersistenceAttempted || failure.nativePersistenceAttempted });
  }
}
