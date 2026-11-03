// Effective-config handling for `recipe trial`: the compose version requirement (v2.24+,
// for the `!override` merge tag — older versions refuse, there is no remap fallback), the
// refusal scan over a compose file's effective configuration (the target-side
// `docker compose ... config --format json` document, the same shape
// runtime/docker/side-stack reads; for the trial it is the MERGED base+override
// document), the override document built from that effective config, and the
// merged-config publication proof. Key casing is snake_case
// (`host_ip`, `published`, `target`, `mode`, `protocol`): the repo's existing readers of
// compose-config JSON (side-stack/recovery.ts, migration-plan.ts) parse exactly these
// lowercase keys, while `HostIp` PascalCase in container-introspection.ts belongs to
// `docker inspect`, a different document. A raw-text scan additionally refuses `include:`
// — compose resolves includes INTO the file before config, so the effective document
// cannot reveal one.

import { readFile } from "node:fs/promises";
import { die } from "#src/core/io/log.ts";

/** One effective port entry reduced to what the override and the proof need. */
export interface PortEntry {
  readonly target: string;
  readonly protocol: string;
  readonly hostIp: string | undefined;
  readonly published: string | undefined;
}

export interface EffectiveService {
  readonly name: string;
  readonly ports: readonly PortEntry[];
  readonly builds: boolean;
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    die(`recipe trial could not read the compose configuration: ${where} is not a record`);
  return value as Record<string, unknown>;
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) die(`recipe trial could not read the compose configuration: ${where} is not a list`);
  return value;
}

/** Strings as-is; numbers stringified — compose writes both across versions. */
function scalar(value: unknown, where: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  die(`recipe trial could not read the compose configuration: ${where} is not a scalar`);
}

/** Strict document parse: JSON.parse guarded, non-objects refused. */
export function parseConfigDocument(stdout: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    die("recipe trial could not read the compose configuration: the target's `config --format json` output is not JSON");
  }
  return record(parsed, "the configuration document");
}

/** Object form uses compose's snake_case keys; short strings `host:container[/proto]`
 *  appear in some versions. Anything else is refused, never half-understood. */
function parsePort(service: string, value: unknown): PortEntry {
  if (typeof value === "string") {
    if (!/^(?:[A-Za-z0-9_.:[\]-]+:)*[0-9A-Za-z_]+(?:\/(?:tcp|udp))?$/.test(value))
      die(`recipe trial refuses ${service}.ports: the effective config carries a ports entry the trial cannot understand: "${value}"`);
    const [mapping, protocol = "tcp"] = value.split("/", 2);
    const target = mapping.includes(":") ? mapping.slice(mapping.lastIndexOf(":") + 1) : mapping;
    return { target, protocol, hostIp: undefined, published: undefined };
  }
  const entry = record(value, `services.${service}.ports entry`);
  const mode = entry["mode"] === undefined ? undefined : scalar(entry["mode"], `services.${service}.ports.mode`);
  if (mode === "host")
    die(`recipe trial refuses ${service}.ports: a port with mode: host is bound outside every publication override`);
  const target = scalar(entry["target"], `services.${service}.ports.target`);
  const protocol = entry["protocol"] === undefined ? "tcp" : scalar(entry["protocol"], `services.${service}.ports.protocol`);
  if (protocol !== "tcp" && protocol !== "udp")
    die(`recipe trial refuses ${service}.ports: the protocol "${protocol}" is one the trial cannot remap`);
  return {
    target,
    protocol,
    hostIp: entry["host_ip"] === undefined ? undefined : scalar(entry["host_ip"], `services.${service}.ports.host_ip`),
    published: entry["published"] === undefined ? undefined : scalar(entry["published"], `services.${service}.ports.published`),
  };
}

const servicePorts = (name: string, service: Record<string, unknown>): readonly PortEntry[] =>
  (service["ports"] === undefined ? [] : list(service["ports"], `services.${name}.ports`)).map((value) => parsePort(name, value));

/** Resolves paths on the target (one batched `realpath`). Throwing is fine: the scan
 *  converts any failure into a refusal — an unresolvable bind source cannot be proven
 *  inside the allowed directories. */
