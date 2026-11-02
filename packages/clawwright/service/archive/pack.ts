// Archive packing/unpacking/listing: the tar invocations themselves, plus the privilege
// prefix and path helpers they need.

import type { Context } from "../../core/context.ts";
import { sudoFor } from "../../runtime/files/datadir.ts";
import { publishPrivatePathsHistory, reconcilePrivatePathsHistory } from "../../security/privacy/private-paths-ledger.ts";
import { installedRecipePrivatePaths } from "../recipe.ts";
import { excludesFor, type Profile } from "./profile.ts";
import type { ArchiveLink } from "./validate.ts";

export function dataDirName(dataDir: string): string {
  const trimmed = dataDir.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export function dataDirParent(dataDir: string): string {
  const trimmed = dataDir.replace(/\/+$/, "");
  const parent = trimmed.slice(0, trimmed.lastIndexOf("/"));
  return parent === "" ? "/" : parent;
}

/** The privilege prefix for one archive command, decided per path the command touches.
 *  Reading and writing are different capabilities: the archive destination being writable
 *  says nothing about whether the identity can read the tree tar reads (auth-secrets is
 *  locked to 1000:1000 mode 700 by ensureDataDirs regardless of who may write the archive
 *  file), and readability says nothing about the destination it unpacks into. Every path is
 *  asked individually — sources first, destination last — and the first that demands
 *  escalation decides the prefix for the whole invocation; sudoFor falls back to the
 *  nearest existing ancestor for a path that doesn't exist yet. */
export async function privilegePrefixFor(ctx: Context, readPaths: readonly string[], writePath?: string): Promise<string[]> {
  for (const path of readPaths) {
    let present: boolean;
    // Conservative on purpose (S3.4 exception): an exists() the target could not answer is
    // treated as PRESENT, so privilege escalation is still demanded, never skipped.
    try { present = await ctx.transport.exists(path); }
    catch { present = true; }
    if (!present) continue;
    const readable = await ctx.transport.exec("test", ["-r", path], { allowFailure: true });
    if (readable.code === 0) {
      const directory = await ctx.transport.exec("test", ["-d", path], { allowFailure: true });
      if (directory.code === 1) continue;
      if (directory.code !== 0) throw new Error(`could not determine whether ${path} is a directory`);
      const searchable = await ctx.transport.exec("test", ["-x", path], { allowFailure: true });
      if (searchable.code === 0) continue;
      if (searchable.code !== 1) throw new Error(`could not check traversal access to ${path}`);
    }
    if (readable.code !== 0 && readable.code !== 1) {
      throw new Error(`could not check read access to ${path}: ${readable.stderr.trim() || `test exited ${readable.code}`}`);
    }
    const prefix = await sudoFor(ctx, path, { force: true });
    const [head, ...rest] = [...prefix, "test", "-r", path];
    const elevated = await ctx.transport.exec(head, rest, { allowFailure: true });
    if (elevated.code !== 0) throw new Error(`cannot read ${path}, even with elevated access`);
    const [dirHead, ...dirRest] = [...prefix, "test", "-d", path];
    const isDirectory = await ctx.transport.exec(dirHead, dirRest, { allowFailure: true });
    if (isDirectory.code !== 0 && isDirectory.code !== 1) throw new Error(`could not determine whether ${path} is a directory`);
    if (isDirectory.code === 0) {
      const [xHead, ...xRest] = [...prefix, "test", "-x", path];
      const x = await ctx.transport.exec(xHead, xRest, { allowFailure: true });
      if (x.code !== 0) throw new Error(`cannot traverse ${path}, even with elevated access`);
    }
    return prefix;
  }
  return writePath === undefined ? [] : sudoFor(ctx, writePath);
}

/** Lists an archive's entries. Read in full on purpose: the shell version piped tar into
 *  `head`, which killed tar with SIGPIPE and — under `set -o pipefail` — turned a healthy
 *  archive into a failure. */
export async function listArchive(ctx: Context, archive: string): Promise<string[]> {
  const prefix = await privilegePrefixFor(ctx, [archive]);
  const [head, ...rest] = [...prefix, "tar", "-tzf", archive];
  const result = await ctx.transport.exec(head, rest);
  return result.stdout.split("\n").filter((line) => line !== "");
}

// Five fixed-width columns precede the path in `tar -tv` output: mode, owner/group, size,
// date, time. The path itself is free-form and may contain spaces, so it is never reached
// by splitting the line on whitespace — only these five columns are, and everything after
// them is taken whole. The first character of the mode column is the type flag: "l" for a
// symlink, "h" for a hard link (GNU tar's own convention, not a POSIX file type).
const LISTING_ROW = /^(\S)\S*\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/;

/** Decodes one GNU tar C-quoted field, returning the unconsumed suffix. */
function readTarListingField(value: string, separator = " -> "): { readonly field: string; readonly rest: string } | undefined {
  if (!value.startsWith('"')) {
    const end = value.indexOf(separator);
    return end === -1 ? undefined : { field: value.slice(0, end), rest: value.slice(end) };
  }

  const bytes: number[] = [];
  const append = (text: string): void => {
    bytes.push(...Buffer.from(text));
  };
  for (let index = 1; index < value.length; index++) {
    const char = value[index];
    if (char === '"') return { field: Buffer.from(bytes).toString("utf8"), rest: value.slice(index + 1) };
    if (char !== "\\") {
      append(char);
      continue;
    }

    const escaped = value[++index];
    if (escaped === undefined) return undefined;
    const simpleEscapes: Record<string, string> = {
      a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\x0b", "\\": "\\", '"': '"',
    };
    if (escaped in simpleEscapes) {
      append(simpleEscapes[escaped]);
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      for (let count = 0; count < 2 && /[0-7]/.test(value[index + 1] ?? ""); count++) octal += value[++index];
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    if (escaped === "x" && /[\da-f]/i.test(value[index + 1] ?? "")) {
      let hex = "";
      for (let count = 0; count < 2 && /[\da-f]/i.test(value[index + 1] ?? ""); count++) hex += value[++index];
      bytes.push(Number.parseInt(hex, 16));
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** Splits GNU tar's link description while respecting quoted member names. */
function parseTarLinkDescription(value: string, marker: " -> " | " link to "): { name: string; target: string } | undefined {
  const parsedName = readTarListingField(value, marker);
  if (parsedName === undefined || !parsedName.rest.startsWith(marker)) return undefined;
  const targetText = parsedName.rest.slice(marker.length);
  if (!targetText.startsWith('"')) return { name: parsedName.field, target: targetText };
  const parsedTarget = readTarListingField(targetText);
  return parsedTarget !== undefined && parsedTarget.rest === ""
    ? { name: parsedName.field, target: parsedTarget.field }
    : undefined;
}

/** Symlinks and hard links in the archive. Read from tar's verbose listing, which is the
 *  only place a link's target appears — `-tzf` alone lists names only. */
export async function listArchiveLinks(ctx: Context, archive: string): Promise<Map<string, ArchiveLink>> {
  const prefix = await privilegePrefixFor(ctx, [archive]);
  const [head, ...rest] = [...prefix, "tar", "--quoting-style=c", "-tvzf", archive];
  const result = await ctx.transport.exec(head, rest);

  const links = new Map<string, ArchiveLink>();
  for (const line of result.stdout.split("\n")) {
    const row = LISTING_ROW.exec(line);
    if (row === null) continue;
    const [, typeChar, path] = row;

    if (typeChar === "l") {
      const parsed = parseTarLinkDescription(path, " -> ");
      if (parsed === undefined) throw new Error("could not parse a symlink from tar's verbose listing");
      links.set(parsed.name, { kind: "symlink", target: parsed.target });
    } else if (typeChar === "h") {
      // "data/orig link to data/a hardlink" — GNU tar names the *later* occurrence of a
      // hard-linked file this way; the target is another archive member, not a filesystem
      // path relative to anything.
      const parsed = parseTarLinkDescription(path, " link to ");
      if (parsed === undefined) throw new Error("could not parse a hard link from tar's verbose listing");
      links.set(parsed.name, { kind: "hardlink", target: parsed.target });
    }
  }
  return links;
}

/** The data directory is a symlink, and where it resolves — undefined when it is not one.
 *  tar is invoked with the data directory's NAME relative to its parent, so a symlinked
 *  data root is archived as the link itself: one entry, none of the data behind it.
 *  createBackup() refuses that layout before stopping the gateway, createArchive() refuses
 *  again at archiving time; this is the check both run. Exit codes other than 0/1 are
 *  thrown, not read as "not a link" — a check that cannot answer must not wave it through. */
export async function symlinkedDataRoot(ctx: Context): Promise<string | undefined> {
  const { dataDir } = ctx.settings;
  const check = await ctx.transport.exec("test", ["-L", dataDir], { allowFailure: true });
  if (check.code === 1) return undefined;
  if (check.code !== 0) {
    throw new Error(`could not check whether the data directory is a symlink (exit ${check.code}): ${check.stderr.trim()}`);
  }
  const resolved = await ctx.transport.exec("readlink", ["-f", dataDir], { allowFailure: true });
  const target = resolved.stdout.trim();
  return resolved.code === 0 && target !== "" ? target : dataDir;
}

/** Creates the archive. The caller is responsible for stopping the gateway first. */
export async function createArchive(
  ctx: Context,
  options: { archive: string; profile: Profile },
): Promise<void> {
  const { dataDir } = ctx.settings;
  const linkTarget = await symlinkedDataRoot(ctx);
  if (linkTarget !== undefined) {
    throw new Error(
      `refusing to archive ${dataDir}: it is a symlink to ${linkTarget}, and tar would store the link itself — none of the data behind it`,
    );
  }
  // Taken before the policy read and before a full publish: this is the one point a
  // deployment folder pointed at already-existing target data (no restore, no full backup
  // yet) learns what the target alone still remembers. A history that exists but can't be
  // read refuses the backup loudly.
  await reconcilePrivatePathsHistory(ctx);
  // Must be inside the tree before tar runs, so a full backup carries it physically for the
  // next deployment directory to hand back. Full only — migrate/share reconcile with it
  // above but exclude the copy, since instance-local metadata doesn't travel with them.
  if (options.profile === "full") await publishPrivatePathsHistory(ctx);
  const name = dataDirName(dataDir);
  const parent = dataDirParent(dataDir);

  // Read from the recipes' own privatePaths declaration before the command is built: the
  // recipes live on this side, the archive on the target.
  const privatePaths = await installedRecipePrivatePaths();
  // The literal root and recipe paths are escaped in excludesFor; only base suffixes use globs.
  const excludeArgs = excludesFor(options.profile, name, privatePaths).map((pattern) => `--exclude=${pattern}`);
  const prefix = await privilegePrefixFor(ctx, [`${dataDir}/auth-secrets`, dataDir], options.archive);

  // --numeric-owner keeps uid/gid 1000 meaningful on a host with different user names.
  const [head, ...rest] = [
    ...prefix,
    "tar",
    "--numeric-owner",
    ...excludeArgs,
    "-czf",
    options.archive,
    "-C",
    parent,
    name,
  ];
  await ctx.transport.exec(head, rest);
}

export async function extractArchive(ctx: Context, archive: string, destination: string): Promise<void> {
  const prefix = await privilegePrefixFor(ctx, [archive], destination);
  const [head, ...rest] = [...prefix, "tar", "--numeric-owner", "-xzf", archive, "-C", destination];
  await ctx.transport.exec(head, rest);
}

export async function fileSize(ctx: Context, path: string): Promise<string> {
  const prefix = await sudoFor(ctx, path);
  const [head, ...rest] = [...prefix, "du", "-h", path];
  const result = await ctx.transport.exec(head, rest, { allowFailure: true });
  return result.stdout.split("\t")[0]?.trim() ?? "?";
}

/** Size in bytes and last-modified time of one file — undefined fields when `stat` fails
 *  rather than guessed at. Used by restore's --dry-run plan to describe the archive. */
export async function fileStat(ctx: Context, path: string): Promise<{ sizeBytes: number | undefined; modifiedAt: string | undefined }> {
  const prefix = await sudoFor(ctx, path);
  const [head, ...rest] = [...prefix, "stat", "-c", "%s %Y", path];
  const result = await ctx.transport.exec(head, rest, { allowFailure: true });
  const [sizeField, epochField] = result.stdout.trim().split(" ");
  const sizeBytes = Number(sizeField);
  const epochSeconds = Number(epochField);
  return {
    sizeBytes: result.code === 0 && Number.isFinite(sizeBytes) ? sizeBytes : undefined,
    modifiedAt: result.code === 0 && Number.isFinite(epochSeconds) ? new Date(epochSeconds * 1000).toISOString() : undefined,
  };
}
