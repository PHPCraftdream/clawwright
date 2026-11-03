// Archive and replaced-copy inventory: listing what `backup` has published in the backup
// directory, and what `restore` has moved aside next to the data directory — the read side
// `backup list`/`backup prune-replaced` need. No tar invocation and no deletion here; both
// read the target through ctx.transport, never the local filesystem.

import type { Context } from "../../core/context.ts";
import { answeredProbe } from "../../runtime/files/datadir.ts";
import { deploymentName } from "../../runtime/deployment.ts";
import { TransportUnreachableError } from "../../runtime/transport/transport.ts";
import { parseBackupArchive, parseReplacedCopyName, parseSnapshotArchive, snapshotDeploymentNames, type Profile } from "./profile.ts";
import { dataDirName, dataDirParent } from "./pack.ts";

export interface BackupArchiveInfo {
  readonly name: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly profile: Profile;
  readonly stamp: string;
}

export interface ReplacedCopyInfo {
  readonly name: string;
  readonly path: string;
  /** undefined when `du` could not size it (permissions, or it vanished mid-listing) —
   *  never guessed at. */
  readonly sizeBytes: number | undefined;
  readonly modifiedAt: string;
  readonly stamp: string;
}

function toIso(epochSecondsField: string): string {
  const ms = Number(epochSecondsField) * 1000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A listing did not complete; its contents are unknown, not empty. */
export class InventoryUnreadableError extends Error {
  readonly kind: "archives" | "replaced copies";

  constructor(kind: "archives" | "replaced copies", reason: string) {
    super(`${kind} inventory unreadable; contents unknown (${reason})`);
    this.kind = kind;
    this.name = "InventoryUnreadableError";
  }
}

/** A missing path is certain only when a traversable ancestor proves its child absent. */
const ABSENT_PROBE = 'p=$1; while [ "$p" != / ]; do parent=${p%/*}; [ -n "$parent" ] || parent=/; if [ -d "$parent" ]; then [ -r "$parent" ] && [ -x "$parent" ] || exit 2; [ ! -e "$p" ] && [ ! -L "$p" ] && exit 0; exit 2; fi; p=$parent; done; exit 2';

/** The prefix needed to read `dir`, or undefined when it is provably absent. */
async function readPrefix(ctx: Context, dir: string, kind: InventoryUnreadableError["kind"]): Promise<string[] | undefined> {
  try {
    const directory = await answeredProbe(ctx, "test", ["-d", dir], [0, 1]);
    if (directory.code !== 0) {
      const absent = await answeredProbe(ctx, "sh", ["-c", ABSENT_PROBE, "sh", dir], [0, 2]);
      if (absent.code === 0) return undefined;
      throw new InventoryUnreadableError(kind, "directory cannot be verified");
    }
    const readable = await answeredProbe(ctx, "sh", ["-c", 'test -r "$1" && test -x "$1"', "sh", dir], [0, 1]);
    if (readable.code === 0) return [];
    const sudo = await ctx.transport.exec("sudo", ["-n", "true"], { allowFailure: true });
    if (sudo.code === 0) return ["sudo", "-n"];
    throw new InventoryUnreadableError(kind, "read access denied");
  } catch (error) {
    if (error instanceof InventoryUnreadableError || error instanceof TransportUnreachableError) throw error;
    throw new InventoryUnreadableError(kind, "directory probe failed");
  }
}

/** Every archive of THIS deployment in `backupDir`, newest first. A sibling deployment's
 *  archive sharing the directory, or a file `pull` left there, is excluded by
 *  parseBackupArchive. Restore consumes this inventory too. */
export async function listBackupArchives(ctx: Context, backupDir: string): Promise<BackupArchiveInfo[]> {
  const deployment = deploymentName();
  const prefix = await readPrefix(ctx, backupDir, "archives");
  if (prefix === undefined) return [];
  const [head, ...rest] = [
    ...prefix, "find", backupDir, "-maxdepth", "1", "-type", "f",
    "-name", `${deployment}-*.tar.gz`, "-printf", "%s\t%T@\t%p\n",
  ];
  const result = await ctx.transport.exec(head, rest, { allowFailure: true });
  if (result.code !== 0) throw new InventoryUnreadableError("archives", `find exited ${result.code}`);

  const entries: BackupArchiveInfo[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [sizeField, mtimeField, path] = line.split("\t");
    const name = basenameOf(path);
    const parsed = parseBackupArchive(name, deployment);
    if (parsed === undefined) continue;
    entries.push({
      name,
      path,
      sizeBytes: Number(sizeField),
      modifiedAt: toIso(mtimeField),
      profile: parsed.profile,
      stamp: parsed.stamp,
    });
  }
  entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return entries;
}

/** Which archive a bare restore would pick from the shared inventory. */
export function defaultRestoreArchive(archives: readonly BackupArchiveInfo[]): BackupArchiveInfo | undefined {
  return archives.find((entry) => entry.profile === "full");
}

/** Published snapshots of this deployment, newest first. Listing failures stay unknown. */
export async function listSnapshotArchives(ctx: Context, snapshotDir: string): Promise<string[]> {
  const deployment = deploymentName();
  const prefix = await readPrefix(ctx, snapshotDir, "archives");
  if (prefix === undefined) return [];
  const names = snapshotDeploymentNames(deployment);
  const [head, ...rest] = [
    ...prefix, "find", snapshotDir, "-maxdepth", "1", "-type", "f", "(",
    ...names.flatMap((name, index) => [...(index === 0 ? [] : ["-o"]), "-name", `${name}-state-*.tar.gz`]),
    ")", "-printf", "%T@\t%p\n",
  ];
  const result = await ctx.transport.exec(head, rest, { allowFailure: true });
  if (result.code !== 0) throw new InventoryUnreadableError("archives", `find exited ${result.code}`);

  const entries: { path: string; modified: number }[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    if (tab < 0) throw new InventoryUnreadableError("archives", "listing malformed");
    const modified = Number(line.slice(0, tab));
    const path = line.slice(tab + 1);
    if (!Number.isFinite(modified)) throw new InventoryUnreadableError("archives", "listing malformed");
    if (parseSnapshotArchive(basenameOf(path), deployment) !== undefined) entries.push({ path, modified });
  }
  entries.sort((a, b) => b.modified - a.modified);
  return entries.map((entry) => entry.path);
}

/** Every `<dataDir>.replaced-<stamp>` sibling restore left next to the data directory,
 *  newest first — what restore keeps instead of deleting, until `backup prune-replaced`.
 *  Sized with a second, batched `du -sb` pass: each is a directory tree, not a single file
 *  `find -printf %s` (used above for archives) could size. */
export async function listReplacedCopies(ctx: Context, dataDir: string): Promise<ReplacedCopyInfo[]> {
  const name = dataDirName(dataDir);
  const parent = dataDirParent(dataDir);
  const prefix = await readPrefix(ctx, parent, "replaced copies");
  if (prefix === undefined) return [];
  const [head, ...rest] = [
    ...prefix, "find", parent, "-maxdepth", "1", "-type", "d",
    "-name", `${name}.replaced-*`, "-printf", "%T@\t%p\n",
  ];
  const result = await ctx.transport.exec(head, rest, { allowFailure: true });
  if (result.code !== 0) throw new InventoryUnreadableError("replaced copies", `find exited ${result.code}`);

  const candidates: { path: string; modifiedAt: string; stamp: string }[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [mtimeField, path] = line.split("\t");
    // The glob above is a coarse filter; parseReplacedCopyName is the strict one — the
    // same two-tier check listBackupArchives applies with parseBackupArchive.
    const parsed = parseReplacedCopyName(basenameOf(path), name);
    if (parsed === undefined) continue;
    candidates.push({ path, modifiedAt: toIso(mtimeField), stamp: parsed.stamp });
  }
  if (candidates.length === 0) return [];

  const [duHead, ...duRest] = [...prefix, "du", "-sb", "--", ...candidates.map((c) => c.path)];
  const sized = await ctx.transport.exec(duHead, duRest, { allowFailure: true });
  const sizeByPath = new Map<string, number>();
  if (sized.code === 0) {
    for (const line of sized.stdout.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const bytes = Number(line.slice(0, tab));
      if (Number.isFinite(bytes)) sizeByPath.set(line.slice(tab + 1), bytes);
    }
  }

  const entries = candidates.map((c) => ({
    name: basenameOf(c.path),
    path: c.path,
    sizeBytes: sizeByPath.get(c.path),
    modifiedAt: c.modifiedAt,
    stamp: c.stamp,
  }));
  entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return entries;
}