export type ResolveReal = (paths: readonly string[]) => Promise<readonly string[]>;

/** Refuses a top-level volumes/networks definition that addresses a LIVE resource.
 *  `compose config --format json` emits GENERATED names `<project>_<key>` for default
 *  networks and named volumes — that form is project-scoped (it lives and dies with the
 *  trial) and is accepted, as is no name at all; any other explicit name or `external`
 *  addresses a resource the trial shares with the live stack and refuses. */
function refuseLiveDefinition(kind: "volumes" | "networks", key: string, definition: Record<string, unknown>, project: string): void {
  const noun = kind === "volumes" ? "volume" : "network";
  const name = definition["name"];
  if (name !== undefined && name !== `${project}_${key}`)
    die(`recipe trial refuses ${kind}.${key}: the explicit name "${String(name)}" is neither the generated <project>_<key> form nor absent — it addresses a live ${noun} the trial must not touch`);
  if (definition["external"] !== undefined && definition["external"] !== false)
    die(`recipe trial refuses ${kind}.${key}: external: true addresses a live ${noun} the trial must not touch`);
}

/** Refusal scan + service inventory over an effective configuration (for the trial: the
 *  MERGED base+override document). Bind mounts
 *  are canonicalized on the TARGET with one batched `realpath` (via `resolveReal`) before
 *  the prefix check, so a symlink pointing out of `allowedBindPrefixes` (the scratch data
 *  dir and the target-side recipe/definition directory) refuses. Mount types are
 *  allow-listed: `bind` (resolved-prefix rule), `tmpfs`, and `volume` resolving through
 *  the top-level volumes map without a trial-foreign name. `volumes_from` and any other
 *  type refuse. Top-level `volumes:`/`networks:` follow the generated-name rule of
 *  {@link refuseLiveDefinition}.
 *
 *  `expectedBuildTags`: the exact `service → tag` map derived from the base build inventory.
 *  The merged analysis checks every expected service, its exact tag, and refuses new
 *  builder services that were not in that map. */
