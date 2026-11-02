// Installing from an artifact rather than from the working tree's current files.
//
// One engine, two sources: plan/apply keep their existing rules (ordering, journal,
// instance lock, confirming inspection) and only "what does this deployment declare"
// changes — from an unpacked artifact instead of disk. Records the installed set's id on
// the target afterwards, so later questions (has it drifted, what would rollback mean)
// have somewhere to start.

import { copyFile, lstat, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { die, log } from "#src/core/io/log.ts";
import type { LocalArtifact } from "#src/core/values/plan.ts";
import { deploymentDir } from "#src/runtime/deployment.ts";
import { readName } from "#src/core/values/names.ts";
import { problem } from "#src/service/inspection.ts";
import { writeFileAtomic } from "#src/set/ownership/ledger.ts";
import { readFileCandidate } from "#src/set/ownership/candidate-file.ts";
import { loadSet, validateLoadedSet, coherenceSummary, ArtifactCoherenceError, ArtifactIntegrityError, INVALID_ARTIFACT } from "#src/set/load.ts";
import type { LoadedSet, VerifiedArtifact } from "#src/set/load.ts";
import type { Problem } from "#src/service/inspection.ts";
import type { Context } from "#src/core/context.ts";
import { setManifestId } from "./model.ts";
import type { SetManifest } from "./model.ts";
import { renameOverPrivateFile } from "#src/security/privacy/private-file.ts";
import { digestOf, sameContent } from "#src/runtime/docker/image-ref.ts";

// The integrity/verification machinery lives in set/load.ts (one loading pipeline for tree
// and artifact alike); this module installs from what it loads, and must never be imported
// BY load.ts — the dependency runs one way only (set-module-load.check.ts guards this).
export { coherenceSummary, INVALID_ARTIFACT } from "#src/set/load.ts";
export type { VerifiedArtifact };

/** What was installed immediately before the current set — one level, not a stack, same
 *  depth `rollback`'s single-file path already works at. */
export interface PreviousSet {
  readonly id: string;
  readonly name: string;
  readonly installedAt: string;
}

/** What the target records about the set it is running. */
export interface InstalledSet {
  readonly id: string;
  readonly name: string;
  readonly installedAt: string;
  /** What the set required, kept beside the id so a later mismatch can be described without
   *  the artifact present — the machine that installed it may be long gone. */
  readonly requires: SetManifest["requires"];
  /** The apply operation that installed this set. Its configSnapshot (operations.ts), when
   *  taken, is the configuration exactly as the PREVIOUS set left it — what `rollback
   *  --previous-set` needs. Absent for a pre-existing record or when no operation id was available. */
  readonly operationId?: string;
  /** The set this one replaced, so a rollback has somewhere to go back to. Absent for the
   *  first set ever installed on this instance. */
  readonly previous?: PreviousSet;
}

export function installedSetFile(ctx: Context): string {
  return `${ctx.settings.dataDir}/clawwright-installed-set.json`;
}

function legacyInstalledSetFile(ctx: Context): string {
  return `${ctx.settings.dataDir}/cf-installed-set.json`;
}

function legacyInstalledSetFiles(ctx: Context): string[] {
  return [
    `${ctx.settings.dataDir}/oc-installed-set.json`,
    legacyInstalledSetFile(ctx),
  ];
}

type InstalledSetParseResult = { readonly ok: true; readonly set: InstalledSet } | { readonly ok: false };

/** Pure parse+validate, shared by the tolerant reader (readInstalledSet) and the strict one
 *  (readInstalledSetStrict): only difference is what each does with `ok: false` — tolerant
 *  treats it as "nothing installed", strict refuses. */
function parseInstalledSetResult(text: string): InstalledSetParseResult {
  try {
    const parsed = JSON.parse(text) as InstalledSet;
    if (!isSetId(parsed.id) || typeof parsed.name !== "string") return { ok: false };
    readName("set", parsed.name);
    if (parsed.previous !== undefined && (!isSetId(parsed.previous.id) || typeof parsed.previous.name !== "string")) return { ok: false };
    if (parsed.previous !== undefined) readName("set", parsed.previous.name);
    return { ok: true, set: parsed };
  } catch {
    return { ok: false };
  }
}

function parseInstalledSet(text: string | undefined): InstalledSet | undefined {
  if (text === undefined) return undefined;
  const result = parseInstalledSetResult(text);
  return result.ok ? result.set : undefined;
}

export async function readInstalledSet(ctx: Context): Promise<InstalledSet | undefined> {
  const primary = await readFileCandidate(ctx, installedSetFile(ctx));
  if (primary.present) return parseInstalledSet(primary.text);
  for (const path of legacyInstalledSetFiles(ctx)) {
    const candidate = await readFileCandidate(ctx, path);
    if (candidate.present) return parseInstalledSet(candidate.text);
  }
  return undefined;
}

/** Thrown by readInstalledSetStrict() when the installed-set marker is PRESENT but unreadable
 *  or fails validation — bytes exist that this process cannot prove are safe to discard. */
export class InstalledSetUnreadableError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(
      `${path} exists but could not be read as a valid installed-set marker. Recording a newly installed ` +
        "set here would silently overwrite it, discarding the rollback chain (the \"previous\" set) it " +
        `carries — the bytes at ${path} have not been touched. Repair or restore this file, or import a ` +
        "known-good marker, before installing.",
    );
    this.name = "InstalledSetUnreadableError";
    this.path = path;
  }
}

