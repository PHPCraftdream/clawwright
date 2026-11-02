import { parseMigrationBackup, parseEphemeralPaths } from "../../../service/recipe.ts";
import { hasControlCharacter } from "../../../core/values/names.ts";
import { probeExists, TargetReadUnknownError, type TargetRead } from "../../transport/transport.ts";
import { randomUUID } from "node:crypto";
import type { StackContainerEvidence, StackMigrateOptions, StackMigratePlan, StackMigrationResult } from "../../runtime.ts";
import { array, execResult, json, object, text, preflightStaging, type StackIO } from "./io.ts";
import { tryParseLocalImageId } from "../image-ref.ts";
import { requireOwned, records } from "./inspection.ts";
import { assertEffectiveConfig, pinnedService, readinessSeconds } from "./recovery/index.ts";

// The shared worker API is a prerequisite; never substitute a weaker local check.
export const assertMigrationConfig = assertEffectiveConfig;

export interface Storage {
  type: "bind" | "volume";
  source: string;
  target: string;
  key: string;
  topology?: string;
}
export interface ReadonlyBindProof {
  source: string;
  root: string;
  identity: string;
}
export interface MigrationPrepared {
  plan: SideStackMigratePlan;
  ephemeralPaths: readonly string[];
  raw: Record<string, unknown>[];
  sourceDocument: Record<string, unknown>;
  imageConfigs: Record<string, Record<string, unknown>>;
  document: Record<string, unknown>;
  containers: readonly StackContainerEvidence[];
  storage: Storage[];
  readonlyBindProofs: ReadonlyBindProof[];
  helperImage: string;
  fingerprint: string;
  seconds: number;
}
export const safePath = (path: string): boolean => /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path) && !path.split("/").some((part) => part === "." || part === "..");
export const overlaps = (left: string, right: string): boolean => left === right || left.startsWith(right + "/") || right.startsWith(left + "/");