export async function analyzeEffectiveConfig(config: unknown, allowedBindPrefixes: readonly string[], project: string,
  resolveReal: ResolveReal, expectedBuildTags?: ReadonlyMap<string, string>): Promise<{ services: readonly EffectiveService[] }> {
  const document = record(config, "the configuration document");
  for (const key of ["configs", "secrets"] as const) {
    if (document[key] !== undefined) die(`recipe trial refuses top-level ${key}: config/secret file sources are unsupported`);
  }
  for (const kind of ["volumes", "networks"] as const) {
    for (const [name, value] of Object.entries(record(document[kind] ?? {}, kind))) {
      const definition = value === null ? {} : record(value, `${kind}.${name}`);
      if (kind === "volumes") {
        const driver = definition["driver"];
        if (driver !== undefined && driver !== "local")
          die(`recipe trial refuses volumes.${name}.driver: custom volume driver "${String(driver)}" could map a project-scoped name to a live data source`);
        const driverOptions = definition["driver_opts"];
        if (driverOptions !== undefined && Object.keys(record(driverOptions, `volumes.${name}.driver_opts`)).length > 0)
          die(`recipe trial refuses volumes.${name}.driver_opts: driver options can map a project-scoped volume to a live bind source`);
      }
      refuseLiveDefinition(kind, name, definition, project);
    }
  }
  const binds: { service: string; source: string; readOnly: boolean }[] = [];
  const services = Object.entries(record(document["services"] ?? {}, "services")).map(([name, value]) => {
    const service = record(value, `services.${name}`);
    if (service["configs"] !== undefined) die(`recipe trial refuses ${name}.configs: service configs are unsupported`);
    if (service["secrets"] !== undefined) die(`recipe trial refuses ${name}.secrets: service secrets are unsupported`);
    const build = service["build"];
    if (build !== undefined) {
      if (typeof build === "object" && build !== null && !Array.isArray(build)) {
        const buildRecord = record(build, `services.${name}.build`);
        for (const key of ["tags", "cache_to", "cache_from", "additional_contexts", "secrets", "configs"] as const) {
          if (buildRecord[key] !== undefined) die(`recipe trial refuses ${name}.build.${key}: unsupported build isolation construct`);
        }
      } else if (typeof build !== "string") {
        die(`recipe trial refuses ${name}.build: unsupported build representation`);
      }
    }
    if (service["profiles"] !== undefined)
      die(`recipe trial refuses ${name}.profiles: a profiled service would be skipped or started unexpectedly`);
    const networkMode = service["network_mode"];
    if (networkMode !== undefined && networkMode !== "" && networkMode !== "bridge" && networkMode !== "default")
      die(`recipe trial refuses ${name}.network_mode: only the default bridge networking isolates the trial from the host`);
    if (service["container_name"] !== undefined)
      die(`recipe trial refuses ${name}.container_name: a fixed container name collides with a live container instead of staying in the trial project`);
    if (service["volumes_from"] !== undefined)
      die(`recipe trial refuses ${name}.volumes_from: the trial can only prove mounts declared on the service itself, not mounts inherited from another service`);
    for (const value of service["volumes"] === undefined ? [] : list(service["volumes"], `services.${name}.volumes`)) {
      const mount = record(value, `services.${name}.volumes entry`);
      if (mount["type"] === undefined)
        die(`recipe trial refuses ${name}.volumes: a mount without a type is one the trial cannot classify`);
      const type = scalar(mount["type"], `services.${name}.volumes.type`);
      if (type === "tmpfs") continue;
      if (type === "volume") {
        const source = scalar(mount["source"] ?? "", `services.${name}.volumes.source`);
        const definitions = record(document["volumes"] ?? {}, "volumes");
        if (source !== "" && definitions[source] !== undefined)
          refuseLiveDefinition("volumes", source, record(definitions[source], `volumes.${source}`), project);
        continue;
      }
      if (type !== "bind")
        die(`recipe trial refuses ${name}.volumes: the mount type "${type}" is not one the trial allows (bind, tmpfs, volume)`);
      const source = scalar(mount["source"], `services.${name}.volumes.source`);
      if (!source.startsWith("/"))
        die(`recipe trial refuses ${name}.volumes: the bind mount ${source} is not an absolute path`);
      binds.push({ service: name, source, readOnly: mount["read_only"] === true });
    }
    const builds = service["build"] !== undefined;
    if (expectedBuildTags !== undefined) {
      const expected = expectedBuildTags.get(name);
      const image = service["image"] === undefined ? undefined : scalar(service["image"], `services.${name}.image`);
      if (builds && (expected === undefined || image !== expected))
        die(`recipe trial refuses ${name}.image: merged build service has tag "${image ?? "(missing)"}"; expected the exact trial tag "${expected ?? "(no trial tag was derived)"}"`);
      if (!builds && expected !== undefined)
        die(`recipe trial refuses ${name}.build: the trial build service is missing from the merged config, so tag "${expected}" was not applied`);
    }
    return { name, ports: servicePorts(name, service), builds };
  });
  // Every builder from the base inventory must still exist in the merged config.
  if (expectedBuildTags !== undefined) {
    const mergedNames = new Set(services.map((service) => service.name));
    for (const [name, tag] of expectedBuildTags) {
      if (!mergedNames.has(name))
        die(`recipe trial refuses ${name}.build: merged config is missing the trial build service and exact tag "${tag}"`);
    }
  }
  // Canonicalize every bind source with ONE batched target-side exec, then apply the same
  // allowed-prefix rule to the RESOLVED path: a symlink (or symlinked ancestor) out of the
  // allowed dirs is refused where the literal source string would have passed.
  if (binds.length > 0) {
    const resolved = await resolveReal(binds.map((bind) => bind.source)).catch((error: unknown) =>
      die(`recipe trial refuses: the bind mount sources could not be resolved on the target: ${error instanceof Error ? error.message : String(error)}`));
    for (const [index, bind] of binds.entries()) {
      const real = resolved[index];
      if (real === undefined)
        die(`recipe trial refuses ${bind.service}.volumes: the bind mount ${bind.source} could not be resolved on the target`);
      const within = (prefix: string): boolean => real === prefix || real.startsWith(`${prefix}/`);
      if (!real.startsWith("/") || !allowedBindPrefixes.some(within))
        die(`recipe trial refuses ${bind.service}.volumes: the bind mount ${bind.source} resolves to ${real}, outside the trial scratch home and the recipe directory`);
      // Only the first prefix (the scratch data copy) may be written; the live recipe directory is shared, so it must be read-only.
      if (!bind.readOnly && !within(allowedBindPrefixes[0] ?? ""))
        die(`recipe trial refuses ${bind.service}.volumes: the bind mount ${bind.source} shares the live recipe directory writable; mark it read_only so the trial cannot modify it`);
    }
  }
  return { services };
}

