// `clawwright set build` — collect everything a deployment installs into ONE artifact.
// The vocabulary (manifest, the three entities set/instance/state, content id) lives in
// set/model.ts; the collection itself is the loader in set/load.ts (one pipeline for tree
// and artifact alike), and this is the packer that feeds it, written to sets/<name>-<id>.tar.gz.
//
// A set builds with NO running instance, so target-side readers are never used here —
// ctx.transport and ctx.runtime are untouched; only ctx.settings (declared image) is read.

import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { die } from "#src/core/io/log.ts";
import type { LocalTarRunner } from "#src/set/artifacts/tar.ts";
import { withLocalTarRunner, tarCreateArchive } from "#src/set/artifacts/tar.ts";
import type { Context } from "#src/core/context.ts";
import { deploymentDir } from "#src/runtime/deployment.ts";
import { checksumOf } from "#src/service/checksums.ts";
import { loadSet } from "#src/set/load.ts";
import { recipeNameProblem } from "#src/set/ownership/validate.ts";
import { setManifestId, DESIRED_STATE_PATH } from "#src/set/artifacts/model.ts";
import type { SetManifest } from "#src/set/artifacts/model.ts";
import { localSecretValues, MIN_VALUE_LENGTH } from "./set-secrets-guard.ts";
import { renameOverPrivateFile } from "#src/security/privacy/private-file.ts";

/** What one build produced. The id is setManifestId(manifest); the artifact carries it in
 *  its file name, so two builds of unchanged content land on the same path. */
export interface SetBuild {
  readonly name: string;
  readonly id: string;
  readonly artifact: string;
  readonly manifest: SetManifest;
}

/** True only for a genuinely absent recipes directory. Any other errno means a source that
 *  exists and cannot be read, which must never pass for an empty inventory. */
export function absentRecipesSource(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** A set name derived from the deployment's, since the two don't share an alphabet: a
 *  deployment directory name is free-form, a set name goes through safeName's narrow rule.
 *  Deterministic (the name is part of the manifest, hence the id); if nothing valid
 *  survives derivation, the caller is asked for a name instead of getting an arbitrary one. */
export function defaultSetName(deployment: string): string {
  const derived = deployment
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "");
  if (derived === "") {
    die(`no set name could be derived from deployment "${deployment}" — pass one with --name`);
  }
  return derived;
}

/** Build = loadSet(tree) → the build-only refusals (a manifest that cannot be produced:
 *  declaration, framework version, image pin, secret values) → pack. Validating the
 *  findings is NOT build's task — a tree with findings still builds, and validate is where
 *  they are reported (R31-04); the install-time gate refuses the artifact instead. */
export async function buildSet(ctx: Context, setName: string): Promise<SetBuild> {
  const loaded = await loadSet({ kind: "tree" }, { name: setName, declaredImage: ctx.settings.image });
  // The one content gap build refuses for: a recipe folder the name grammar rejects would
  // pack a set every consumer reports (validateSet runs the same rule on the artifact), so
  // the tree is refused here with the same sentence instead.
  for (const name of Object.keys(loaded.manifest.recipes)) {
    const invalid = recipeNameProblem(name);
    if (invalid !== undefined) die(invalid.detail);
  }
  const tree = loaded.tree;
  if (tree === undefined) die("internal: loading a set from the tree carries no tree sources");
  return writeArtifact(tree.root, tree.recipeRoot, tree.desiredStateSource, setName, loaded.manifest);
}

/** What executes the archiver. A seam so checks can make tar fail mid-write on demand;
 *  the runner spawns without a shell, so a PATH shim can't intercept it. */
export type TarRunner = LocalTarRunner;

/** Runs `body` with the archiver answered by `substitute` instead of executed. */
export function withTarRunner<T>(substitute: TarRunner, body: () => Promise<T>): Promise<T> {
  return withLocalTarRunner(substitute, body);
}

/** Writes the artifact: the manifest as set.json plus every file it inventories, archived
 *  with tar into sets/<name>-<id>.tar.gz.
 *
 *  No exclude list on purpose: the archive contains exactly what the manifest lists, built
 *  from an explicit set of sources (recipes + declaration), so .env/secrets/data/backups
 *  can't leak via a forgotten exclusion.
 *
 *  The id is over the manifest, never over these bytes (tar embeds mtimes/ownership/order,
 *  so byte-identical archives aren't the goal) — two builds of an unchanged tree get the
 *  same id, and the id is the identity. */
async function writeArtifact(
  root: string,
  recipeRoot: string,
  desiredStateSource: string,
  setName: string,
  manifest: SetManifest,
): Promise<SetBuild> {
  const id = setManifestId(manifest);
  const secretValues = await localSecretValues();
  const staging = await mkdtemp(join(tmpdir(), "clawwright-set-"));
  try {
    // Pretty-printed on purpose: setManifestId computes over the canonical form, so
    // formatting here doesn't change what the set is.
    await writeFile(resolve(staging, "set.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    for (const [rel, sum] of Object.entries(manifest.files)) {
      const source = rel === DESIRED_STATE_PATH
        ? desiredStateSource
        : rel.startsWith("recipes/")
          ? resolve(recipeRoot, ...rel.slice("recipes/".length).split("/"))
          : resolve(root, ...rel.split("/"));
      const bytes = await readFile(source);
      for (const { name, value } of secretValues) {
        if (value.length >= MIN_VALUE_LENGTH && bytes.includes(value)) {
          die(`refusing to write the set: ${rel} contains the value of ${name}`);
        }
      }
      // Re-verified at copy time so a file edited mid-build can't disagree with the id.
      if (checksumOf(bytes) !== sum) die(`${rel} changed while the set was being built — run the build again`);
      const target = resolve(staging, ...rel.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }

    const setsDir = resolve(deploymentDir(), "sets");
    await mkdir(setsDir, { recursive: true });
    const artifact = resolve(setsDir, `${setName}-${id}.tar.gz`);
    // Written to a temp file in the same directory first, so publishing is a same-filesystem
    // rename and a mid-write failure never truncates the artifact already at that path.
    const temporary = resolve(setsDir, `.clawwright-build-${randomBytes(8).toString("hex")}.tmp`);
    try {
      // Local tar (set/artifacts/tar.ts), not the transport: a set is assembled from files
      // on THIS machine, and must not depend on a reachable target. The flags, path
      // spelling and flag-refusal retry live there; the archive path lets the retry drop
      // the partial file the failed attempt left.
      const result = await tarCreateArchive(temporary, staging);
      if (result.code !== 0) {
        // The first attempt's cause is the report: a retry under a tar that accepted the flag
        // would answer a corrupt archive with remote-host noise instead of the truth.
        die(`tar could not write the set archive: ${(result.stderr || result.stdout).trim()}`);
      }
      await renameOverPrivateFile(temporary, artifact);
    } finally {
      await rm(temporary, { force: true });
    }
    return { name: setName, id, artifact, manifest };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
