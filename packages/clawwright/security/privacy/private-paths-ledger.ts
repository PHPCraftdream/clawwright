// The deployment's memory of its own private target writes.
//
// A privatePaths declaration can disappear (recipe removed, set switched) while the data it
// protected stays on disk. Without a separate record, archive exclusions and verify's
// refusals would lose the path the moment the declaration vanished — a credential silently
// becomes shareable. This ledger is that record: every private write appends the written
// path and its boundary; installedRecipePrivatePaths unions the ledger with current
// declarations. A path stays protected until explicitly forgotten (forgetPrivatePaths,
// after the data is deleted), which records a tombstone rather than relying on emptiness.
//
// File: <deployment>/config/private-paths.json. Reads fail closed; writes are strict once
// config/ exists. Recording happens BEFORE the write it describes.
//
// A twin copy lives in the data directory: config/clawwright-private-paths.json, so a restore
// through a different deployment folder gets its own copy of the history with the data.
// createArchive() publishes it before a full backup; restore imports it back first.
// migrate/share exclude the copy — it travels with full backups only.

import { randomBytes } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Context } from "../../core/context.ts";
import { sudoFor } from "../../runtime/files/datadir.ts";
import { deploymentDir, selectedDeployment } from "../../runtime/deployment.ts";
import { renameOverPrivateFile } from "./private-file.ts";

/** The ledger file: <deployment>/config/private-paths.json. */
export function privatePathsLedgerFile(): string {
  return resolve(deploymentDir(), "config", "private-paths.json");
}

/** Validates one data-relative ledger entry — the same rules a privatePaths declaration
 *  follows, because the ledger's entries are consumed by the same readers. */
