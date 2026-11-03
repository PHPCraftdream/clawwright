// One loading pipeline for a set, tree or artifact alike (refactor plan stage 1, I8).
//
// `loadSet(source)` answers "what does this set declare" the same way for both sources: a
// tree is collected into a manifest, an artifact is verified (archive against its own
// manifest) and unpacked, then handed the same file access the tree uses. `validateLoadedSet`
// runs the checks — purely local, no Context — so `set validate`, `set build`'s collection and
// the artifact paths cannot drift.
//
// Errors are typed by phase: only loading an ARTIFACT can throw ArtifactIntegrityError (the
// archive disagrees with its own manifest, or the manifest is malformed); findings the tree
// validator would make about the same content are Problems, never integrity errors.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { die } from "#src/core/io/log.ts";
import { renderAdvice } from "#src/core/io/invocation/render.ts";
import { parseEnv } from "#src/core/env.ts";
import { readName, type SetName } from "#src/core/values/names.ts";
import { deploymentDir, desiredStateFile, recipesDir, secretsTemplateFile } from "#src/runtime/deployment.ts";
import { runLocalTar } from "#src/set/artifacts/tar.ts";
import { collectSecretRefs } from "#src/service/secrets.ts";
import { recipeNames } from "#src/service/recipe.ts";
import { validateSet } from "#src/set/ownership/validate.ts";
import { checksumOf, checksumOfFileMap } from "#src/service/checksums.ts";
import { frameworkVersion, readLock } from "#src/commands/management/lock.ts";
import type { DeploymentLock } from "#src/commands/management/lock.ts";
import type { AcceptanceCheck } from "#src/commands/orchestration/accept.ts";
import { DESIRED_STATE_PATH, SET_MANIFEST_VERSION, buildSetManifest, canonicalJson, setManifestId } from "./artifacts/model.ts";
import type { SetManifest, SetRecipe } from "./artifacts/model.ts";
import { assertNoSecretValues, localSecretValues } from "#src/commands/sets/set-secrets-guard.ts";
import { hasDigest, invalidImageReference, tryParse } from "#src/runtime/docker/image-ref.ts";
import { imagePinAdvice } from "./advice.ts";
import { acceptanceLabel, agentConfigLabel, parseAcceptanceChecks, parseAgentDeclaration } from "./recipe-files.ts";
import { collectPortableContent, portableContent } from "#src/set/content.ts";
import type { PortableContent, PortableContentBase } from "#src/set/content.ts";
import type { Problem } from "#src/service/inspection.ts";

/** Where a set is loaded from: the working tree, or a packed artifact. */
export type SetSource = { readonly kind: "tree" } | { readonly kind: "artifact"; readonly path: string };

/** Fixed parts of the set refusals, exported so checks assert the same text the product
 *  prints instead of restating it. */
export const INVALID_ARTIFACT = "is not a valid set artifact";
export const FOREIGN_DIGEST = "does not belong to";

/** Thrown only while proving an artifact IS a set: the archive cannot be read, disagrees with
 *  its own manifest, or the manifest is malformed. Carries the artifact's path; the message is
 *  the bare cause so callers composing `"<path> is not a valid set artifact: …"` keep one path
 *  mention. A set whose content would not validate is a body Problem, never this. */
export class ArtifactIntegrityError extends Error {
  readonly artifact: string;
  constructor(artifact: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ArtifactIntegrityError";
    this.artifact = artifact;
  }
}

/** Body finding, not integrity: the archive is self-consistent, but the set it declares has
 *  blocking findings. Strict loaders refuse; read-only ones collect the findings instead. */
export class ArtifactCoherenceError extends Error {
  constructor(summary: string) {
    super(`artifact set is not coherent: ${summary}`);
    this.name = "ArtifactCoherenceError";
  }
}

