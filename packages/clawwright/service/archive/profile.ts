// Archive profiles: what goes in, and what a given profile deliberately leaves out.
//
// The exclusion lists are the outcome of inspecting a real data directory, not guesswork:
//   - the provider key exists only in config/.env
//   - config/identity/device-auth.json holds an operator token with read/write scopes
//   - state/openclaw.sqlite has a multi-megabyte -wal sibling, so a copy taken while the
//     gateway writes is not restorable — hence the stop before snapshotting
//   - workspace/.git matters: the agent versions its own memory there

import { regexEscape } from "../../core/io/log.ts";
import { DATA_DIR_MARKER } from "../../runtime/files/datadir.ts";
import { PUBLISH_STAGING_MARKER, PRIVATE_STAGING_MARKER } from "../../runtime/transport/transport.ts";

const LEGACY_PREFIXES = ["oc", "cf"] as const;

/** How much of the instance travels with an archive. */
export type Profile = "full" | "migrate" | "share";

export const PROFILES: Profile[] = ["full", "migrate", "share"];

/** Shorthand flags for `backup` and `pull`, one map so both parsers agree. */
export const PROFILE_SHORTHAND_FLAGS: ReadonlyMap<string, Profile> = new Map([
  ["--share", "share"],
  ["--with-secrets", "full"],
  ["--migrate", "migrate"],
]);

/** What a backup archive is called, and how to read that name back. The profile is part of
 *  the name because "an archive of this deployment" is not one kind of thing: migrate
 *  carries no config/.env, share carries neither identity nor devices, so restoring either
 *  over a live instance replaces it with something that cannot start. `pull` writes into
 *  the same backup directory `backup` uses, and `restore` with no argument takes whichever
 *  is newest — the profile in the name is what lets every consumer tell them apart. A full
 *  archive keeps the name it always had, so old directories still read correctly (a
 *  never-recorded profile just cannot be recovered from the name). */
export function backupArchiveName(deployment: string, stamp: string, profile: Profile): string {
  return profile === "full"
    ? `${deployment}-${stamp}.tar.gz`
    : `${deployment}-${stamp}-${profile}.tar.gz`;
}

/** The stamp and profile of `fileName`, or undefined when it is not this deployment's
 *  backup at all. Deliberately strict: a `ls <name>-*.tar.gz` glob also matches a sibling
 *  deployment sharing a backup directory, and rotation that can't tell them apart deletes
 *  the sibling's archives. */
export function parseBackupArchive(fileName: string, deployment: string): { stamp: string; profile: Profile } | undefined {
  const escaped = regexEscape(deployment);
  const match = new RegExp(`^${escaped}-(\\d{8}-\\d{6})(?:-(migrate|share))?\\.tar\\.gz$`).exec(fileName);
  if (match === null) return undefined;
  return { stamp: match[1], profile: (match[2] ?? "full") as Profile };
}

/** Builds the name restore moves the previous data directory aside under, one generator so
 *  parseReplacedCopyName's shape can never drift from what this actually writes. */
