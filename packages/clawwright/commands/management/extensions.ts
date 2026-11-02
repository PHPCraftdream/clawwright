// OpenClaw plugins and skills: third-party code this framework does not vendor, discovered
// through OpenClaw's own CLI rather than read from disk. `lock` records what is installed,
// `inspect`/`doctor` report drift, `plan` never installs or removes one on its own — an id
// and a version aren't proof of what a reinstall would run (see compareExtensions), so the
// reader always decides.
//
// Bundled entries (shipped inside the pinned image itself) are already covered by the
// lock's own image digest, so they're filtered out before this framework writes or
// compares them — recording them too would call it drift on every OpenClaw upgrade.
//
// `plugins list --json` reports {id, name, version, origin, enabled, ...}, no integrity
// hash; `skills list --json` reports {name, source, bundled, ...}, no version at all. A
// skill's install version lives only in a per-skill call not part of the batched read this
// module shares with doctor, so skill drift here is add/remove only, never version.

import { BATCH_NOT_BOOTSTRAPPED, BATCH_NOT_RUNNING } from "#src/service/openclaw-cli.ts";
import type { BatchedCliResult } from "#src/service/openclaw-cli.ts";
import { problem } from "#src/service/inspection.ts";
import type { Problem } from "#src/service/inspection.ts";
import { command, type CommandAdvice } from "#src/core/io/invocation/advice.ts";
import { renderAdvice } from "#src/core/io/invocation/render.ts";

/** The exact CLI invocations both `lock` and `inspect` read — one place, so the two commands
 *  cannot silently start asking a different question about the same instance. */
export const PLUGINS_LIST_ARGS = ["plugins", "list", "--json"] as const;
export const SKILLS_LIST_ARGS = ["skills", "list", "--json"] as const;

/** Fixed parts of the unread-inventory details, exported so the checks assert the same
 *  text the product prints instead of restating it. */
export function inventoryPrefix(key: "plugins" | "skills"): string {
  return `openclaw ${key} list`;
}
export const NEVER_BOOTSTRAPPED_HINT = "this deployment has never been bootstrapped";
export const NOT_RUNNING_HINT = "instance is not running — start it or bootstrap first";
export const UNKNOWN_INVENTORY_TAIL = "; live state is unknown";
export const NO_LONGER_INSTALLED = "no longer installed";
export const REVIEW_BEFORE_REMOVAL = "review it, then either remove it or run `lock` to pin it deliberately";

/** One entry from `openclaw plugins list --json`. `origin` is OpenClaw's provenance tag
 *  (see normalizePluginOrigin), kept raw here so a future unseen origin still travels
 *  instead of being coerced into the wrong bucket. */
export interface PluginListEntry {
  readonly id: string;
  readonly name?: string;
  readonly version?: string;
  readonly origin: string;
  readonly enabled: boolean;
}