export interface LoadedSet {
  readonly source: SetSource;
  readonly manifest: SetManifest;
  /** The content model built once from the source: one inventory walk, declaration and
   *  parsed recipes. Validation runs over this, never the disk (S3.2). */
  readonly content: PortableContent;
  readonly id: string;
  /** Lock facts for the validator, read once at load. */
  readonly lock: DeploymentLock | undefined;
  /** Artifact only: the recipe file bytes verification parsed, absolute path → utf8 text
   *  plus its checksum — the builder reuses them instead of re-reading. */
  readonly preRead: ReadonlyMap<string, Buffer>;
  /** Artifact only: where it was unpacked. The caller removes it when done. */
  readonly staging?: string;
  /** Tree only: where the tree's sources live, for the packer. */
  readonly tree?: { readonly root: string; readonly recipeRoot: string; readonly desiredStateSource: string };
}

export interface SetLoadOptions {
  /** Tree only: the set's name (default: derived per the caller's convention). */
  readonly name?: string;
  /** Tree only: the declared image (OPENCLAW_IMAGE), which a set must not re-resolve. */
  readonly declaredImage?: string;
  /** Tree only: validate tolerates an unpinned image as a finding; build refuses. */
  readonly tolerateUnpinnedImage?: boolean;
  /** Tree only: a declaration that cannot be read/parsed becomes a finding instead of a
   *  refusal. Build leaves this off — it cannot pack a set without its declaration. */
  readonly reportInvalidDeclaration?: boolean;
}

/** Secret NAMES, derived from the declaration the set carries — never from a live instance
 *  (secrets.ts's requirements(ctx) reads openclaw.json ON THE TARGET, which a set must not
 *  need). Two sources, both traveling with the set: SecretRefs in desired-state.json, and
 *  config/secrets.template.env (names only, from `secrets --template`; a template with a
 *  line that has no `=` refuses the load with a structured EnvSyntaxError). The app's own
 *  secrets hook is deliberately not consulted (usually depends on live target state); the
 *  gateway token is absent too, since each target generates its own. */
