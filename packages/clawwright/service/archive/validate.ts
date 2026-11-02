// Archive safety: is an archive's listing/link map safe to unpack, given the destination
// it would be extracted into? No tar invocation happens here — these functions only read
// the `tar -tzf`/`tar -tvzf` output pack.ts already produced.

/** The single top-level directory of an archive, e.g. "data". Also the first structural
 *  check: entries scattered across several roots are not something we produced. */
export function archiveRoot(entries: string[]): string {
  const roots = new Set(entries.map((entry) => entry.replace(/^\.\//, "").split("/")[0]));
  roots.delete("");
  if (roots.size !== 1) {
    throw new Error(`archive has ${roots.size} top-level entries, expected exactly one`);
  }
  return [...roots][0];
}

/** Whether an archive listing holds anything beneath its single root directory. A
 *  successful tar is not evidence of a backup: pointed at a data directory that is itself
 *  a symlink, tar stores one entry (the link) and exits 0. createBackup() checks the
 *  staging archive with this before publishing it. */
export function archiveCarriesContent(entries: string[]): boolean {
  let root: string;
  try {
    root = archiveRoot(entries);
  } catch {
    return false;
  }
  return entries.some((entry) => {
    const path = entry.replace(/^\.\//, "");
    return path !== root && path !== `${root}/`;
  });
}

export interface ArchiveProblem {
  readonly message: string;
  /** Unpacking would write outside the destination. Anything else is worth reporting but
   *  not worth refusing an otherwise valid archive. */
  readonly fatal: boolean;
  /** Non-fatal dangling symlink into the image; fatal is decided by writesThrough alone. */
  readonly expectedImageLink?: boolean;
}

/** OpenClaw's own layouts that legitimately symlink into the image — fixed shape only, never a bare prefix. */
const OPENCLAW_IMAGE_LINK_LOCATIONS: readonly RegExp[] = [
  /^config\/plugin-skills\/[^/]+$/, // .../<name> -> /app/dist/extensions/<ext>/skills/<name>
  /^config\/agents\/[^/]+\/agent\/codex-home\/tmp\/arg0\/[^/]+\/[^/]+$/, // .../<dir>/<tool> -> /app/node_modules/...
];

/** Target inside /app, and source (root-stripped) exactly one of the shapes above. */
function isOpenClawImageLink(root: string, source: string, target: string): boolean {
  if ((target !== "/app" && !target.startsWith("/app/")) || target.split("/").includes("..")) return false;
  if (source !== root && !source.startsWith(`${root}/`)) return false;
  const relative = source === root ? "" : source.slice(root.length + 1);
  return OPENCLAW_IMAGE_LINK_LOCATIONS.some((pattern) => pattern.test(relative));
}

/** What to name, and how many expected image links fold into one summary line instead. */
export function reportableProblems(problems: readonly ArchiveProblem[]): { toReport: ArchiveProblem[]; foldedImageLinks: number } {
  const folded = (problem: ArchiveProblem): boolean => !problem.fatal && problem.expectedImageLink === true;
  return {
    toReport: problems.filter((problem) => !folded(problem)),
    foldedImageLinks: problems.filter(folded).length,
  };
}

/** Whether a hard-link target, given root-relative, names something outside that root.
 *  Unlike a symlink there's no "dangling but harmless" case: extraction performs `link()`
 *  immediately, so an out-of-root target is read the moment the archive unpacks. */
function hardlinkEscapes(target: string, root: string): boolean {
  if (target.startsWith("/")) return true;
  if (target.split("/").includes("..")) return true;
  return target !== root && !target.startsWith(`${root}/`);
}

/** A link found in the archive listing. Kept separate from a plain string target because a
 *  symlink and a hard link resolve their target in different coordinate spaces (own
 *  directory vs. archive root) and carry different risk (dangling-but-harmless vs. read-on-extract). */
export interface ArchiveLink {
  readonly target: string;
  readonly kind: "symlink" | "hardlink";
}

type ChainResolution = { readonly kind: "resolved" } | { readonly kind: "escaped" } | { readonly kind: "cycle" };

/** One canonical spelling of an archive-relative path: repeated/internal "./" segments,
 *  doubled slashes and a trailing slash all name the same file and must key and compare as
 *  one — a link registered as "./data//a/" and a listing entry "data/a/file" otherwise
 *  disagree about whether content is written through the link. ".." is preserved; the
 *  degenerate spellings of the root normalize to "". */
function normalizeArchivePath(path: string): string {
  return path.split("/").filter((segment) => segment !== "" && segment !== ".").join("/");
}

/** Canonical member names after structural validation. Different spellings of one target
 * are ambiguous to tar and must not receive different profile-policy decisions. */
export function canonicalArchiveEntries(entries: readonly string[]): string[] {
  const canonical = entries.map(normalizeArchivePath);
  const seen = new Set<string>();
  for (const entry of canonical) {
    if (seen.has(entry)) throw new Error(`archive contains duplicate canonical entry: ${entry}`);
    seen.add(entry);
  }
  return canonical;
}

/** Resolves an archive-relative path segment by segment through every link in it.
 *  `resolved` holds only already-proven link-free segments, so a `..` popping from it is
 *  genuinely lexical. Substituting a link splices its target in front of the remainder, so
 *  an intermediate target segment that is itself a link is resolved BEFORE a following `..`
 *  consumes it — this is what makes `b/../safe` mean what the kernel means, not the
 *  lexically-simplified `safe` (unresolved, a link `b -> ../../outside` would be popped off
 *  unread, and a chain written through it would read as safely inside the root). A link key
 *  visited twice is a cycle. */
function resolveLinkChain(segments: readonly string[], links: ReadonlyMap<string, ArchiveLink>, root: string): ChainResolution {
  const resolved: string[] = [];
  const pending = [...segments];
  const seen = new Set<string>();

  for (let substitutions = 0; pending.length > 0; ) {
    const segment = pending.shift()!;
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      resolved.pop();
      if (resolved.length < 1) return { kind: "escaped" };
      continue;
    }
    const key = [...resolved, segment].join("/");
    const link = links.get(key);
    if (link === undefined) {
      resolved.push(segment);
      continue;
    }
    if (seen.has(key)) return { kind: "cycle" };
    seen.add(key);
    if (++substitutions > links.size) return { kind: "cycle" };
    if (link.kind === "hardlink") {
      // Root-relative, the same coordinate space as every archive member: a hard link that
      // fails this literal check is refused before its target is walked.
      if (hardlinkEscapes(link.target, root)) return { kind: "escaped" };
    } else if (link.target.startsWith("/")) {
      return { kind: "escaped" };
    }
    pending.unshift(...link.target.split("/"));
  }
  return { kind: "resolved" };
}

/** Finds what an unpack of this archive could do outside the directory it is aimed at. tar
 *  happily restores an absolute path, one climbing out through .., a symlink pointing
 *  anywhere, or a hard link to anything already on the filesystem. The first two write
 *  outside on their own and are refused. A symlink pointing outside is only dangerous when
 *  the archive also writes *through* it — a plugin's node_modules/openclaw -> /app is an
 *  ordinary artefact of installing inside the image. A hard link is refused outright:
 *  `link()` aliases the target the moment extraction runs, no dangling case to be lenient about. */
export function inspectArchive(entries: string[], links: Map<string, ArchiveLink>): ArchiveProblem[] {
  const problems: ArchiveProblem[] = [];

  let root: string;
  try {
    root = archiveRoot(entries);
  } catch (error) {
    return [{ message: (error as Error).message, fatal: true }];
  }

  const paths = entries.map((entry) => entry.replace(/^\.\//, ""));
  for (const path of paths) {
    if (path.startsWith("/")) {
      problems.push({ message: `absolute path: ${path}`, fatal: true });
    } else if (path.split("/").includes("..")) {
      problems.push({ message: `path escaping its root: ${path}`, fatal: true });
    } else if (path !== root && !path.startsWith(`${root}/`)) {
      problems.push({ message: `entry outside ${root}/: ${path}`, fatal: true });
    }
  }

  const canonicalNames = paths.map(normalizeArchivePath);
  const seenNames = new Set<string>();
  for (const name of canonicalNames) {
    if (seenNames.has(name)) problems.push({ message: `duplicate canonical archive entry: ${name}`, fatal: true });
    seenNames.add(name);
  }

  // Full canonicalization, where `paths` above deliberately keeps its raw spelling: the
  // structural checks must still see a leading "/" and every real ".." segment. One name
  // must key one map entry — GNU tar's "./" prefix on every entry, or another producer's
  // internal "./", doubled slash or trailing slash, could otherwise make resolveLinkChain's
  // lookups and the writesThrough match below disagree about whether content is written
  // through a link, in the direction that reads a real escaping symlink as safe. A key
  // canonicalizing to "" is the root itself, handled separately below by name.
  const normalizedLinks = new Map(
    [...links]
      .map(([rawSource, link]) => [normalizeArchivePath(rawSource), link] as const)
      .filter(([source]) => source !== ""),
  );

  const normalizedPaths = paths.map(normalizeArchivePath);

  for (const [source, link] of normalizedLinks) {
    // The root is what every later restore step is relative to (fresh-identity deletion,
    // standard subdirectories, ownership/permission pass) — an archive shipping it as a
    // link would put a symlink where a directory belongs. No archive this tooling produces has one.
    if (source === root) {
      problems.push({
        message: `the archive root is a ${link.kind}, not an ordinary directory: ${source} -> ${link.target}`,
        fatal: true,
      });
      continue;
    }

    if (link.kind === "hardlink") {
      if (hardlinkEscapes(link.target, root)) {
        problems.push({ message: `hard link points outside the archive: ${source} -> ${link.target}`, fatal: true });
        continue;
      }
      // The target names another archive member, which can itself be a link whose own
      // chain leaves the root — link() aliases whatever it ultimately names, so this is
      // refused just as unconditionally as a literal out-of-root target.
      const resolution = resolveLinkChain(link.target.split("/"), normalizedLinks, root);
      if (resolution.kind !== "resolved") {
        problems.push({ message: `hard link points outside the archive: ${source} -> ${link.target}`, fatal: true });
      }
      continue;
    }

    // Walk the symlink's own chain, not just its first hop: `data/a -> b` alone never
    // leaves the root, but if `data/b` is itself an escaping link, content under `data/a` is too.
    const resolution = resolveLinkChain(source.split("/"), normalizedLinks, root);
    if (resolution.kind === "resolved") continue;
    const writesThrough = normalizedPaths.some((path) => path.startsWith(`${source}/`));
    problems.push({
      message: writesThrough
        ? `content is written through a link that leaves the archive: ${source} -> ${link.target}`
        : `link points outside the archive: ${source} -> ${link.target}`,
      fatal: writesThrough,
      // Only softens reporting of an already-non-fatal finding, never the refusal itself.
      expectedImageLink: !writesThrough && isOpenClawImageLink(root, source, link.target),
    });
  }

  return problems;
}