function validateEntry(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`private-paths ledger entries must be non-empty data-relative paths: ${String(value)}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`private-paths ledger entries must stay inside the data directory: ${value}`);
  }
  return value;
}

/** Parses and validates ledger content — shared by the deployment-side reader and the
 *  restored-history import, so an entry refused on one side is refused on both. A path
 *  named by both arrays (recorded and tombstoned) is a corrupt ledger. */
function readLedgerPayload(raw: string, file: string): { paths: string[]; forgotten: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`could not parse ${file}: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${file} must contain an object`);
  }
  const payload = parsed as { privatePaths?: unknown; forgotten?: unknown };
  const paths = payload.privatePaths;
  if (!Array.isArray(paths)) {
    throw new Error(`${file}: privatePaths must be an array of data-relative paths`);
  }
  const forgotten = payload.forgotten ?? [];
  if (!Array.isArray(forgotten)) {
    throw new Error(`${file}: forgotten must be an array of data-relative paths`);
  }
  const recorded = [...new Set(paths.map((entry) => validateEntry(entry)))].sort();
  const dropped = [...new Set(forgotten.map((entry) => validateEntry(entry)))].sort();
  for (const value of recorded) {
    if (dropped.includes(value)) {
      throw new Error(`${file}: privatePaths and forgotten must not overlap: ${value}`);
    }
  }
  return { paths: recorded, forgotten: dropped };
}

/** The ledger's state on disk: recorded paths, tombstones, and whether the file exists at
 *  all — "never written" and "written, then emptied by a real forget" are different. */
export interface PrivatePathsLedgerState {
  readonly paths: readonly string[];
  readonly forgotten: readonly string[];
  readonly existed: boolean;
}

async function readLedgerState(file: string): Promise<PrivatePathsLedgerState> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    // A missing file is an honest empty history; anything else is a stop.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { paths: [], forgotten: [], existed: false };
    }
    throw new Error(`could not read ${file}: ${(error as Error).message}`);
  }
  const { paths, forgotten } = readLedgerPayload(raw, file);
  return { paths, forgotten, existed: true };
}

/** Writes both arrays canonically: deduplicated, sorted, two-space indent, trailing newline.
 *  Tombstones are OMITTED when empty, so an older reader sees an unchanged byte format.
 *  Temporary sibling plus rename makes the write atomic. */
async function writeLedgerState(file: string, paths: readonly string[], forgotten: readonly string[]): Promise<void> {
  const unique = [...new Set(paths)].sort();
  const dropped = [...new Set(forgotten)].sort();
  const payload: { privatePaths: string[]; forgotten?: string[] } = { privatePaths: unique };
  if (dropped.length > 0) payload.forgotten = dropped;
  const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await renameOverPrivateFile(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new Error(`could not write ${file}: ${(error as Error).message}`);
  }
}

// Read-merge-write is not atomic across concurrent mutations of the same process (two
// private-write helpers under one hook's Promise.all could each read the same version and
// the last rename would drop the first's addition). Every mutation therefore queues behind
// its file's previous one, keyed by the resolved ledger path. A failed cycle releases the
// file so it doesn't jam mutations queued behind it.
const ledgerMutations = new Map<string, Promise<void>>();

/** The serialized cycle every ledger change goes through: one cycle per resolved ledger path
 *  at a time. Must not start another mutation of the same file from inside itself. A cycle
 *  that throws releases the file exactly like one that succeeds. */
async function runLedgerCycle<T>(file: string, cycle: () => Promise<T>): Promise<T> {
  const turn = (ledgerMutations.get(file) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => cycle());
  const settled = turn.then(
    () => undefined,
    () => undefined,
  );
  const release: Promise<void> = settled.then(() => {
    if (ledgerMutations.get(file) === release) ledgerMutations.delete(file);
  });
  ledgerMutations.set(file, release);
  return turn;
}

/** The state-aware read-merge-write cycle: the merge sees the full ledger state and returns
 *  the next arrays (null leaves the file untouched) plus the value the caller gets back. A
 *  returned next writes BOTH arrays — a merge that names one and forgets the other silently
 *  drops tombstones. */
export function mutatePrivatePathsLedgerState<T>(
  file: string,
  merge: (
    current: PrivatePathsLedgerState,
  ) =>
    | { next: { paths: readonly string[]; forgotten: readonly string[] } | null; value: T }
    | Promise<{ next: { paths: readonly string[]; forgotten: readonly string[] } | null; value: T }>,
): Promise<T> {
  return runLedgerCycle(file, async () => {
    const current = await readLedgerState(file);
    const { next, value } = await merge(current);
    if (next !== null) await writeLedgerState(file, next.paths, next.forgotten);
    return value;
  });
}

/** Paths-only cycle for the serialization regression check. Merge sees the recorded paths
 *  only; the forgotten array is reattached UNCHANGED so this shape cannot lose a tombstone. */
export function mutatePrivatePathsLedger<T>(
  file: string,
  merge: (
    current: readonly string[],
  ) => { next: readonly string[] | null; value: T } | Promise<{ next: readonly string[] | null; value: T }>,
): Promise<T> {
  return mutatePrivatePathsLedgerState<T>(file, async (current) => {
    const { next, value } = await merge(current.paths);
    return { next: next === null ? null : { paths: next, forgotten: current.forgotten }, value };
  });
}

/** Removes the ledger file outright, inside the same serialized cycle as every mutation, so a
 *  delete can't land between a queued mutation's read and write. No parse first: a rollback
 *  must be able to remove a ledger that cannot even be parsed. */
export async function removePrivatePathsLedger(file: string): Promise<void> {
  await runLedgerCycle(file, async () => {
    await rm(file, { force: true });
  });
}

/** The recorded half of the security policy: paths private-config.ts actually wrote on this
 *  deployment's target, data-relative. Quiet with no deployment selected; strict (throws)
 *  when a ledger exists but cannot be read/parsed/validated. */
export async function persistedPrivatePaths(): Promise<string[]> {
  // No deployment selected: the same answer as "no recipes configured".
  if (selectedDeployment() === undefined) return [];
  const { paths } = await readLedgerState(privatePathsLedgerFile());
  return [...paths];
}

/** The full ledger state — recorded entries, tombstones, and whether the file exists — for
 *  the selected deployment. Same quiet/strict rules as persistedPrivatePaths above. */
export async function privatePathsLedgerState(): Promise<PrivatePathsLedgerState> {
  // No deployment selected: nothing recorded, and no file to have written either.
  if (selectedDeployment() === undefined) return { paths: [], forgotten: [], existed: false };
  return readLedgerState(privatePathsLedgerFile());
}

/** The target-state copy of the history: <dataDir>/config/clawwright-private-paths.json. */
export function privatePathsHistoryFile(dataDir: string): string {
  return `${dataDir.replace(/\/+$/, "")}/config/clawwright-private-paths.json`;
}

/** Read-only union for security checks: local history, target history, minus explicit
 * tombstones. This never reconciles or writes either copy. */
export async function privatePathsPolicy(ctx: Context): Promise<string[]> {
  const local = await privatePathsLedgerState();
  const target = await readTargetHistory(ctx, privatePathsHistoryFile(ctx.settings.dataDir));
  const legacyForget = local.existed && local.paths.length === 0 && local.forgotten.length === 0;
  const activeTarget = legacyForget ? [] : (target ?? []).filter((entry) => !local.forgotten.includes(entry));
  return [...new Set([...local.paths, ...activeTarget])].sort();
}

/** Whether the deployment-side ledger file has ever been written on THIS deployment folder
 *  — distinct from "reads as empty", which a missing file also does. A file existing with
 *  zero entries can only happen via forgetPrivatePaths dropping the last one. */
async function ledgerFileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Reads the target-side history copy, escalating like importRestoredPrivatePathsHistory
 *  since the copy was written through the private writer. Raw bytes are returned alongside
 *  the parsed entries for publish's skip-when-identical check. Undefined = no copy; throws
 *  if one exists but can't be read/parsed (fail closed, never "nothing to protect"). */
async function readTargetHistoryCopy(ctx: Context, file: string): Promise<{ raw: string; paths: string[] } | undefined> {
  if (!(await ctx.transport.exists(file))) return undefined;
  const readable = await ctx.transport.exec("test", ["-r", file], { allowFailure: true });
  let prefix: string[] = [];
  if (readable.code !== 0) {
    if (readable.code !== 1) throw new Error(`could not check read access to ${file}: ${readable.stderr.trim()}`);
    prefix = await sudoFor(ctx, file, { force: true });
    const [testHead, ...testRest] = [...prefix, "test", "-r", file];
    const elevated = await ctx.transport.exec(testHead, testRest, { allowFailure: true });
    if (elevated.code !== 0) throw new Error(`could not read the existing privacy history ${file}, even with elevated access`);
  }
  const [head, ...rest] = [...prefix, "cat", file];
  const result = await ctx.transport.exec(head, rest);
  if (result.code !== 0) {
    throw new Error(`could not read the existing privacy history ${file}: ${result.stderr.trim() || `cat exited ${result.code}`}`);
  }
  return { raw: result.stdout, paths: readLedgerPayload(result.stdout, file).paths };
}

/** The target copy's entries alone — the adoption input, and what reconcile merges. */
async function readTargetHistory(ctx: Context, file: string): Promise<string[] | undefined> {
  const copy = await readTargetHistoryCopy(ctx, file);
  return copy?.paths;
}

/** Adopts an existing target-side history into the local ledger instead of letting an empty,
 *  never-written local ledger erase it. Respects tombstones (adoption never resurrects a
 *  deliberately forgotten path). Undefined when there is nothing to adopt. */
async function adoptExistingTargetHistory(
  existing: readonly string[],
  localFile: string | undefined,
): Promise<string[] | undefined> {
  if (existing.length === 0) return undefined;
  if (localFile !== undefined) {
    await mutatePrivatePathsLedgerState(localFile, (current) => {
      const added = existing.filter((entry) => !current.paths.includes(entry) && !current.forgotten.includes(entry));
      return added.length === 0
        ? { next: null, value: undefined }
        : { next: { paths: [...current.paths, ...added], forgotten: current.forgotten }, value: undefined };
    });
  }
  return [...existing];
}

/** Publishes the current ledger into the data root, for createArchive() to catch in a full
 *  backup. An empty history removes any copy left behind ONLY when the local ledger FILE
 *  exists (proof forgetPrivatePaths ran) — a never-written local ledger looks identical to a
 *  deliberately forgotten one by content alone, but the target may be the only surviving
 *  record, so it's adopted and republished instead of erased. Atomic REPLACE, skipped when
 *  the target already holds the exact bytes (an EXCLUSIVE create would fail every second
 *  backup), and never deletes the old history first. */
export async function publishPrivatePathsHistory(ctx: Context): Promise<void> {
  const file = privatePathsHistoryFile(ctx.settings.dataDir);
  // No deployment selected: publish falls back to whatever the target already carries.
  const localFile = selectedDeployment() === undefined ? undefined : privatePathsLedgerFile();
  const localRecorded = localFile !== undefined && (await ledgerFileExists(localFile));
  // Read ONCE: adoption input, remove decision, and the write's skip-baseline. Throws if the
  // copy exists but can't be read/parsed — fail closed.
  const target = await readTargetHistoryCopy(ctx, file);
  const existing = target?.paths;
  let paths = await persistedPrivatePaths();
  if (paths.length === 0 && !localRecorded) {
    const adopted = existing !== undefined && existing.length > 0
      ? await adoptExistingTargetHistory(existing, localFile)
      : undefined;
    if (adopted !== undefined) paths = adopted;
  }
  if (paths.length === 0) {
    if (existing !== undefined) await ctx.transport.remove(file);
    return;
  }
  await ctx.transport.mkdirp(dirname(file));
  const body = `${JSON.stringify({ privatePaths: [...new Set(paths)].sort() }, null, 2)}\n`;
  // Byte-identical short-circuit: the copy already holds exactly what publish would write, so
  // there is nothing to replace and those bytes are left where they are, untouched.
  if (target !== undefined && target.raw === body) return;
  await ctx.transport.writeFile(file, body, "600");
}

/** Imports a restored history copy back into the deployment-side ledger. restore calls this
 *  after the layout check and before anything acts on the restored data; a copy that exists
 *  but cannot be read/parsed fails the restore while the previous data is still in place.
 *  Entries merge (union); the restored archive physically carries the data again, so it
 *  supersedes tombstones — a deliberately forgotten path the archive brings back is recorded
 *  again and its tombstone dropped. Returns the entries this import added. */
export async function importRestoredPrivatePathsHistory(ctx: Context, file: string): Promise<string[]> {
  // Through sudoFor, not transport.readFile: extraction may have run privileged, and a
  // root-owned history file must fail the restore deliberately, not look unreadable-by-accident.
  const prefix = await sudoFor(ctx, file);
  const [head, ...rest] = [...prefix, "cat", file];
  const result = await ctx.transport.exec(head, rest);
  if (result.code !== 0) {
    throw new Error(`could not read the restored privacy history ${file}: ${result.stderr.trim() || `cat exited ${result.code}`}`);
  }
  const restored = readLedgerPayload(result.stdout, file);
  return mutatePrivatePathsLedgerState(privatePathsLedgerFile(), (current) => {
    const added = restored.paths.filter((entry) => !current.paths.includes(entry));
    const forgotten = current.forgotten.filter((candidate) => !restored.paths.includes(candidate));
    return added.length === 0 && forgotten.length === current.forgotten.length
      ? { next: null, value: added }
      : { next: { paths: [...current.paths, ...added], forgotten }, value: added };
  });
}

/** Records a private write so its path stays protected after its declaration is gone. Two
 *  facts travel together: the exact written path, and the declared boundary that authorized
 *  it (a prefix of the path, or the path itself) — keeping exclusion as wide after the
 *  declaration disappears as before. Ancestors the author never declared are NOT recorded: a
 *  write to `config/secret.env` under a shared `config/` must not turn `config` into a
 *  private root. Quietly skipped with no deployment selected or no config/ yet; an invalid
 *  entry is refused regardless — a programming error, not a policy answer. */
export async function recordPrivateWrite(relativePath: string, declaredBoundary?: string): Promise<void> {
  const entry = validateEntry(relativePath);
  const boundary = declaredBoundary === undefined ? entry : validateEntry(declaredBoundary);
  if (boundary !== entry && !entry.startsWith(`${boundary}/`)) {
    throw new Error(`the declared private boundary must contain the written path: ${boundary} does not contain ${entry}`);
  }
  if (selectedDeployment() === undefined) return;
  const file = privatePathsLedgerFile();
  try {
    await access(dirname(file));
  } catch {
    return;
  }
  await mutatePrivatePathsLedgerState(file, (current) => {
    const recorded = boundary === entry ? [entry] : [entry, boundary];
    const missing = recorded.filter((candidate) => !current.paths.includes(candidate));
    // A private write after a forget means the data is back: the tombstone for a recorded
    // entry no longer describes reality and is cleared.
    const cleared = current.forgotten.filter((candidate) => !recorded.includes(candidate));
    return missing.length === 0 && cleared.length === current.forgotten.length
      ? { next: null, value: undefined }
      : { next: { paths: [...current.paths, ...missing], forgotten: cleared }, value: undefined };
  });
}

/** The explicit forget: drops ledger entries whose data has really been deleted, and records
 *  a tombstone for each. The ONLY way an entry leaves the ledger. Requires a selected
 *  deployment: acting against an unknown one is a caller bug, not a no-op. Joins the same
 *  serialized cycle as recording, so a concurrent record can't be lost under it. The
 *  tombstone distinguishes "deliberately forgotten" from "history missing/lost", which file
 *  existence or emptiness alone could never do. */
export async function forgetPrivatePaths(relativePaths: readonly string[]): Promise<void> {
  const file = privatePathsLedgerFile();
  const drop = new Set(relativePaths.map((entry) => validateEntry(entry)));
  await mutatePrivatePathsLedgerState(file, (current) => {
    if (!current.existed) return { next: null, value: undefined };
    const paths = current.paths.filter((entry) => !drop.has(entry));
    const forgotten = [...new Set([...current.forgotten, ...drop])].sort();
    return paths.length === current.paths.length && forgotten.length === current.forgotten.length
      ? { next: null, value: undefined }
      : { next: { paths, forgotten }, value: undefined };
  });
}

/** Reconciles the target-side history into the deployment-side ledger, for readers that
 *  never publish (migrate/share). A deployment folder pointed at already-existing target
 *  data would otherwise build exclusions from a record that isn't there — this takes the
 *  union before the policy is read. Tombstones suppress resurrection; an existing, entirely
 *  empty, tombstone-less ledger predates tombstones and is honored as the forget it can only
 *  be. Union only: entries still leave only through forgetPrivatePaths. */
export async function reconcilePrivatePathsHistory(ctx: Context): Promise<void> {
  if (selectedDeployment() === undefined) return;
  const file = privatePathsHistoryFile(ctx.settings.dataDir);
  const localFile = privatePathsLedgerFile();
  // Throws if the copy exists but can't be read/validated — refuse loudly, never "no history".
  const existing = await readTargetHistory(ctx, file);
  if (existing === undefined || existing.length === 0) return;
  await mutatePrivatePathsLedgerState(localFile, (current) => {
    if (current.existed && current.paths.length === 0 && current.forgotten.length === 0) {
      // Legacy pre-tombstone empty ledger: only an old-protocol forget ever wrote this shape,
      // so it is honored as one — history is never resurrected into it.
      return { next: null, value: undefined };
    }
    const added = existing.filter((entry) => !current.paths.includes(entry) && !current.forgotten.includes(entry));
    return added.length === 0
      ? { next: null, value: undefined }
      : { next: { paths: [...current.paths, ...added], forgotten: current.forgotten }, value: undefined };
  });
}