/** Like readInstalledSet(), but for recordInstalledSet() below, about to WRITE a
 *  replacement marker: a marker PRESENT but unreadable/invalid must stop the caller rather
 *  than read as "nothing installed" — that would permanently lose the rollback chain the
 *  moment the write lands. A legitimately absent file still reads as "nothing installed". */
export async function readInstalledSetStrict(ctx: Context): Promise<InstalledSet | undefined> {
  const primary = await readFileCandidate(ctx, installedSetFile(ctx));
  if (primary.present) {
    const result = primary.text === undefined ? { ok: false as const } : parseInstalledSetResult(primary.text);
    if (!result.ok) throw new InstalledSetUnreadableError(installedSetFile(ctx));
    return result.set;
  }
  for (const path of legacyInstalledSetFiles(ctx)) {
    const candidate = await readFileCandidate(ctx, path);
    if (candidate.present) {
      const result = candidate.text === undefined ? { ok: false as const } : parseInstalledSetResult(candidate.text);
      if (!result.ok) throw new InstalledSetUnreadableError(path);
      return result.set;
    }
  }
  return undefined;
}

function isSetId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** Records the set just installed, carrying the one it replaced forward as `previous`.
 *  Re-recording the SAME id (apply re-run against a set already in force) must not
 *  overwrite `previous` with the set itself — that would make rollback undo nothing. An
 *  existing `previous` also survives a no-op apply for the same reason. */
export async function recordInstalledSet(ctx: Context, manifest: SetManifest, id: string, operationId?: string): Promise<void> {
  if (!isSetId(id) || id !== setManifestId(manifest)) {
    throw new Error("refusing to record an installed set whose id does not match its manifest");
  }
  readName("set", manifest.name);
  const current = await readInstalledSetStrict(ctx);
  const sameSet = current !== undefined && current.id === id;
  const previous: PreviousSet | undefined = current === undefined || sameSet
    ? current?.previous
    : { id: current.id, name: current.name, installedAt: current.installedAt };
  // A no-op re-apply of the SAME set (nothing changed, so applyFromSource() never opened a
  // Journal or took a snapshot for this operationId) must not overwrite the id that
  // actually installed it — rollback --previous-set reads this to find the snapshot to restore from.
  const effectiveOperationId = sameSet ? current.operationId : operationId;

  const record: InstalledSet = {
    id,
    name: manifest.name,
    installedAt: new Date().toISOString(),
    requires: manifest.requires,
    ...(effectiveOperationId === undefined ? {} : { operationId: effectiveOperationId }),
    ...(previous === undefined ? {} : { previous }),
  };
  await writeFileAtomic(ctx, installedSetFile(ctx), `${JSON.stringify(record, null, 2)}\n`);
}