export function replacedCopyName(dataDir: string): string {
  return `${dataDir}.replaced-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
}

const REPLACED_COPY_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/** The stamp of a `.replaced-*` sibling's base name, or undefined when it is not exactly
 *  one — strict for the same reason parseBackupArchive is: `backup prune-replaced` deletes
 *  through this. */
export function parseReplacedCopyName(baseName: string, dataDirName: string): { stamp: string } | undefined {
  const escaped = regexEscape(dataDirName);
  const match = new RegExp(`^${escaped}\\.replaced-(.+)$`).exec(baseName);
  if (match === null) return undefined;
  return REPLACED_COPY_STAMP.test(match[1]) ? { stamp: match[1] } : undefined;
}

/** Whether an archive's listing carries `config/identity` under its root — what
 *  --fresh-identity drops and a share-profile archive already excludes. Used by restore's
 *  --dry-run plan; never unpacks anything to answer it. */
export function archiveIncludesIdentity(entries: readonly string[], root: string): boolean {
  const marker = `${root}/config/identity`;
  return entries.some((entry) => {
    const path = entry.replace(/^\.\//, "");
    return path === marker || path.startsWith(`${marker}/`);
  });
}

/** Parses the exact snapshot name produced by `pull`. */
export function snapshotDeploymentNames(deployment: string): string[] {
  return deployment === "openclaw" ? [deployment, "open_claw"] : [deployment];
}

export function parseSnapshotArchive(fileName: string, deployment: string): { stamp: string } | undefined {
  // The first release used the repository's historical `open_claw` name while the current
  // deployment identity is `openclaw`. Keep that one explicit compatibility alias; accepting
  // arbitrary spelling variants would let a sibling deployment's snapshots be restored.
  const names = snapshotDeploymentNames(deployment);
  const escaped = names.map((name) => regexEscape(name)).join("|");
  const match = new RegExp(`^(?:${escaped})-state-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2})\\.tar\\.gz$`).exec(fileName);
  if (match === null) return undefined;
  const stamp = match[1];
  const iso = `${stamp.slice(0, 10)}T${stamp.slice(11).replaceAll("-", ":")}Z`;
  const date = new Date(iso);
  const normalized = Number.isNaN(date.getTime()) ? "" : date.toISOString().replaceAll(/[:.]/g, "-").slice(0, 19);
  return normalized === stamp ? { stamp } : undefined;
}

/** Always excluded: host-local noise and artefacts reproducible from the repository. The
 *  instance lock is here, not in one profile's list: a full backup restored onto a host
 *  would otherwise arrive holding a lock nobody can release, blocking the rescue it was
 *  meant for — a lock describes a running operation on one machine, meaningless elsewhere. */
function baseExcludes(dataName: string): string[] {
  const root = escapeTarGlob(dataName);
  return [
    `${root}/config/logs`,
    `${root}/config/openclaw.json.bak*`,
    `${root}/config/openclaw.json.last-good`,
    `${root}/config/clawwright-declared-config-patch.json`,
    `${root}/config/clawwright-declared-config-patch.dry-*.json`,
    // Staged --file payloads for cli/exec (exec-payload.ts): private, transient, never state.
    `${root}/config/clawwright-cli-input-*`,
    // Previous staging names remain excluded for archives made by older releases.
    `${root}/config/clawwright-desired.dry-*.json`,
    `${root}/config/clawwright-desired.json`,
    // Provider-key staging is private from creation and normally removed after rename, but a
    // process can die between those steps. It is credential material, never instance state.
    `${root}/config/.env.clawwright-*`,
    // A native backup's in-flight full archive; a crash must not nest it into a later backup.
    `${root}/config/.clawwright-native-*`,
    // The tooling's own temp-sibling staging families (transport.ts), same story one layer
    // out: real bytes sit in the sibling from the first byte written, and a dead process or
    // failed cleanup leaves them beside the target — exposed under workspace/, where the
    // share allow-list would otherwise let them through. Markers are writer-only, so globs
    // can't reach an unrelated public file (GNU tar exclusion globs match slashes, verified
    // against GNU tar 1.35+).
    `${root}/*${PRIVATE_STAGING_MARKER}*`,
    `${root}/*${PUBLISH_STAGING_MARKER}*`,
    `${root}/clawwright-operation.lock`,
    ...LEGACY_PREFIXES.flatMap((prefix) => [
      `${root}/config/${prefix}-desired.json`,
      `${root}/${prefix}-operation.lock`,
    ]),
  ];
}

/** GNU tar reads --exclude patterns as globs. Escape literal root and recipe paths while
 *  keeping the deliberate wildcards in the base exclusion suffixes. */
function escapeTarGlob(pattern: string): string {
  return pattern.replace(/[*?[\]\\]/g, "\\$&");
}

/** The tar exclusion list for one profile. recipePrivatePaths carries the recipes' own
 *  declared private paths (installedRecipePrivatePaths, data-relative) — generated
 *  credentials, not instance state: migrate/share leave them out, full (credential-complete
 *  by design) keeps them. Defaults to empty, so callers without recipe context get exactly
 *  the lists they always got. */
export function excludesFor(profile: Profile, dataName: string, recipePrivatePaths: readonly string[] = []): string[] {
  const root = escapeTarGlob(dataName);
  const excludes = baseExcludes(dataName);

  if (profile !== "full" && recipePrivatePaths.length > 0) {
    excludes.push(...recipePrivatePaths.map((path) => escapeTarGlob(`${dataName}/${path}`)));
  }

  if (profile === "migrate") {
    // Same instance, different host: keep identity, hand the keys over separately.
    excludes.push(
      `${root}/config/.env`,
      // The privacy history is published for full backups only; this profile's readers
      // don't expect it — verify's SHARE_ALLOWED would refuse a share archive holding it.
      `${root}/config/clawwright-private-paths.json`,
      `${root}/clawwright-operations`,
      ...LEGACY_PREFIXES.map((prefix) => `${root}/${prefix}-operations`),
      `${root}/${DATA_DIR_MARKER}`, // names the OLD host; restore's trustExisting writes a fresh one
    );
  }

  if (profile === "share") {
    // Handing the agent to someone else: only its personality travels.
    excludes.push(
      `${root}/config/.env`,
      `${root}/config/clawwright-private-paths.json`, // published for full backups only
      `${root}/config/identity`,
      `${root}/config/devices`,
      `${root}/config/state`,
      `${root}/config/agents`,
      `${root}/auth-secrets`,
      // Keep host-local history and configuration copies out of shared archives.
      `${root}/clawwright-operations`,
      `${root}/clawwright-files.json`,
      `${root}/clawwright-managed.json`,
      `${root}/clawwright-declared.json`,
      `${root}/clawwright-installed-set.json`,
      `${root}/${DATA_DIR_MARKER}`, // same reasoning as migrate above
      ...LEGACY_PREFIXES.flatMap((prefix) => [
        `${root}/${prefix}-operations`,
        `${root}/${prefix}-managed.json`,
        `${root}/${prefix}-installed-set.json`,
      ]),
    );
  }

  return excludes;
}

/** What a `share` archive is allowed to contain, relative to its root. The exclusion list
 *  above says what must not travel; this says what may — a new directory is then reported
 *  by `verify` instead of silently shipping. Paths are prefixes: a file or a whole subtree. */
export const SHARE_ALLOWED = [
  "config/openclaw.json",
  "config/plugin-skills",
  "config/npm",
  "config/workspace",
  "config/workspace-attestations",
  "workspace",
];