/** One entry from `openclaw skills list --json`. No version field — see this file's header. */
export interface SkillListEntry {
  readonly name: string;
  readonly source: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** Failed or malformed inventories remain unknown; only a validated empty array is none. */
function inventoryEntries(result: BatchedCliResult, key: "plugins" | "skills", problems: Problem[]): Record<string, unknown>[] | undefined {
  let reason = result.failure ?? (result.code !== 0 ? `exit ${result.code}` : undefined);
  if (reason === undefined) {
    try {
      const parsed = JSON.parse(result.stdout) as Record<string, unknown> | null;
      const entries = parsed?.[key];
      if (!Array.isArray(entries) || entries.some((entry) =>
        entry === null || typeof entry !== "object" || Array.isArray(entry) ||
        (key === "plugins"
          ? !isNonEmptyString(entry.id) || !isNonEmptyString(entry.origin) ||
            (entry.name !== undefined && !isNonEmptyString(entry.name)) ||
            (entry.version !== undefined && !isNonEmptyString(entry.version)) ||
            (entry.enabled !== undefined && typeof entry.enabled !== "boolean")
          : !isNonEmptyString(entry.name) || !isNonEmptyString(entry.source)))) {
        throw new Error("invalid inventory");
      }
      return entries;
    } catch {
      reason = "invalid JSON response";
    }
  }
  if (reason === BATCH_NOT_BOOTSTRAPPED) {
    problems.push(problem("NOT_BOOTSTRAPPED", `${inventoryPrefix(key)} not read: ${NEVER_BOOTSTRAPPED_HINT}`));
    return undefined;
  }
  if (reason === BATCH_NOT_RUNNING) {
    problems.push(problem("GATEWAY_DOWN", `${inventoryPrefix(key)} not read: ${NOT_RUNNING_HINT}`));
    return undefined;
  }
  problems.push(problem("CLI_READ_FAILED", `${inventoryPrefix(key)} could not be read (${reason})${UNKNOWN_INVENTORY_TAIL}`));
  return undefined;
}

export function parsePluginsList(result: BatchedCliResult, problems: Problem[] = []): PluginListEntry[] | undefined {
  return inventoryEntries(result, "plugins", problems)?.map((entry) => ({
    id: entry.id as string,
    name: entry.name as string | undefined,
    version: entry.version as string | undefined,
    origin: entry.origin as string,
    enabled: entry.enabled === true,
  }));
}

export function parseSkillsList(result: BatchedCliResult, problems: Problem[] = []): SkillListEntry[] | undefined {
  return inventoryEntries(result, "skills", problems)?.map((entry) => ({
    name: entry.name as string,
    source: entry.source as string,
  }));
}

/** OpenClaw's own provenance tag, normalised to the category this framework's lock records.
 *  "git"/"npm"/"clawhub" map onto themselves; "local-path"/"managed"/"upload"/"workspace"
 *  fold to "local". An unseen origin is kept verbatim rather than mis-filed under "local". */
export function normalizePluginOrigin(origin: string): string {
  if (origin === "clawhub" || origin === "npm" || origin === "git" || origin === "bundled") return origin;
  if (origin === "local-path" || origin === "managed" || origin === "upload" || origin === "workspace") return "local";
  return origin;
}

/** Same normalisation for a skill's `source` field. */
export function normalizeSkillSource(source: string): string {
  return source.startsWith("openclaw-") ? "bundled" : source;
}

/** What `lock` writes and `inspect` compares against — id/name/version plus the normalised
 *  source, nothing this framework cannot read straight off `plugins list --json`. */
export interface LockPlugin {
  readonly id: string;
  readonly name?: string;
  readonly version?: string;
  readonly source: string;
}

/** No version — see this file's header. */
export interface LockSkill {
  readonly name: string;
  readonly source: string;
}

/** Bundled plugins left out (this file's header), the rest sorted so two reads of the same
 *  instance produce the same file byte for byte. */
export function pluginsForLock(entries: readonly PluginListEntry[]): LockPlugin[] {
  return entries
    .map((entry) => ({ ...entry, source: normalizePluginOrigin(entry.origin) }))
    .filter((entry) => entry.source !== "bundled")
    .map((entry) => ({ id: entry.id, name: entry.name, version: entry.version, source: entry.source }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function skillsForLock(entries: readonly SkillListEntry[]): LockSkill[] {
  return entries
    .map((entry) => ({ name: entry.name, source: normalizeSkillSource(entry.source) }))
    .filter((entry) => entry.source !== "bundled")
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The exact command a reader can run to put a plugin back at the version the lock pinned,
 *  as Advice: built from `name` (falling back to `id`) — the closest approximation to the
 *  original install spec, not proven to be it: an npm-origin plugin's id can differ from its
 *  manifest name, so a reinstall built from either can name the wrong package. Why this is
 *  only ever offered as an advisory step (plan.ts), never run unattended. */
export function pluginReinstall(label: string, version: string | undefined): CommandAdvice {
  return command(["cli", "plugins", "install", `${label}${version === undefined ? "" : `@${version}`}`, "--force"]);
}

export function skillReinstall(name: string): CommandAdvice {
  return command(["cli", "skills", "install", name, "--force"]);
}

/** PLUGIN_DRIFT / SKILL_DRIFT: the live third-party set against what the lock pinned, named
 *  per item the way compareLock (lock.ts) names which recipe file changed.
 *
 *  Three shapes per item: locked but no longer installed (restorable), installed but not
 *  locked (never proposed for removal, only a deliberate lock or uninstall), and installed
 *  at a different version than locked (skills have no version — see this file's header). */
export function compareExtensions(
  lockPlugins: readonly LockPlugin[] | undefined,
  currentPlugins: readonly LockPlugin[],
  lockSkills: readonly LockSkill[] | undefined,
  currentSkills: readonly LockSkill[],
): Problem[] {
  const problems: Problem[] = [];

  const lockedPlugins = new Map((lockPlugins ?? []).map((entry) => [entry.id, entry] as const));
  const livePlugins = new Map(currentPlugins.map((entry) => [entry.id, entry] as const));
  for (const [id, locked] of lockedPlugins) {
    const label = locked.name ?? id;
    const live = livePlugins.get(id);
    if (live === undefined) {
      problems.push(
        problem(
          "PLUGIN_DRIFT",
          `plugin "${label}" is locked at version ${locked.version ?? "(unknown)"} but is ${NO_LONGER_INSTALLED} — ` +
            `reinstall it: ${renderAdvice(pluginReinstall(label, locked.version))}`,
        ),
      );
    } else if (locked.version !== undefined && live.version !== undefined && locked.version !== live.version) {
      problems.push(
        problem(
          "PLUGIN_DRIFT",
          `plugin "${label}" is version ${live.version}, locked at ${locked.version} — ` +
            `reinstall the pinned version: ${renderAdvice(pluginReinstall(label, locked.version))}`,
        ),
      );
    }
  }
  for (const [id, live] of livePlugins) {
    if (lockedPlugins.has(id)) continue;
    problems.push(
      problem(
        "PLUGIN_DRIFT",
        `plugin "${live.name ?? id}" (source ${live.source}) is installed but not in the lock — ` +
          REVIEW_BEFORE_REMOVAL,
      ),
    );
  }

  const lockedSkills = new Map((lockSkills ?? []).map((entry) => [entry.name, entry] as const));
  const liveSkills = new Map(currentSkills.map((entry) => [entry.name, entry] as const));
  for (const [name, locked] of lockedSkills) {
    if (liveSkills.has(name)) continue;
    problems.push(
      problem(
        "SKILL_DRIFT",
        `skill "${name}" (source ${locked.source}) is locked but ${NO_LONGER_INSTALLED} — ` +
          `reinstall it: ${renderAdvice(skillReinstall(name))}`,
      ),
    );
  }
  for (const [name, live] of liveSkills) {
    if (lockedSkills.has(name)) continue;
    problems.push(
      problem(
        "SKILL_DRIFT",
        `skill "${name}" (source ${live.source}) is installed but not in the lock — ` +
          REVIEW_BEFORE_REMOVAL,
      ),
    );
  }

  return problems;
}