/** An artifact path the pipeline already resolved (the plan's LocalArtifact) or a raw path
 *  a non-argument caller holds (the rollback cache, the checks) — the functions take either,
 *  so a plan-carried artifact passes through unwrapped and no brand is minted outside
 *  core/values. Precision (stage 7 S2.5): the plan's arguments always carry a minted
 *  LocalArtifact; raw strings are accepted ONLY for non-argument callers (rollback cache,
 *  checks). The union does NOT make raw paths impossible here — acceptance is a
 *  convenience for those callers, not a guarantee. */
export type ArtifactPath = LocalArtifact | string;

const pathOf = (artifact: ArtifactPath): string => typeof artifact === "string" ? artifact : artifact.path;

/** Keeps a validated artifact in the deployment so rollback does not depend on its original
 *  path still existing. The copy is complete before apply is allowed to mutate the target. */
export async function storeArtifactForRollback(artifact: ArtifactPath, verified: VerifiedArtifact): Promise<string> {
  const path = pathOf(artifact);
  readName("set", verified.manifest.name);
  if (!isSetId(verified.id)) throw new Error("refusing to store an artifact with an invalid content id");
  const directory = resolve(deploymentDir(), "sets");
  await mkdir(directory, { recursive: true });
  const destination = resolve(directory, `${verified.manifest.name}-${verified.id}.tar.gz`);
  if (await fileExists(destination)) {
    await withUnpackedArtifact(destination, async (_staging, cached) => {
      if (cached.id !== verified.id) throw new Error("cached rollback artifact has a different content id");
    }, `storing a rollback copy of ${destination}`);
    return destination;
  }
  const temporary = resolve(directory, `.clawwright-artifact-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await copyFile(path, temporary);
    await withUnpackedArtifact(temporary, async (_staging, copied) => {
      if (copied.id !== verified.id) throw new Error("artifact changed before it could be stored for rollback");
    }, `storing a rollback copy of ${path}`);
    await renameOverPrivateFile(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}

async function fileExists(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile(); } catch { return false; }
}

/** Loads an artifact and holds it to the same validation the tree gets: integrity failures
 *  (the archive is not a set) and blocking findings (the set it declares would not validate)
 *  die with the one refusal wording; anything else propagates unchanged. */
async function loadArtifactSet(artifact: string): Promise<LoadedSet> {
  let loaded: LoadedSet;
  try {
    loaded = await loadSet({ kind: "artifact", path: artifact });
  } catch (error) {
    if (error instanceof ArtifactIntegrityError) die(`${artifact} ${INVALID_ARTIFACT}: ${(error as Error).message}`);
    throw error;
  }
  const staging = loaded.staging;
  if (staging === undefined) die("internal: loading an artifact carries no staging directory");
  try {
    const problems = await validateLoadedSet(loaded);
    const blocking = problems.filter((entry) => entry.severity === "blocking");
    if (blocking.length > 0) throw new ArtifactCoherenceError(coherenceSummary(blocking));
    return loaded;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error instanceof ArtifactCoherenceError) die(`${artifact} ${INVALID_ARTIFACT}: ${(error as Error).message}`);
    throw error;
  }
}

export async function unpackArtifactVerified(artifact: ArtifactPath): Promise<{ staging: string; verified: VerifiedArtifact }> {
  const loaded = await loadArtifactSet(pathOf(artifact));
  const staging = loaded.staging;
  if (staging === undefined) die("internal: loading an artifact carries no staging directory");
  return { staging, verified: { manifest: loaded.manifest, id: loaded.id, preRead: loaded.preRead } };
}

export async function unpackArtifact(artifact: ArtifactPath): Promise<string> {
  return (await unpackArtifactVerified(artifact)).staging;
}

/** Read-only unpack for inspection — validate --set and set diff. Integrity still refuses
 *  (a corrupt archive is not a set), but blocking semantic findings come back instead of
 *  dying inside the gate, so the caller reports them through its own report/JSON path and
 *  an MCP client sees the problems rather than "error, no problems" (R32-05). */
export async function withArtifactInspected<T>(
  artifact: ArtifactPath,
  body: (staging: string, verified: VerifiedArtifact, problems: readonly Problem[]) => Promise<T>,
): Promise<T> {
  // Read-only load: integrity-only — a corrupt archive refuses (typed as
  // ArtifactIntegrityError), but blocking semantic findings are computed here from the
  // unpacked staging and handed to the caller instead of dying in the gate, so the caller
  // reports them through its own report/JSON path and an MCP client sees the problems
  // rather than "error, no problems" (R32-05).
  const path = pathOf(artifact);
  const loaded = await loadSet({ kind: "artifact", path }).catch((error: unknown) => {
    if (error instanceof ArtifactIntegrityError) die(`${path} ${INVALID_ARTIFACT}: ${(error as Error).message}`);
    throw error;
  });
  const staging = loaded.staging;
  if (staging === undefined) die("internal: loading an artifact carries no staging directory");
  try {
    const problems = await validateLoadedSet(loaded);
    // The caller's own failures (a blocking report, a diff that throws) propagate unwrapped:
    // wrapping them blames the artifact being read — in a nested `set diff`, the good one —
    // and turns validate's "N blocking finding(s)" into integrity wording (R33-03).
    return await body(staging, { manifest: loaded.manifest, id: loaded.id, preRead: loaded.preRead }, problems);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** The digest of the image the CONTAINER actually runs, not what a tag currently resolves
 *  to — ctx.runtime.imageReference() reports the newly-pulled digest after a `docker pull`
 *  even when the running container was never recreated. Same primitive (matching by hash
 *  suffix, since digests can carry more than one repo/tag form) evidence.ts's
 *  observeRuntime() uses. Exported so gather.ts's two uses (the SET_REQUIREMENT_UNMET match
 *  and observed.imageDigest) fetch the runtime identity once rather than twice. */
export async function runningDigests(ctx: Context): Promise<string[]> {
  const running = await ctx.runtime.runningImageIdentity?.();
  return running?.digests ?? [];
}

/** Pure: which fetched digest matches what the manifest requires, or the first one when
 *  none does. Split out so a caller already holding a runningDigests() result can reuse it. */
export function matchRequiredDigest(digests: string[], manifest: SetManifest): string | undefined {
  const required = digestOf(manifest.requires.image);
  return digests.find((digest) => digestOf(digest) === required) ?? digests[0];
}

export async function runningImageDigest(ctx: Context, manifest: SetManifest): Promise<string | undefined> {
  return matchRequiredDigest(await runningDigests(ctx), manifest);
}

/** Whether this machine can install what the set requires. Reported, not enforced by
 *  refusal: an older framework may still install correctly, and the reader decides — what
 *  must not happen is the mismatch going unmentioned. */
export function requirementProblems(manifest: SetManifest, present: { framework?: string; imageDigest?: string }): Problem[] {
  const problems: Problem[] = [];

  if (present.framework !== undefined && present.framework !== manifest.requires.framework) {
    problems.push(
      problem(
        "SET_REQUIREMENT_UNMET",
        `the set requires framework ${manifest.requires.framework}, this one is ${present.framework}`,
      ),
    );
  }
  // By hash suffix, not the full string: matchRequiredDigest() already matches the running
  // digest by SHA-256 hash alone so a mirrored image (different registry) still counts as
  // the same image, per runtimeMatches() (evidence.ts). Comparing the full string undid that.
  if (present.imageDigest !== undefined && !sameContent(present.imageDigest, manifest.requires.image)) {
    problems.push(
      problem(
        "SET_REQUIREMENT_UNMET",
        `the set requires image ${manifest.requires.image}, the instance runs ${present.imageDigest}`,
      ),
    );
  }
  return problems;
}

/** Runs `body` with an artifact unpacked, removing the staging directory afterwards
 *  whatever happens — a half-installed set left unpacked invites confusion with the deployment.
 *  The line after verification is the caller's: validate reads an artifact it will not install,
 *  so the default note is "checking" — pass "installing from …" where the caller installs. */
export async function withUnpackedArtifact<T>(
  artifact: ArtifactPath,
  body: (staging: string, verified: VerifiedArtifact) => Promise<T>,
  note = `checking ${pathOf(artifact)}`,
): Promise<T> {
  const { staging, verified } = await unpackArtifactVerified(artifact);
  log(note);
  try {
    return await body(staging, verified);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