/** Capture initially; supply identity to fail closed on executor revalidation. */
export async function verifyReadonlyBind(io: Pick<StackIO, "transport">,
  proof: { source: string; root: string; identity?: string }): Promise<ReadonlyBindProof> {
  const { source, root } = proof;
  if (!safePath(source) || !safePath(root) || !source.startsWith(root + "/"))
    throw new Error("recipe migration readonly bind is not strictly contained");
  const script = `set -eu
export LC_ALL=C
check() {
  ancestor=
  p=$1
  IFS=/
  for part in $p; do
    [ -n "$part" ] || continue
    ancestor=$ancestor/$part
    [ ! -L "$ancestor" ] || exit 20
    if [ "$ancestor" = "$p" ]; then
      [ -f "$ancestor" ] || exit 21
    else
      [ -d "$ancestor" ] && [ -x "$ancestor" ] || exit 22
    fi
  done
  [ -d "$2" ] && [ ! -L "$2" ] || exit 23
  [ "$(realpath -e -- "$p")" = "$p" ] || exit 24
  [ "$(realpath -e -- "$2")" = "$2" ] || exit 25
  stat -c '%f:%d:%i' -- "$2"
  stat -c '%f:%d:%i:%s:%y:%z' -- "$p"
}
first=$(check "$1" "$2")
second=$(check "$1" "$2")
[ "$first" = "$second" ] || exit 26
printf '%s' "$first"`;
  try {
    const result = execResult(await io.transport.exec("sh", ["-c", script, "sh", source, root],
      { allowFailure: true, stream: false, timeoutMs: 10_000 }));
    if (result.code !== 0 || result.timedOut || result.stderr !== "" || result.stdout.length > 512)
      throw new Error("readonly file/root metadata unproven");
    const metadata = /^([0-9a-f]{1,8}):[0-9]{1,20}:[0-9]{1,20}\n([0-9a-f]{1,8}):[0-9]{1,20}:[0-9]{1,20}:[0-9]{1,20}:[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{9} [+-][0-9]{4}:[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{9} [+-][0-9]{4}$/.exec(result.stdout);
    if (metadata === null)
      throw new Error("readonly file/root metadata unproven");
    const directoryMode = parseInt(metadata[1]!, 16);
    const fileMode = parseInt(metadata[2]!, 16);
    if ((directoryMode & 0xf000) !== 0x4000
      || (fileMode & 0xf000) !== 0x8000
      || (proof.identity !== undefined && proof.identity !== result.stdout))
      throw new Error("readonly file/root identity changed");
    return { source, root, identity: result.stdout };
  } catch (error) {
    throw new TargetReadUnknownError("recipe migration readonly bind unsafe or unknown", { cause: error });
  }
}

interface RestartPolicy {
  name: "no" | "unless-stopped" | "always" | "on-failure";
  maxRetries: number;
}
function configuredRestart(value: unknown): RestartPolicy {
  const configured = value === undefined ? "no" : text(value);
  const match = /^(no|unless-stopped|always|on-failure)(?::([0-9]+))?$/.exec(configured);
  if (!match || (match[2] !== undefined && match[1] !== "on-failure"))
    throw new Error("recipe migration configured restart policy unsupported");
  const maxRetries = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0)
    throw new Error("recipe migration restart retry limit malformed");
  return { name: match[1] as RestartPolicy["name"], maxRetries };
}
export function assertRestartPolicy(hostConfig: Record<string, unknown>, source: Record<string, unknown>, target: Record<string, unknown>): void {
  const observed = object(hostConfig["RestartPolicy"]);
  const name = text(observed["Name"]) || "no";
  const maxRetries = observed["MaximumRetryCount"];
  if (!Number.isSafeInteger(maxRetries) || (maxRetries as number) < 0)
    throw new Error("recipe migration observed restart retry limit malformed");
  for (const service of [source, target]) {
    const expected = configuredRestart(service["restart"]);
    if (expected.name !== name || expected.maxRetries !== maxRetries)
      throw new Error("recipe migration source/target restart policy differs from HostConfig");
  }
}

export function rawMounts(raw: Record<string, unknown>) {
  return array(raw["Mounts"]).map((value) => {
    const m = object(value);
    if (typeof m["RW"] !== "boolean") throw new Error("recipe migration mount access unknown");
    return { type: text(m["Type"]), source: text(m["Source"]), destination: text(m["Destination"]), writable: m["RW"],
      ...(m["Name"] === undefined ? {} : { name: text(m["Name"]) }) };
  });
}
export function assertWritableLayerMetadata(changes: string, mounts: readonly { type: string; destination: string }[],
  ephemeralPaths: readonly string[] = [], sanitize: (path: string) => string = (path) => path): readonly number[] {
  const counts = ephemeralPaths.map(() => 0);
  if (changes === "") return counts;
  const destinations = new Set<string>();
  for (const mount of mounts) {
    if (["volume", "bind"].includes(mount.type) && safePath(mount.destination)) destinations.add(mount.destination);
  }
  const output = changes.endsWith("\n") ? changes.slice(0, -1) : changes;
  const entries = output.split("\n").map((line) => {
    const match = /^([ACD]) (\/[^\r\n]*)$/.exec(line);
    const path = match?.[2];
    if (!path || path.includes("\\") || hasControlCharacter(path)
      || (path !== "/" && path.slice(1).split("/").some((part) => part === "" || part === "." || part === "..")))
      throw new Error("recipe migration writable-layer application data is unsupported; malformed Docker diff; see recipe.json ephemeralPaths");
    return { operation: match![1], path };
  });
  const offending: string[] = [];
  for (const { operation, path } of entries) {
    if (operation === "A" && destinations.has(path)) continue;
    const index = ephemeralPaths.findIndex((root) => path === root || path.startsWith(root + "/"));
    if (index >= 0) counts[index]!++;
    else offending.push(path);
  }
  if (offending.length) {
    const roots = [...new Set(offending)].filter((path) => !offending.some((other) => other !== path && path.startsWith(other + "/")));
    throw new Error(`recipe migration writable-layer application data is unsupported; offending paths: ${roots.slice(0, 10).map((path) => JSON.stringify(sanitize(path))).join(", ")}${roots.length > 10 ? "; more paths omitted" : ""}; see recipe.json ephemeralPaths`);
  }
  return counts;
}
export function volumeNames(stdout: string): string[] {
  const names = stdout === "" ? [] : stdout.trimEnd().split("\n");
  if (names.some((name) => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) || new Set(names).size !== names.length)
    throw new Error("recipe migration volume inventory malformed");
  return names;
}
export async function verifyWriters(io: StackIO, storage: Storage[], permitted: readonly string[]): Promise<void> {
  const output = (await io.run(["ps", "--all", "--quiet", "--no-trunc"])).stdout;
  const listed = output.trim() ? output.trim().split(/\s+/) : [];
  if (listed.some((id) => !/^[a-f0-9]{64}$/.test(id)) || new Set(listed).size !== listed.length) throw new Error("recipe migration writer IDs malformed");
  const all = listed.length ? array(json((await io.run(["inspect", ...listed])).stdout)).map(object) : [];
  const actual = all.map((raw) => text(raw["Id"]));
  if (all.length !== listed.length || new Set(actual).size !== actual.length || actual.some((id) => !listed.includes(id))
    || permitted.some((id) => !actual.includes(id))) throw new Error("recipe migration writer inventory unknown");
  for (const raw of all) {
    if (permitted.includes(text(raw["Id"]))) continue;
    for (const m of rawMounts(raw)) {
      if (storage.some((s) => s.type === "volume" ? m.name === s.source || m.name === s.target
        : m.type === "bind" && overlaps(m.source, s.source))) throw new Error("recipe migration storage has another potential writer");
    }
  }
}

export function backupParent(root: string): string {
  if (!safePath(root) || !/^.*\/\.clawwright-recipe-recovery\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(root))
    throw new Error("recipe migration backup root requires private recovery parent and exclusive UUID child");
  return root.slice(0, root.lastIndexOf("/"));
}

/** Read-only, lstat-style proof. An unreadable ancestor is unknown, never ENOENT. */
export async function validateBackupParent(io: Pick<StackIO, "transport">, root: string): Promise<TargetRead<string>> {
  const parent = backupParent(root);
  const script = `set -eu
uid=$(id -u)
p=$1
ancestor=
IFS=/
for part in $p; do
  [ -n "$part" ] || continue
  ancestor=$ancestor/$part
  [ ! -L "$ancestor" ] || exit 20
  if [ "$ancestor" = "$p" ] && [ ! -e "$ancestor" ]; then
    printf 'absent'; exit 0
  fi
  [ -d "$ancestor" ] && [ -x "$ancestor" ] || exit 21
  owner=$(stat -c %u -- "$ancestor")
  mode=$(stat -c %a -- "$ancestor")
  if [ "$ancestor" = "$p" ]; then
    [ "$owner" = "$uid" ] && [ "$mode" = 700 ] || exit 22
  else
    [ "$owner" = "$uid" ] || [ "$owner" = 0 ] || exit 23
    # Root-owned sticky ancestors (e.g. /tmp) cannot replace an owned child.
    case "$mode" in 1???) [ "$owner" = 0 ] || exit 24;;
      *) [ $((0$mode & 0022)) -eq 0 ] || exit 24;; esac
  fi
done
[ "$(readlink -f -- "$p")" = "$p" ] || exit 25
[ ! -e "$2" ] && [ ! -L "$2" ] || exit 26
printf 'present'`;
  try {
    const result = execResult(await io.transport.exec("sh", ["-c", script, "sh", parent, root], { allowFailure: true, timeoutMs: 10_000 }));
    if (result.code !== 0 || result.timedOut || !["absent", "present"].includes(result.stdout))
      throw new Error("private parent/ancestors, ownership, permissions or child absence unproven");
    // The shell's negative test is only a candidate, never an ENOENT proof.
    // transport.exists uses errno-aware access locally and validated existsVia remotely.
    // The metadata walk above separately rejects symlinks (including dangling ones).
    const present = await probeExists(io.transport, parent);
    if (present !== (result.stdout === "present") || await probeExists(io.transport, root))
      throw new Error("private parent presence changed or child absence unproven");
    return present ? { kind: "present", value: parent } : { kind: "absent" };
  } catch (error) {
    throw new TargetReadUnknownError("recipe migration backup path unsafe or unknown", { cause: error });
  }
}

export async function createBackupRoot(io: Pick<StackIO, "transport">, root: string): Promise<void> {
  const t = io.transport;
  if (!t.mkdirPrivate) throw new Error("recipe migration requires exclusive private mkdir");
  const presence = await validateBackupParent(io, root);
  if (presence.kind === "absent") await t.mkdirPrivate(backupParent(root));
  // A collision is never adopted, chmodded or retried, including a competing parent mkdir.
  await validateBackupParent(io, root);
  await t.mkdirPrivate(root);
}

export const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;

export function shutdownSeconds(value: number = 180): number {
  if (!Number.isFinite(value) || value < 1 || value > 3600) throw new Error("recipe migration shutdown timeout must be 1..3600 finite seconds");
  return value;
}
export function gentleSignal(config: Record<string, unknown>): "SIGTERM" | "SIGINT" {
  const signal = config["StopSignal"] === undefined ? "SIGTERM" : config["StopSignal"];
  if (signal !== "SIGTERM" && signal !== "SIGINT") throw new Error("recipe migration image stop signal unsupported; only SIGTERM/SIGINT are established");
  return signal;
}

export async function prepareMigration(io: StackIO, options: SideStackMigrateOptions, token: string = randomUUID()): Promise<MigrationPrepared> {
  const ephemeralPaths = Object.freeze([...new Set(parseEphemeralPaths("migration", options.ephemeralPaths) ?? [])]);
  const ignoredCounts = ephemeralPaths.map(() => 0);
  const migrationBackup = parseMigrationBackup(options.migrationBackup);
  if (!migrationBackup) throw new Error("recipe migration requires explicit application-cold-safe author contract before planning");
  if (migrationBackup.consistency === "application-verified-cold" && typeof options.verifyMigrationBackup !== "function")
    throw new Error("recipe migration post-stop contract requires verifyMigrationBackup callback before planning");
  if (!safePath(options.backupRoot)) throw new Error("recipe migration requires a safe absolute backup root");
  const seconds = readinessSeconds(options.timeoutSeconds);
  const shutdownTimeoutSeconds = shutdownSeconds(options.shutdownTimeoutSeconds);
  if (options.helperImage !== undefined && tryParseLocalImageId(options.helperImage) === undefined)
    throw new Error("recipe migration helper requires an immutable local sha256 image ID");
  const owned = await requireOwned(io, true);
  if (owned.containers.some((c) => c.project === io.project)) throw new Error("recipe migration target namespace is populated");
  const namespaces = [...new Set(owned.containers.map((c) => c.project))];
  if (namespaces.length !== 1) throw new Error("recipe migration requires exactly one populated legacy namespace");
  const sourceProject = namespaces[0]!;
  const source = await records(io, sourceProject);
  if (migrationBackup.consistency === "application-verified-cold" && source.some((c) => c.evidence.state !== "running"))
    throw new Error("recipe migration conditional verification requires running source writers for current-stop evidence");
  const config = await io.config();
  const sourceDocument = await io.config(sourceProject);
  await preflightStaging(io, [config, sourceDocument], [options.backupRoot]);
  const imageConfigs: Record<string, Record<string, unknown>> = {};
  const services = object(config["services"]);
  const volumes = object(config["volumes"] ?? {});
  const serviceNames = Object.keys(services).sort();
  if (serviceNames.length === 0 || source.length !== serviceNames.length) throw new Error("recipe migration requires one source replica for every configured service");
  const storage: Storage[] = [];
  const readonlyBinds: { source: string }[] = [];
  const readonlyBindProofs: ReadonlyBindProof[] = [];
  const volumeMappings = new Map<string, string>();
  const pinned: Record<string, unknown> = {};
  for (const name of serviceNames) {
    const replicas = source.filter((c) => c.evidence.service === name);
    if (replicas.length !== 1) throw new Error("recipe migration service/replica mismatch");
    const container = replicas[0]!;
    const evidence = container.evidence;
    const state = object(container.raw["State"]);
    if (!["running", "exited", "created"].includes(evidence.state ?? "") || state["OOMKilled"] !== false
      || state["Paused"] === true || state["Restarting"] === true
      || (evidence.state === "exited" && evidence.exitCode !== 0)) throw new Error("recipe migration cold consistency is unsupported");
    const service = object(services[name]);
    const hostConfig = object(container.raw["HostConfig"]);
    // Safety shutdown must separately use docker stop --timeout -1 to suppress restart.
    assertRestartPolicy(hostConfig, object(object(sourceDocument["services"])[name]), service);
    if (hostConfig["Privileged"] === true || array(hostConfig["Devices"] ?? []).length || array(hostConfig["VolumesFrom"] ?? []).length
      || Object.keys(object(hostConfig["Tmpfs"] ?? {})).length) throw new Error("recipe migration source isolation is unsupported");
    const actual = rawMounts(container.raw);
    for (const key of ["volumes_from", "devices", "privileged", "container_name", "network_mode", "pid", "ipc", "tmpfs", "secrets", "configs"]) {
      if (service[key] !== undefined) throw new Error("recipe migration unsupported service storage/isolation");
    }
    const declared = array(service["volumes"] ?? []).map(object);
    if (declared.length !== actual.length || new Set(declared.map((m) => text(m["target"]))).size !== declared.length)
      throw new Error("recipe migration has unproven mounts");
    const rewritten: Record<string, unknown>[] = [];
    for (const mount of declared) {
      const type = text(mount["type"]);
      const destination = text(mount["target"]);
      const match = actual.filter((m) => m.destination === destination);
      if (match.length !== 1 || !safePath(destination)) throw new Error("recipe migration mount identity mismatch");
      const old = match[0]!;
      if (mount["read_only"] !== undefined && typeof mount["read_only"] !== "boolean")
        throw new Error("recipe migration mount access unknown");
      const readonly = mount["read_only"] === true;
      if (old.type !== type || !["bind", "volume"].includes(type) || old.writable !== !readonly || (readonly && type !== "bind"))
        throw new Error("recipe migration unsupported mount access");
      if (type === "bind") {
        const root = text(mount["source"]);
        if (root !== old.source || !safePath(root) || overlaps(root, options.backupRoot)) throw new Error("recipe migration bind root changed or backup overlaps data");
        if (readonly) {
          // Resolve ownership only after every service's RW storage has been collected.
          readonlyBinds.push({ source: root });
          rewritten.push({ type: "bind", source: root, target: destination, read_only: true, bind: { create_host_path: false } });
          continue;
        }
        if (storage.some((s) => s.type === "bind" && overlaps(s.source, root))) throw new Error("recipe migration shared/overlapping bind roots unsupported");
        storage.push({ type: "bind", source: root, target: root, key: `data-${storage.length}` });
        rewritten.push({ type: "bind", source: root, target: destination, bind: { create_host_path: false } });
      } else {
        const key = text(mount["source"]);
        const definition = object(volumes[key]);
        if (definition["external"] || definition["driver_opts"] !== undefined || (definition["driver"] !== undefined && definition["driver"] !== "local")) throw new Error("recipe migration unsupported named volume");
        const target = text(definition["name"]);
        const expectedSource = `${sourceProject}_${key}`;
        if (target !== `${io.project}_${key}` || old.name !== expectedSource) throw new Error("recipe migration volume namespace mismatch");
        if (volumeMappings.has(expectedSource)) throw new Error("recipe migration shared volume writers unsupported");
        volumeMappings.set(expectedSource, target);
        storage.push({ type: "volume", source: expectedSource, target, key: `data-${storage.length}` });
        rewritten.push({ type: "volume", source: key, target: destination, volume: { nocopy: true } });
      }
    }
    const sanitizePath = migrationPathSanitizer(io, container.raw);
    for (const path of ephemeralPaths) {
      for (const mount of actual) {
        if (path === mount.destination || mount.destination.startsWith(path + "/")) {
          throw new Error(`recipe.json ephemeralPaths ${JSON.stringify(sanitizePath(path))} conflicts with verified mount destination ${JSON.stringify(sanitizePath(mount.destination))}`);
        }
      }
    }
    const counts = assertWritableLayerMetadata((await io.run(["diff", evidence.id])).stdout, actual, ephemeralPaths, sanitizePath);
    counts.forEach((count, index) => { ignoredCounts[index]! += count; });
    const image = tryParseLocalImageId(evidence.imageId!);
    if (image === undefined) throw new Error("recipe migration source requires an immutable local sha256 image ID");
    const imageRecords = array(json((await io.run(["image", "inspect", image])).stdout));
    if (imageRecords.length !== 1 || object(imageRecords[0])["Id"] !== image) throw new Error("recipe migration exact image unavailable");
    // Anonymous image volumes cannot silently add unbacked storage.
    const imageConfig = object(object(imageRecords[0])["Config"]);
    if (Object.keys(object(imageConfig["Volumes"] ?? {})).some((path) => !actual.some((m) => m.destination === path))) throw new Error("recipe migration anonymous image volume unsupported");
    const signal = gentleSignal(imageConfig);
    if ((object(container.raw["Config"])["StopSignal"] === undefined ? "SIGTERM" : object(container.raw["Config"])["StopSignal"]) !== signal
      || (service["stop_signal"] !== undefined && service["stop_signal"] !== signal)
      || (object(object(sourceDocument["services"])[name])["stop_signal"] !== undefined
        && object(object(sourceDocument["services"])[name])["stop_signal"] !== signal))
      throw new Error("recipe migration declared image stop signal differs from effective writer signal");
    imageConfigs[name] = imageConfig;
    assertMigrationConfig(object(sourceDocument["services"])[name], imageConfig, [container.raw], sourceDocument);
    // Compare the target's requested effective configuration against the old namespace.
    const comparison = { ...config, volumes: Object.fromEntries(Object.entries(volumes).map(([key, value]) => [key, { ...object(value), name: `${sourceProject}_${key}` }])) };
    const effective = assertMigrationConfig(service, imageConfig, [container.raw], comparison);
    pinned[name] = { ...pinnedService(effective, image), volumes: rewritten };
  }
  // RO files are covered by their unique owned RW directory archive, not extra storage.
  for (const bind of readonlyBinds) {
    const owners = storage.filter((s) => s.type === "bind" && bind.source.startsWith(s.source + "/"));
    if (owners.length !== 1) throw new Error("recipe migration readonly bind lacks a unique containing RW directory");
    const root = owners[0]!.source;
    if (!readonlyBindProofs.some((proof) => proof.source === bind.source && proof.root === root))
      readonlyBindProofs.push(await verifyReadonlyBind(io, { source: bind.source, root }));
  }
  const existingVolumes = volumeNames((await io.run(["volume", "ls", "--format", "{{.Name}}"])).stdout);
  if (storage.some((s) => s.type === "volume" && existingVolumes.includes(s.target))) throw new Error("recipe migration target volume already exists");
  for (const s of storage.filter((item) => item.type === "volume")) {
    const inspected = array(json((await io.run(["volume", "inspect", s.source])).stdout));
    if (inspected.length !== 1) throw new Error("recipe migration source volume unknown");
    const v = object(inspected[0]);
    const labels = object(v["Labels"]);
    if (v["Name"] !== s.source || v["Driver"] !== "local" || Object.keys(object(v["Options"] ?? {})).length
      || labels["com.docker.compose.project"] !== sourceProject
      || s.source !== `${sourceProject}_${text(labels["com.docker.compose.volume"])}`) throw new Error("recipe migration volume ownership unproven");
  }
  await verifyWriters(io, storage, source.map((c) => c.evidence.id));
  await validateBackupParent(io, options.backupRoot);
  const helperImage = tryParseLocalImageId(options.helperImage ?? source[0]!.evidence.imageId!);
  if (helperImage === undefined)
    throw new Error("recipe migration helper requires an immutable local sha256 image ID");
  const helperRecords = array(json((await io.run(["image", "inspect", helperImage])).stdout));
  if (helperRecords.length !== 1 || object(helperRecords[0])["Id"] !== helperImage)
    throw new Error("recipe migration exact local helper image unavailable");
  const helperConfig = object(object(helperRecords[0])["Config"]);
  const sanitizePaths = (path: string): string => {
    for (const container of source) path = migrationPathSanitizer(io, container.raw)(path);
    return path;
  };
  const ignoredEphemeralPaths = freezeIgnored(ephemeralPaths, ignoredCounts, sanitizePaths);
  const plan: SideStackMigratePlan = Object.freeze({ ignoredEphemeralPaths, helperImage, shutdownTimeoutSeconds, migrationBackup, token, sourceProject, targetProject: io.project,
    services: Object.freeze(serviceNames), backupRoot: options.backupRoot,
    volumes: Object.freeze(storage.filter((s) => s.type === "volume").map((s) => Object.freeze({ source: s.source, target: s.target }))),
    inventory: Object.freeze(source.map((c) => c.evidence)),
    images: Object.freeze(source.map((c) => Object.freeze({ service: c.evidence.service!, imageId: c.evidence.imageId! }))),
    impacts: Object.freeze([...ignoredEphemeralPaths.map(({ path, count }) => `ignored as ephemeral by the recipe: ${path} (${count} entries)`), "gracefully stop all source writers", "verify cold full storage archives", "copy named volumes into fresh namespace", "preserve shared bind roots", "start target with exact images; no builds or pulls", "retain source volumes and private backups", "restore bind backups before source resume after target writes"]) });
  const document = { ...config, services: pinned };
  return { plan, ephemeralPaths, document, sourceDocument, imageConfigs, raw: source.map((c) => c.raw), containers: source.map((c) => c.evidence), storage,
    helperImage, seconds, readonlyBindProofs,
    fingerprint: JSON.stringify(stable({ ephemeralPaths, helperImage, helperConfig, shutdownTimeoutSeconds, migrationBackup, config, sourceDocument, imageConfigs,
      source: source.map(({ raw }) => {
        const state = object(raw["State"]);
        return { id: raw["Id"], image: raw["Image"], config: raw["Config"], hostConfig: raw["HostConfig"], mounts: raw["Mounts"],
          state: { status: state["Status"], exitCode: state["ExitCode"], oomKilled: state["OOMKilled"], paused: state["Paused"], restarting: state["Restarting"] } };
      }).sort((a, b) => text(a.id).localeCompare(text(b.id))), storage, readonlyBindProofs })) };
}

// Paths a recipe declares disposable (recipe.json ephemeralPaths): only sanitized counts are kept.
export interface IgnoredEphemeralPath {
  readonly path: string;
  readonly count: number;
}
export interface SideStackMigrateOptions extends StackMigrateOptions {
  readonly ephemeralPaths?: readonly string[];
}
export interface SideStackMigratePlan extends StackMigratePlan {
  readonly ignoredEphemeralPaths: readonly IgnoredEphemeralPath[];
}
export interface SideStackMigrationResult extends StackMigrationResult {
  readonly ignoredEphemeralPaths: readonly IgnoredEphemeralPath[];
}
export function ignoredEphemeralPaths(value: StackMigratePlan | StackMigrationResult): readonly IgnoredEphemeralPath[] {
  if (!("ignoredEphemeralPaths" in value)) return Object.freeze([]);
  const summaries = value.ignoredEphemeralPaths;
  if (!Array.isArray(summaries) || summaries.some((entry: unknown) => entry === null || typeof entry !== "object"
    || !("path" in entry) || typeof entry.path !== "string" || !("count" in entry)
    || typeof entry.count !== "number" || !Number.isSafeInteger(entry.count) || entry.count < 0)) {
    throw new Error("recipe migration ignored ephemeral summary malformed");
  }
  return Object.freeze(summaries.map((entry: IgnoredEphemeralPath) => Object.freeze({ path: entry.path, count: entry.count })));
}
export function migrationPathSanitizer(io: Pick<StackIO, "sanitize">, raw: Record<string, unknown>): (path: string) => string {
  const secrets = array(object(raw["Config"])["Env"] ?? []).map(text)
    .map((entry) => entry.slice(entry.indexOf("=") + 1)).filter(Boolean).sort((a, b) => b.length - a.length);
  return (path) => {
    for (const secret of secrets) path = path.split(secret).join("[redacted]");
    return io.sanitize(path).slice(0, 512);
  };
}
export function freezeIgnored(paths: readonly string[], counts: readonly number[], sanitize: (path: string) => string): readonly IgnoredEphemeralPath[] {
  return Object.freeze(paths.map((path, index) => Object.freeze({ path: sanitize(path), count: counts[index] ?? 0 })));
}