/** Raw-text refusal of `include:`. compose resolves includes INTO the compose file
 *  before `config` evaluates it, so the pinned effective document cannot reveal one —
 *  only the file's raw text can. One conservative whole-text scan: the token `include`
 *  appearing as a KEY anywhere (block or flow style, quoted or not) refuses. Fail
 *  closed: a false positive (a comment or a string that happens to read `include:`)
 *  refuses too — the trial cannot prove what an include would add, so anything shaped
 *  like one is refused. (`extends` needs no such scan:
 *  it is resolved away during config evaluation, so the pinned effective document the
 *  trial executes IS the resolved truth — nothing raw can reach the run past it.) */
const INCLUDE_KEY = /(^|[\s{,])["']?include["']?\s*:/m;

export async function refuseRawInclude(definitionPath: string): Promise<void> {
  const text = await readFile(definitionPath, "utf8");
  if (INCLUDE_KEY.test(text))
    die(`recipe trial refuses include: compose merges included files into the compose file before config evaluates it, so the trial cannot prove what they add`);
}

/** Parses `docker compose version --short` (e.g. `v2.27.1`); undefined when unreadable. */
export function parseComposeVersion(output: string): { major: number; minor: number; patch: number } | undefined {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(output.trim());
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** `!override []` needs Compose v2.24.0; there is no older-version fallback — the caller
 *  refuses. Kept as the single statement of the version boundary. */
export function supportsPortOverride(version: { major: number; minor: number; patch: number }): boolean {
  return version.major > 2 || (version.major === 2 && version.minor >= 24);
}

/** Deterministic override over the EFFECTIVE services: EVERY service's `ports` is
 *  replaced by the empty list via the `!override` merge tag — including today's
 *  non-publishers, so a newly-added port can never leak. This is the ONLY shape: the
 *  trial requires Compose v2.24+ and refuses older versions instead of remapping.
 *  Build services get `image:` overridden
 *  to the trial's own tag, so the live image tag is never built over. A config with no
 *  services at all gets the comment-only file so the trial's file inventory keeps its
 *  shape either way. */
export function buildOverride(services: readonly EffectiveService[],
  buildImages: ReadonlyMap<string, string>): string {
  if (services.length === 0) return "# recipe trial: no service in this recipe publishes ports.\nservices: {}\n";
  const body = services.map((service) => {
    const tag = buildImages.get(service.name);
    return `  ${service.name}:\n${tag === undefined ? "" : `    image: ${tag}\n`}    ports: !override []\n`;
  }).join("");
  return "# recipe trial: strips every port publication (!override) — the trial is never reachable from outside.\nservices:\n" + body;
}

/** PROOF, before anything starts: the MERGED (base + override) effective configuration
 *  must publish nothing. Every port must be gone, or bound on 127.0.0.1 with an empty
 *  (ephemeral) host publication. Anything else is a refusal naming the service, the port
 *  and what was observed. */
export function assertNoPublications(config: unknown): void {
  const document = record(config, "the merged configuration document");
  for (const [name, value] of Object.entries(record(document["services"] ?? {}, "services"))) {
    for (const port of servicePorts(name, record(value, `services.${name}`))) {
      const safe = port.hostIp === "127.0.0.1" && (port.published === undefined || port.published === "");
      if (!safe)
        die(`recipe trial refuses ${name}.ports: after the override the merged config still publishes target ${port.target}/${port.protocol} on host_ip ${port.hostIp ?? "(compose default)"} with published "${port.published ?? ""}"`);
    }
  }
}