async function desiredSecretNames(desiredState: unknown): Promise<string[]> {
  const names = collectSecretRefs(desiredState).map((ref) => ref.name);
  let template: string;
  try {
    template = await readFile(secretsTemplateFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // No template yet — `secrets --template` writes one.
    return names;
  }
  // Outside the catch: a malformed template must refuse with file + line, not be swallowed.
  names.push(...Object.keys(parseEnv(template, secretsTemplateFile())));
  return names;
}

/** Lock facts for the validator, read once at load; absent when unreadable. */
async function loadLock(): Promise<DeploymentLock | undefined> {
  try {
    return await readLock();
  } catch {
    return undefined;
  }
}

/** The image the set pins, as a digest — a tag moves, the digest is what was proven.
 *
 *  Read from config/deployment.lock.json (recorded at `lock` time) rather than
 *  re-resolved via runtime.imageReference(), which needs a reachable target this command
 *  must not depend on. An already-digest OPENCLAW_IMAGE is honoured directly.
 *
 *  A recorded digest answers only for the reference it was proven under: a lock left over
 *  from a previous OPENCLAW_IMAGE must not pin this build to the wrong digest. */
async function requiredImage(image: string, tolerateUnpinned: boolean): Promise<string> {
  // The image module's grammar, not a digest-suffix test: a garbage value with a digest
  // shape must not pass as pinned. Validate (tolerateUnpinned) lets it through so the
  // validator reports SET_IMAGE_INVALID — the same finding the artifact path answers for
  // the same bytes; only build, which cannot pack it, keeps the die.
  if (tryParse(image) === undefined) {
    if (tolerateUnpinned) return image;
    die(invalidImageReference(image));
  }
  if (hasDigest(image)) return image;
  const lock = await readLock();
  if (lock?.image.digest !== undefined) {
    if (lock.image.reference !== image) {
      if (tolerateUnpinned) return image;
      // Same decision set validate reports — one advice, not two commands guessing.
      const advice = imagePinAdvice(image, lock);
      die(
        `the lock's digest ${FOREIGN_DIGEST} ${image} — it was recorded for ${lock.image.reference}, ` +
          "and pinning it here would put the previous image's runtime under a declaration that no longer names it.\n" +
          `${renderAdvice(advice.next)}. Or set OPENCLAW_IMAGE to a @sha256 reference.`,
      );
    }
    return lock.image.digest;
  }
  // validate keeps going with the tag in requires.image, so checkImagePinned can report
  // SET_IMAGE_UNPINNED alongside everything else; only build refuses outright.
  if (tolerateUnpinned) return image;
  const advice = imagePinAdvice(image, lock);
  die(
    `no image digest to pin the set to — ${advice.detail}\n${renderAdvice(advice.next)}. ` +
      "Or set OPENCLAW_IMAGE to a @sha256 reference.",
  );
}

/** The manifest a build would write, without writing anything. `set validate` asks exactly
 *  the question `set build` answers, through the same loader (loadSet), rather than risking
 *  two collectors drifting apart. */
export async function collectManifest(
  declaredImage: string,
  setName: SetName,
  options: { tolerateUnpinnedImage?: boolean; reportInvalidDeclaration?: boolean } = {},
): Promise<{
  root: string;
  recipeRoot: string;
  desiredStateSource: string;
  manifest: SetManifest;
  content: PortableContent;
}> {
  // The name becomes a file name under sets/ before buildSetManifest validates it.
  readName("set", setName);
  const root = deploymentDir();
  // Recipes may live outside the deployment directory; manifest keys are portable
  // `recipes/...`, so the real source root is kept for the copy phase.
  const recipeRoot = recipesDir();
  const desiredStateSource = desiredStateFile();

  // ONE build pass over the tree: the model reads everything once; the gates below answer
  // from it, in the same order and with the same texts as before.
  let framework: string | undefined;
  const base = await collectPortableContent({
    recipeRoot,
    declarationPath: desiredStateSource,
    recipes: () => recipeNames(),
    afterRecipe: async (_name, parsed, diagnostics) => {
      if (parsed.walkError !== undefined && options.reportInvalidDeclaration !== true) die(parsed.walkError);
      if (options.reportInvalidDeclaration !== true) {
        const acceptanceProblem = diagnostics.find((entry) => entry.source === "acceptance");
        if (acceptanceProblem !== undefined) die(acceptanceProblem.problem.detail);
        const agentProblem = diagnostics.find((entry) => entry.source === "agent-config");
        if (agentProblem !== undefined) die(agentProblem.problem.detail);
      }
    },
    afterDeclaration: async (declaration) => {
      const report = options.reportInvalidDeclaration === true;
      // Empty text historically reaches JSON.parse and refuses as invalid JSON in build mode.
      if (declaration.readError !== undefined && !report) {
        die(`${desiredStateFile()} not found — a set without its config declaration would install an unconfigured instance`);
      }
      if (declaration.parseError !== undefined && !report) die(`${desiredStateFile()} is not valid JSON: ${declaration.parseError}`);
      if (declaration.empty && !report) {
        try { JSON.parse(declaration.raw ?? ""); } catch (error) { die(`${desiredStateFile()} is not valid JSON: ${(error as Error).message}`); }
      }
      if (declaration.shapeError !== undefined && !report) die(`${desiredStateFile()} is not a valid desired-state declaration: ${declaration.shapeError}`);
      const resolvedFramework = await frameworkVersion();
      if (resolvedFramework === undefined) {
        die("cannot determine the framework version — a set that does not pin one would install on any framework");
      }
      framework = resolvedFramework;
    },
  });

  // Required declaration and framework gates execute in the builder callback, before recipe walking.
  // The callback assigns this for buildSetManifest after content collection.
  if (framework === undefined) die("cannot determine the framework version — a set that does not pin one would install on any framework");

  const desiredState = base.declaration.parseError === undefined && !base.declaration.empty && base.declaration.shapeError === undefined ? base.declaration.parsed : [];

  const desiredStateChecksum = base.inventory.find((file) => file.path === DESIRED_STATE_PATH)?.checksum ?? checksumOf("");
  const files: Record<string, string> = { [DESIRED_STATE_PATH]: desiredStateChecksum };
  const recipes: Record<string, SetRecipe> = {};
  const acceptance: Record<string, readonly AcceptanceCheck[]> = {};
  const report = options.reportInvalidDeclaration === true;
  for (const recipe of Object.keys(base.parsed.recipes)) {
    // Served content and the agent bundle split on the portable `agent/` prefix, exactly
    // as the two checksum walks used to key them.
    const served: Record<string, string> = {};
    const agentFiles: Record<string, string> = {};
    for (const file of base.inventory) {
      const prefix = `recipes/${recipe}/`;
      if (!file.path.startsWith(prefix)) continue;
      const rel = file.path.slice(prefix.length);
      if (rel.startsWith("agent/")) agentFiles[rel.slice("agent/".length)] = file.checksum;
      else served[rel] = file.checksum;
    }
    for (const [rel, sum] of Object.entries(served)) files[`recipes/${recipe}/${rel}`] = sum;
    for (const [rel, sum] of Object.entries(agentFiles)) files[`recipes/${recipe}/agent/${rel}`] = sum;
    // Only files the walk carried reach the manifest: a privateFiles entry is excluded
    // there, so its acceptance checks are not collected either.
    const parsed = base.parsed.recipes[recipe];
    // Only files the walk carried reach the manifest: a privateFiles entry is excluded there.
    const acceptancePath = acceptanceLabel(recipe);
    const diagnostic = base.diagnostics.find((entry) => entry.recipe === recipe && entry.source === "acceptance");
    if (base.inventory.some((file) => file.path === acceptancePath) && parsed.acceptance === undefined && diagnostic !== undefined && !report) die(diagnostic.problem.detail);
    if (base.inventory.some((file) => file.path === acceptancePath) && parsed.acceptance !== undefined) {
      acceptance[recipe] = parsed.acceptance;
    }
    const agent = agentFiles["config.json"] === undefined ? undefined : parsed.agent;
    if (agentFiles["config.json"] !== undefined && agent === undefined) {
      const agentDiagnostic = base.diagnostics.find((entry) => entry.recipe === recipe && entry.source === "agent-config");
      if (agentDiagnostic !== undefined && !report) die(agentDiagnostic.problem.detail);
      if (agentDiagnostic === undefined && !report) die(`recipe "${recipe}" has an agent/ bundle without agent/config.json — provision-agent requires it`);
    }
    recipes[recipe] = {
      checksum: checksumOfFileMap(served),
      files: served,
      ...(Object.keys(agentFiles).length === 0
        ? {}
        : { agentChecksum: checksumOfFileMap(agentFiles), agentFiles, ...(agent === undefined ? {} : { agent }) }),
    };
  }

  const manifest = buildSetManifest({
    name: setName,
    requires: { framework, image: await requiredImage(declaredImage, options.tolerateUnpinnedImage === true) },
    files,
    recipes,
    // Names only; buildSetManifest sorts and deduplicates, so readdir order cannot reach the id.
    secrets: await desiredSecretNames(desiredState),
    acceptance,
  });

  assertNoSecretValues(manifest, await localSecretValues());

  return { root, recipeRoot, desiredStateSource, manifest, content: portableContent(base, manifest) };
}

/** Loads a set from either source. An artifact goes integrity → unpack → the same file
 *  access the tree uses (verifyArtifact runs the tree validator against the staging); a tree
 *  is collected into its manifest. */
export async function loadSet(source: SetSource, options: SetLoadOptions = {}): Promise<LoadedSet> {
  if (source.kind === "artifact") return loadArtifact(source.path);
  return loadTree(options);
}

async function loadTree(options: SetLoadOptions): Promise<LoadedSet> {
  if (options.declaredImage === undefined) {
    die("loading a set from the working tree needs the declared image — pass declaredImage in the load options");
  }
  const collected = await collectManifest(options.declaredImage, readName("set", options.name ?? ""), {
    tolerateUnpinnedImage: options.tolerateUnpinnedImage,
    reportInvalidDeclaration: options.reportInvalidDeclaration,
  });
  return {
    source: { kind: "tree" },
    manifest: collected.manifest,
    id: setManifestId(collected.manifest),
    tree: { root: collected.root, recipeRoot: collected.recipeRoot, desiredStateSource: collected.desiredStateSource },
    content: collected.content,
    lock: await loadLock(),
    preRead: new Map(),
  };
}

/** What verification established about an artifact, plus the bytes of the recipe files it
 *  parsed — the builder reuses them instead of re-reading. */
export interface VerifiedArtifact {
  readonly manifest: SetManifest;
  readonly id: string;
  /** Absolute path → utf8 text and its checksum. Both sides hash the same utf8 text
   *  (checksumOf takes string | Uint8Array), so the checksums agree. */
  readonly preRead: ReadonlyMap<string, Buffer>;
}

interface ArchiveEntry {
  readonly path: string;
  readonly type: "file" | "directory";
}

function cleanArchivePath(raw: string): string {
  const path = raw.replace(/^\.\//, "").replace(/\/$/, "");
  if (path === "") return path;
  if (raw.startsWith("/") || path.includes("\\") || path.split("/").includes("..") || /^[A-Za-z]:/.test(path)) {
    throw new Error(`artifact contains an unsafe path: ${raw}`);
  }
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checksumMap(value: unknown, where: string): Record<string, string> {
  if (!isRecord(value)) throw new Error(`${where} must be an object of checksums`);
  for (const [path, checksum] of Object.entries(value)) {
    if (path === "" || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "." || part === "") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
      throw new Error(`${where} contains an unsafe path: ${path}`);
    }
    if (typeof checksum !== "string" || !/^[0-9a-f]{64}$/.test(checksum)) {
      throw new Error(`${where}/${path} is not a SHA-256 checksum`);
    }
  }
  return value as Record<string, string>;
}

/** Checks the manifest shape and its internal inventory before any artifact file is used.
 *  Content findings — a recipe name or acceptance check the recipe rules reject — are the
 *  validator's (validateSet), the same answer the tree gives; nothing here reaches
 *  accept.ts, which sits downstream of install.ts (module-load check). */
async function validateManifest(value: unknown): Promise<SetManifest> {
  if (!isRecord(value) || value.version !== SET_MANIFEST_VERSION || typeof value.name !== "string" || !isRecord(value.requires)) {
    throw new Error("artifact set.json has an invalid manifest shape");
  }
  readName("set", value.name);
  if (typeof value.requires.framework !== "string" || typeof value.requires.image !== "string") {
    throw new Error("artifact set.json has invalid requirements");
  }
  const files = checksumMap(value.files, "set files");
  if (files[DESIRED_STATE_PATH] === undefined) throw new Error(`artifact manifest does not contain ${DESIRED_STATE_PATH}`);
  if (!isRecord(value.recipes) || !Array.isArray(value.secrets) || !value.secrets.every((entry) => typeof entry === "string") || !isRecord(value.acceptance)) {
    throw new Error("artifact set.json has invalid recipes, secrets or acceptance");
  }

  const expected: Record<string, string> = { [DESIRED_STATE_PATH]: files[DESIRED_STATE_PATH] };
  for (const [name, rawRecipe] of Object.entries(value.recipes)) {
    // A name the grammar rejects is content, not integrity: the validator reports it
    // (recipeNameProblem), the same finding the tree answers with.
    if (!isRecord(rawRecipe)) throw new Error(`recipe ${name} is not an object`);
    const recipeFiles = checksumMap(rawRecipe.files, `recipe ${name} files`);
    if (rawRecipe.checksum !== checksumOfFileMap(recipeFiles)) throw new Error(`recipe ${name} has an incorrect content checksum`);
    for (const [path, checksum] of Object.entries(recipeFiles)) expected[`recipes/${name}/${path}`] = checksum;
    if (rawRecipe.agentFiles !== undefined) {
      const agentFiles = checksumMap(rawRecipe.agentFiles, `recipe ${name} agent files`);
      if (rawRecipe.agentChecksum !== checksumOfFileMap(agentFiles)) throw new Error(`recipe ${name} has an incorrect agent checksum`);
      for (const [path, checksum] of Object.entries(agentFiles)) expected[`recipes/${name}/agent/${path}`] = checksum;
    }
  }
  // The acceptance RULES are content, not integrity: a check that fails the spec is the
  // validator's SET_RECIPE_INVALID, read from the acceptance.json the archive carries —
  // the same answer the tree gives for the same bytes. Here only the shape is judged;
  // whether these entries agree with that file is verifyArtifact's comparison below.
  for (const [name, checks] of Object.entries(value.acceptance)) {
    if (!Array.isArray(checks)) throw new Error(`recipe ${name} acceptance must be an array`);
  }
  const actualKeys = Object.keys(files).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) throw new Error("artifact manifest file inventory disagrees with its recipe inventories");
  for (const path of actualKeys) if (files[path] !== expected[path]) throw new Error(`artifact manifest checksum disagreement for ${path}`);
  return value as unknown as SetManifest;
}

/** The integrity half of the artifact path: verifies archive structure, extracts only after
 *  that verification, then verifies every byte against the manifest. Throws on any archive-
 *  vs-manifest disagreement; it deliberately runs NO validation of the set's content —
 *  whether the set is coherent is body knowledge, decided by validateLoadedSet, so the load
 *  mode can never change which findings exist. */
async function verifyArtifact(artifact: string, staging: string): Promise<VerifiedArtifact> {
  const listing = await runLocalTar(["-tzf", artifact]);
  if (listing.code !== 0) throw new Error(`could not inspect ${artifact}: ${(listing.stderr || listing.stdout).trim()}`);
  const verbose = await runLocalTar(["-tvzf", artifact]);
  if (verbose.code !== 0) throw new Error(`could not inspect links in ${artifact}: ${(verbose.stderr || verbose.stdout).trim()}`);

  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  for (const raw of listing.stdout.split("\n").map((line) => line.trimEnd()).filter((line) => line !== "")) {
    const path = cleanArchivePath(raw);
    const directory = raw.endsWith("/") || path === "";
    if (seen.has(path)) throw new Error(`artifact contains duplicate entry: ${raw}`);
    seen.add(path);
    entries.push({ path, type: directory ? "directory" : "file" });
  }
  for (const line of verbose.stdout.split("\n").map((entry) => entry.trimEnd()).filter((entry) => entry !== "")) {
    // GNU tar uses `Sep 10 14:04` or `2026-09-10 14:04` for the date, owner/group may be
    // one or two fields — anchor on the date rather than counting columns.
    const match = /^(\S)\S*\s+.*?\s+(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}|\d{4}-\d{2}-\d{2})\s+\S+\s+(.*)$/u.exec(line);
    if (match === null) throw new Error(`cannot safely parse artifact listing: ${line}`);
    const type = match[1];
    const shown = match[2];
    if (type === "l" || type === "h") throw new Error(`artifact contains a link: ${shown}`);
    if (type !== "-" && type !== "d") throw new Error(`artifact contains unsupported entry type: ${shown}`);
  }

  const extract = await runLocalTar(["--no-same-owner", "--no-same-permissions", "-xzf", artifact, "-C", staging]);
  if (extract.code !== 0) throw new Error(`could not unpack ${artifact}: ${(extract.stderr || extract.stdout).trim()}`);

  const rawManifest = await readFile(join(staging, "set.json"), "utf8").catch(() => {
    throw new Error(`${artifact} has no readable set.json`);
  });
  let parsed: unknown;
  try { parsed = JSON.parse(rawManifest); } catch { throw new Error(`${artifact} contains invalid JSON in set.json`); }
  const manifest = await validateManifest(parsed);
  const files = entries.filter((entry) => entry.type === "file").map((entry) => entry.path).filter((path) => path !== "set.json").sort();
  const claimed = Object.keys(manifest.files).sort();
  if (JSON.stringify(files) !== JSON.stringify(claimed)) throw new Error("artifact contents disagree with the manifest file inventory");
  const preRead = new Map<string, Buffer>();
  const bytesFor = async (abs: string): Promise<Buffer | undefined> => {
    const cached = preRead.get(abs);
    if (cached !== undefined) return cached;
    try { const bytes = await readFile(abs); preRead.set(abs, bytes); return bytes; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  for (const path of claimed) {
    const abs = resolve(staging, ...path.split("/"));
    const actual = await bytesFor(abs);
    if (actual === undefined || checksumOf(actual) !== manifest.files[path]) throw new Error(`artifact content checksum mismatch: ${path}`);
  }
  for (const [name, recipe] of Object.entries(manifest.recipes)) {
    if (recipe.agent !== undefined) {
      const configPath = agentConfigLabel(name);
      if (manifest.files[configPath] !== undefined) {
        const configAbs = resolve(staging, configPath);
        const bytes = await bytesFor(configAbs);
        const text = bytes?.toString("utf8");
        const declared = text === undefined ? undefined : await parseAgentDeclaration(text, name);
        if (declared?.ok === true && canonicalJson(declared.value) !== canonicalJson(recipe.agent)) {
          throw new Error(`recipe ${name} agent declaration disagrees with its file`);
        }
        // bytes are already in the verification cache.
      }
    } else if (Object.keys(recipe.agentFiles ?? {}).length > 0 && manifest.files[agentConfigLabel(name)] !== undefined) {
      // config.json carried yet no declaration is incoherent; config.json itself held back by
      // policy is the privateFiles case — the validator judges it, not integrity.
      throw new Error(`recipe ${name} has agent files without an agent declaration`);
    }
    // A file policy keeps private (recipe.json privateFiles) is absent from the manifest and
    // the archive alike — nothing to compare, never an integrity error (parity with the tree).
    const acceptancePath = acceptanceLabel(name);
    if (manifest.files[acceptancePath] !== undefined) {
      const abs = resolve(staging, acceptancePath);
      const bytes = await bytesFor(abs);
      const text = bytes?.toString("utf8");
      const fromFile = text === undefined ? undefined : await parseAcceptanceChecks(text, name);
      if (fromFile?.ok !== false && canonicalJson(fromFile?.value ?? []) !== canonicalJson(manifest.acceptance[name] ?? [])) {
        throw new Error(`recipe ${name} acceptance disagrees with its file`);
      }
      // bytes are already in the verification cache.
    }
  }
  return { manifest, id: setManifestId(manifest), preRead };
}

/** One line for the install-time refusal: each failing code once with a count when it repeats,
 *  plus the recipes named, so "SET_RECIPE_INCOMPLETE, SET_RECIPE_INCOMPLETE" says which broke. */
export function coherenceSummary(problems: readonly Problem[]): string {
  const counts = new Map<string, number>();
  for (const entry of problems) counts.set(entry.code, (counts.get(entry.code) ?? 0) + 1);
  const codes = [...counts.entries()].map(([code, count]) => (count > 1 ? `${code} ×${count}` : code)).join(", ");
  const recipes = [...new Set(problems.map((entry) => /recipe "([^"]+)"/.exec(entry.detail)?.[1]).filter((name): name is string => name !== undefined))];
  return recipes.length === 0 ? codes : `${codes} (recipes: ${recipes.join(", ")})`;
}

async function loadArtifact(path: string): Promise<LoadedSet> {
  const staging = await mkdtemp(join(tmpdir(), "clawwright-set-load-"));
  let verified: VerifiedArtifact;
  let base: PortableContentBase;
  // One staging lifetime: verify first (integrity), then build the model over the unpacked
  // bytes — integrity already gated them (archive vs manifest, byte checksums). Only a
  // verifyArtifact failure is an integrity claim; a builder failure is rethrown as-is.
  let fromVerify = true;
  try {
    verified = await verifyArtifact(path, staging);
    fromVerify = false;
    base = await collectPortableContent({
      recipeRoot: join(staging, "recipes"),
      declarationPath: join(staging, "config", "desired-state.json"),
      recipes: Object.keys(verified.manifest.recipes).sort(),
      preRead: verified.preRead,
    });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw fromVerify ? new ArtifactIntegrityError(path, error) : error;
  }
  return { source: { kind: "artifact", path }, manifest: verified.manifest, id: verified.id, staging, content: portableContent(base, verified.manifest), lock: await loadLock(), preRead: verified.preRead };
}

/** Every finding a loaded set produces, without a Context — runs the validator over the
 *  model built at load time, the same engine over the same bytes for a tree and an
 *  artifact; no global source switch (S3.2). The staging of an artifact load is only
 *  needed while the model is built, so the caller may remove it after load as before. */
export async function validateLoadedSet(loaded: LoadedSet): Promise<Problem[]> {
  return validateSet(loaded.content, { checkFiles: true, lock: loaded.lock });
}
