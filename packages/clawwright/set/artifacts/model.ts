// The set: a versioned kit of everything a deployment installs — recipes, the config
// declaration (config/desired-state.json), required framework version/image digest, and
// secret NAMES. Vocabulary lives here so later commands (build/validate/install) don't
// each grow their own spelling.
//
// Three entities every set operation must say which it touches: set (recipes,
// desired-state.json, required versions, secret NAMES), instance (.env, ports, data
// directory, secret VALUES), state (workspace/*, transcripts, identity, devices,
// auth-secrets). Not the framework's own code: it pins the version it needs, and a
// mismatch is reported, never silently substituted.
//
// The id canonicalises (object keys sorted recursively, arrays in declared order — order
// is semantic) so identical content gives the same id anywhere. No `generatedAt`, unlike
// the lock: a set is content, not a pinning event. Secrets are names only, same rule as
// the lock — the shape has no field a value could go into.
//
// Known tension: desired-state.json today mixes set-level settings with host-flavoured
// ones (gateway.bind); it goes into the set whole for now.

import { checksumOf } from "#src/service/checksums.ts";
import { readName, type SetName } from "#src/core/values/names.ts";
import type { AgentConfig } from "#src/commands/management/provision-agent/index.ts";
import type { AcceptanceCheck } from "#src/commands/orchestration/accept.ts";

export const SET_MANIFEST_VERSION = 1;

/** The instance configuration declaration, keyed in the manifest's file map by this path
 *  relative to the deployment directory. */
export const DESIRED_STATE_PATH = "config/desired-state.json";

export interface SetRequirements {
  readonly framework: string; // the framework version the set needs — a mismatch is reported, never silently substituted
  readonly image: string;     // the required OpenClaw image DIGEST, not a tag — a tag moves, the digest is what was proven
}

export interface SetRecipe {
  /** One checksum standing for the recipe's served content (the mirror), same convention as the lock. */
  readonly checksum: string;
  /** Per file of the mirror, keyed by path relative to the recipe directory (lock vocabulary).
   *  Recipe-relative, while the manifest's flat file map is deployment-relative — the lock
   *  uses these keys, so a set and a lock can be compared without translation. */
  readonly files: Record<string, string>;
  /** The agent bundle (`agent/`): a prompt edit changes the agent without touching served content.
   *  Absent for a plain service recipe with no agent. */
  readonly agentChecksum?: string;
  readonly agentFiles?: Record<string, string>;
  /** What provision-agent sets up from the bundle: the agent, its MCP server registration, its cron job. */
  readonly agent?: AgentConfig;
}

export interface SetManifest {
  readonly version: number; // SET_MANIFEST_VERSION
  readonly name: string;
  readonly requires: SetRequirements;
  /** Every file the set installs, keyed by path relative to the deployment directory — the
   *  set's own complete inventory (config/desired-state.json included). Per-recipe maps
   *  above use recipe-relative keys, the lock's own vocabulary, for translation-free comparison. */
  readonly files: Record<string, string>;
  readonly recipes: Record<string, SetRecipe>;
  /** Secret NAMES only. The shape has no field a value could go into — same rule as the lock:
   *  a manifest that carried values would be a credential store that looks like a kit. */
  readonly secrets: readonly string[];
  /** Acceptance checks per recipe name — exactly what `accept` runs. */
  readonly acceptance: Record<string, readonly AcceptanceCheck[]>;
}

export interface SetManifestInput {
  readonly name: SetName;
  readonly requires: SetRequirements;
  readonly files: Record<string, string>;
  readonly recipes: Record<string, SetRecipe>;
  readonly secrets: readonly string[];
  readonly acceptance: Record<string, readonly AcceptanceCheck[]>;
}

/** Rejects any path that is not a clean deployment-relative POSIX path — an absolute,
 *  Windows or `..`-containing path would bake one machine into the id. */
function assertCleanRelativePath(where: string, path: string): void {
  if (path === "") {
    throw new Error(`${where}: a file key is empty — an empty name is not a file`);
  }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new Error(`${where}: "${path}" is an absolute path — keys must be relative to the deployment directory, or the set id would be machine-specific`);
  }
  if (path.includes("\\")) {
    throw new Error(`${where}: "${path}" contains a backslash — use POSIX "/" separators, so the id is the same on every machine`);
  }
  if (path.split("/").includes("..")) {
    throw new Error(`${where}: "${path}" contains a ".." segment — keys must stay inside the deployment directory`);
  }
}

export function buildSetManifest(input: SetManifestInput): SetManifest {
  // The name becomes paths later; names.ts is where that rule lives.
  readName("set", input.name);

  for (const path of Object.keys(input.files)) {
    assertCleanRelativePath("set files", path);
  }
  for (const [recipeName, recipe] of Object.entries(input.recipes)) {
    for (const path of Object.keys(recipe.files)) {
      assertCleanRelativePath(`recipe "${recipeName}" files`, path);
    }
    for (const path of Object.keys(recipe.agentFiles ?? {})) {
      assertCleanRelativePath(`recipe "${recipeName}" agent files`, path);
    }
  }

  // Sorted and deduplicated: the same names collected in any order must give the same
  // manifest and the same id, and readdir order differs between machines.
  const secrets = [...new Set(input.secrets)].sort();

  // Everything else passes through as given — object key order is canonicalisation's job,
  // not the builder's.
  return {
    version: SET_MANIFEST_VERSION,
    name: input.name,
    requires: input.requires,
    files: input.files,
    recipes: input.recipes,
    secrets,
    acceptance: input.acceptance,
  };
}

/** Deterministic serialisation: object keys sorted recursively, arrays in declared order
 *  (semantic — acceptance checks are a sequence), `undefined` counts as absent. Exported —
 *  the canonical form is part of the model's contract, not a private detail. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    // A key set to `undefined` and an absent key are the same manifest — optional fields
    // arrive by ordinary spread — so the id must not tell them apart.
    const keys = Object.keys(source).sort().filter((key) => source[key] !== undefined);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`;
  }
  // The one input JSON.stringify has no string for; keys above already dropped undefined,
  // so this is an array element — JSON renders that as null, and so does the canonical form.
  return JSON.stringify(value) ?? "null";
}

/** The set's content id. */
export function setManifestId(manifest: SetManifest): string {
  return checksumOf(canonicalJson(manifest));
}
