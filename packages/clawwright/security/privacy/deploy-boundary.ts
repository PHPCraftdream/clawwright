// The privacy/destructive-write boundary for the `deploy` command. Lives in security/privacy/
// beside the other privacy-boundary modules (private-config.ts, recipe-portable-content.ts,
// private-paths-ledger.ts) it is conceptually closest to.

import { readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { posix, resolve, win32 } from "node:path";
import { die } from "../../core/io/log.ts";
import { shellQuote } from "../../core/io/shell.ts";
import { SENSITIVE_RECIPE_NAME } from "./recipe-portable-content.ts";

const execFileAsync = promisify(execFile);

/** Local tool/state directories are absent from every rsync payload. */
const LOCAL_DIRECTORIES = [
  ".claude",
  ".idea",
  ".vscode",
  "node_modules",
  "worktrees",
] as const;

const GENERATED_ROOTS = ["dist", "build", "coverage", ".cache", ".tmp", "scratch"] as const;
const GENERATED_FRAMEWORK_PATHS = ["/packages/clawwright/dist/", "/packages/clawwright/build/"] as const;

/** Filters shared by the framework and deployment payload mirrors. */
export const EXCLUDES = [
  ".env",
  ".mcp.json",
  // A linked worktree has a .git file, while a regular checkout has a directory.
  ".git",
  ...LOCAL_DIRECTORIES.map((name) => `${name}/`),
  "backups/",
  "data/",
  "snapshots/",
  "secrets/",
  "*.tar.gz",
  "*.tar.zst",
  "*.swp",
  ".DS_Store",
  "Thumbs.db",
  "*.token",
];

/** Generated checkout output and other deployments are absent from the framework mirror. */
export const FRAMEWORK_EXCLUDES = [
  ...EXCLUDES,
  "/apps/",
  ...GENERATED_ROOTS.map((name) => `/${name}/`),
  ...GENERATED_FRAMEWORK_PATHS,
  "*.tgz",
  "*.tsbuildinfo",
];

/** Records a remote directory as CREATED for a Clawwright deployment. `mkdir -p` proves a
 *  path can exist, never that it was made for this deployment or that nothing else owns
 *  it — so deploy writes this marker the first time it takes a root over and refuses any
 *  root carrying someone else's. */
export const MARKER_FILE = ".clawwright-deploy-marker";
export const MARKER_PREFIX = "clawwright-deploy-root-v1 name=";

/** Verifies that the root ownership marker survived the framework mirror byte-for-byte. */
export function markerVerifyScript(markerPath: string, line1: string, line2: string): string {
  return [
    "# clawwright-root-marker-verify",
    `printf '%s\\n' ${quoted(line1)} ${quoted(line2)} | cmp -s - ${quoted(markerPath)}`,
  ].join("\n");
}

/** Paths `git ls-files` reports for `root` — content already committed or staged, as opposed
 *  to whatever sits unreviewed in the working tree. `undefined` when `root` is not a git
 *  checkout or git is missing: callers must then treat nothing as vetted. Never throws. */
async function gitTrackedFiles(root: string): Promise<Set<string> | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "ls-files", "-z"], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return new Set(stdout.split("\0").filter((entry) => entry !== ""));
  } catch {
    return undefined;
  }
}

/** Tracked paths whose current bytes are not the ones git recorded. `git ls-files` proves a
 *  path was reviewed once, not that the bytes there now are the reviewed ones — locally
 *  edited or staged-but-uncommitted content is dirty. `undefined` under the same conditions
 *  as gitTrackedFiles, and every tracked path is then treated as dirty. Never throws. */
async function gitModifiedFiles(root: string): Promise<Set<string> | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=no"],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const modified = new Set<string>();
    for (const entry of stdout.split("\0")) {
      // porcelain v1 is `XY <path>`: two status columns, a space, then the path.
      if (entry.length < 4) continue;
      modified.add(entry.slice(3));
    }
    return modified;
  } catch {
    return undefined;
  }
}

/** Git's own blob content hash: `sha1("blob " + byteLength + "\0" + content)`, the same
 *  identity `git hash-object` computes. */
function gitBlobHash(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

/** Blob hashes of every COMMITTED file in `root`. Read from `git ls-tree -r HEAD` rather than
 *  `git ls-files -s`, since the index also carries staged-but-uncommitted blobs. `undefined`
 *  under the same conditions as gitTrackedFiles, and also with no commits yet. */
async function gitTrackedBlobHashes(root: string): Promise<Set<string> | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "ls-tree", "-r", "HEAD"], {
      maxBuffer: 64 * 1024 * 1024,
    });
    const hashes = new Set<string>();
    for (const line of stdout.split("\n")) {
      if (line === "") continue;
      // `<mode> <type> <object>\t<path>` — the object hash is the third field.
      const hash = line.split(/\s+/)[2];
      if (hash !== undefined) hashes.add(hash);
    }
    return hashes;
  } catch {
    return undefined;
  }
}

/** Walks the mirrored tree for private names not covered by fixed rsync excludes.
 *  A matched name is exempted only
 *  when byte-identical to reviewed content: a git-tracked file that is completely clean
 *  (path presence alone is not byte identity), or content matching a tracked blob's hash
 *  (covers reviewed content copies). Directories are never exempted. Excluded local
 *  directories are skipped; symlinks are reported but never followed. */
export async function collectSensitiveCheckoutNames(root: string): Promise<{ path: string; reason: string }[]> {
  const found: { path: string; reason: string }[] = [];
  const tracked = await gitTrackedFiles(root);
  // "Was this path reviewed" (tracked) isn't enough; this answers "are the bytes here now
  // the reviewed ones" — undefined means every tracked path is treated as dirty.
  const modified = await gitModifiedFiles(root);
  // Computed lazily, only the first time a name-matched file isn't itself tracked by path.
  let trackedHashes: Set<string> | undefined | "pending" = "pending";

  async function readEntries(dir: string) {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async function isVettedContentCopy(path: string): Promise<boolean> {
    if (trackedHashes === "pending") trackedHashes = await gitTrackedBlobHashes(root);
    if (trackedHashes === undefined) return false;
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch {
      return false;
    }
    return trackedHashes.has(gitBlobHash(content));
  }

  async function walk(current: string, base: string): Promise<void> {
    const entries = await readEntries(current);
    for (const entry of entries) {
      if (entry.isDirectory() && (
        LOCAL_DIRECTORIES.some((name) => name === entry.name)
        || entry.name === ".git"
        || (base === "" && (entry.name === "apps" || GENERATED_ROOTS.some((name) => name === entry.name)))
        || (base === "packages/clawwright" && (entry.name === "dist" || entry.name === "build"))
      )) continue;
      const relativePath = base === "" ? entry.name : `${base}/${entry.name}`;
      if (SENSITIVE_RECIPE_NAME.test(relativePath)) {
        const trackedHere = tracked?.has(relativePath) === true;
        // Tracked is vetted only when git also reports it completely clean; the
        // byte-identical-copy clause beside it covers untracked twins.
        const vetted = (trackedHere && modified?.has(relativePath) === false)
          || (!entry.isSymbolicLink() && !entry.isDirectory() && (await isVettedContentCopy(resolve(current, entry.name))));
        if (!vetted) {
          found.push({
            path: relativePath,
            reason: trackedHere
              ? "sensitive-name policy (tracked bytes differ from the committed version)"
              : "sensitive-name policy",
          });
          continue;
        }
      }
      if (!entry.isSymbolicLink() && entry.isDirectory()) {
        await walk(resolve(current, entry.name), relativePath);
      }
    }
  }

  await walk(root, "");
  return found;
}

/** Quotes a value for the remote shell: ssh joins its arguments into one command line, so
 *  a path with a space would otherwise arrive as two. Exported for deploy.ts's own
 *  runRemote(), which needs identical quoting. */
export function quoted(value: string): string {
  return shellQuote(value);
}

/** Creates one directory at a time, refusing links before any remote write. */
export function directoryPrepareScript(path: string, sudo: boolean): string {
  return [
    sudo ? "# clawwright-root-prepare" : "# clawwright-child-prepare",
    `p=${quoted(path)}`,
    "rest=${p#/}",
    "current=/",
    "cd -P / || exit 1",
    'while [ -n "$rest" ]; do',
    '  segment=${rest%%/*}',
    '  if [ "$segment" = "$rest" ]; then rest=; else rest=${rest#*/}; fi',
    '  [ -n "$segment" ] && [ "$segment" != . ] && [ "$segment" != .. ] || exit 1',
    '  if [ "$current" = / ]; then next="/$segment"; else next="$current/$segment"; fi',
    '  [ ! -L "$segment" ] || exit 1',
    '  if [ -e "$segment" ]; then',
    '    [ -d "$segment" ] || exit 1',
    '  else',
    sudo
      ? '    mkdir -- "$segment" 2>/dev/null || { sudo -n mkdir -- "$segment" && sudo -n chown -h -- "$(id -u):$(id -g)" "$segment"; } || exit 1'
      : '    mkdir -- "$segment" || exit 1',
    '  fi',
    '  [ ! -L "$segment" ] || exit 1',
    '  cd -P -- "$segment" || exit 1',
    '  [ "$(pwd -P)" = "$next" ] || exit 1',
    '  current=$next',
    'done',
  ].join("\n");
}

/** Checks every existing component immediately before a remote receiver starts. */
export function directoryGuardScript(path: string): string {
  return [
    "# clawwright-destination-guard",
    `p=${quoted(path)}`,
    "rest=${p#/}",
    "current=/",
    "cd -P / || exit 1",
    'while [ -n "$rest" ]; do',
    '  segment=${rest%%/*}',
    '  if [ "$segment" = "$rest" ]; then rest=; else rest=${rest#*/}; fi',
    '  [ -n "$segment" ] && [ "$segment" != . ] && [ "$segment" != .. ] || exit 1',
    '  if [ "$current" = / ]; then next="/$segment"; else next="$current/$segment"; fi',
    '  [ ! -L "$segment" ] && [ -d "$segment" ] || exit 1',
    '  cd -P -- "$segment" || exit 1',
    '  [ "$(pwd -P)" = "$next" ] || exit 1',
    '  current=$next',
    'done',
  ].join("\n");
}

/** Pins an rsync receiver to its verified directory inode, then uses `.` as destination. */
export function guardedRsyncPath(root: string, destination: string): string {
  if (
    !destination.startsWith(`${root}/`) && destination !== root ||
    posix.normalize(destination) !== destination ||
    posix.normalize(root) !== root
  ) {
    die(`deploy destination is outside its root: ${destination}`);
  }
  const script = [
    'const fs = require("node:fs");',
    'const { spawnSync } = require("node:child_process");',
    `const root = ${JSON.stringify(root)};`,
    `const destination = ${JSON.stringify(destination)};`,
    'const fail = () => { process.stderr.write("unsafe deploy destination\\n"); process.exit(1); };',
    'let current = "";',
    'for (const segment of destination.slice(1).split("/")) {',
    '  current += `/${segment}`;',
    '  let stat;',
    '  try { stat = fs.lstatSync(current); } catch { fail(); }',
    '  if (!stat.isDirectory() || stat.isSymbolicLink()) fail();',
    '  if (fs.realpathSync(current) !== current) fail();',
    '}',
    'if (destination !== root && !destination.startsWith(`${root}/`)) fail();',
    'try { process.chdir(destination); } catch { fail(); }',
    'if (process.cwd() !== destination) fail();',
    'const args = process.argv.slice(1);',
    'if (args[0] !== "--server" || args.at(-1) !== `${destination}/`) fail();',
    'args[args.length - 1] = ".";',
    'const result = spawnSync("rsync", args, { stdio: "inherit" });',
    'process.exit(result.status ?? 1);',
  ].join("\n");
  return `node -e ${quoted(script)} --`;
}

/** The first question about the remote root, asked before anything is mirrored into it: does
 *  it exist; is every component a REAL directory (`cd` + `pwd -P` canonicalizes the whole
 *  path — a symlinked component would let --delete follow the link and erase whatever it
 *  points at); does it carry our marker; is it empty. One KEY=VALUE per line so a parse
 *  never mistakes the tree's own data for structure. Exported for root-boundary.check.ts. */
export function rootProbeScript(remotePath: string, markerPath: string): string {
  return [
    "# clawwright-root-probe",
    `p=${quoted(remotePath)}`,
    `m=${quoted(markerPath)}`,
    "say() { printf '%s\\n' \"$1\"; }",
    'if [ ! -d "$p" ]; then say "state=missing"; exit 0; fi',
    'c=$(cd -- "$p" 2>/dev/null && pwd -P) || { say "state=missing"; exit 0; }',
    'say "canonical=$c"',
    'if [ "$c" != "$p" ]; then say "state=canonical-mismatch"; exit 0; fi',
    'if [ -f "$m" ]; then say "marker=$(head -n 1 "$m")"; else say "marker=absent"; fi',
    'if [ -z "$(ls -A -- "$p" 2>/dev/null)" ]; then say "empty=yes"; else say "empty=no"; fi',
  ].join("\n");
}

/** Reads a rootProbeScript answer back. A value is the rest of its line — the marker's first
 *  line contains spaces by construction (`name=<deployment>`), so only the KEY is matched.
 *  Exported for root-boundary.check.ts. */
export function parseRootProbe(stdout: string): { state?: string; canonical?: string; marker?: string; empty?: string } {
  const probe: { state?: string; canonical?: string; marker?: string; empty?: string } = {};
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    for (const key of ["state", "canonical", "marker", "empty"] as const) {
      if (probe[key] === undefined && line.startsWith(`${key}=`)) {
        probe[key] = line.slice(key.length + 1);
      }
    }
  }
  return probe;
}

/** Creates the root marker exclusively inside the verified directory. */
export function markerWriteScript(markerPath: string, line1: string, line2: string): string {
  const script = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const root = path.resolve(${JSON.stringify(posix.dirname(markerPath))});`,
    `const marker = ${JSON.stringify(posix.basename(markerPath))};`,
    `const content = ${JSON.stringify(`${line1}\n${line2}\n`)};`,
    'if (fs.realpathSync(root) !== root) throw new Error("unsafe marker root");',
    'process.chdir(root);',
    'if (process.cwd() !== root) throw new Error("changed marker root");',
    'try { fs.lstatSync(marker); throw new Error("marker already exists"); }',
    'catch (error) { if (error.code !== "ENOENT") throw error; }',
    'const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;',
    'const fd = fs.openSync(marker, flags, 0o600);',
    'try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }',
  ].join("\n");
  return `# clawwright-root-marker-write\nnode -e ${quoted(script)} --`;
}

/** What an adopted root actually holds, listed BEFORE the destructive sync — taking over an
 *  existing tree must be explicit, with the affected inventory on screen. */
export function rootInventoryScript(remotePath: string): string {
  return [
    "# clawwright-root-inventory",
    `p=${quoted(remotePath)}`,
    "say() { printf '%s\\n' \"$1\"; }",
    'say "entries=$(find "$p" -mindepth 1 | wc -l)"',
    'find "$p" -mindepth 1 -maxdepth 2 | head -n 200',
  ].join("\n");
}

/** The remote root deploy may mirror into, validated locally before anything remote runs.
 *  Without these checks a typo could select a filesystem root or a data/backups tree,
 *  deleting unrelated content. Local half; the remote half is the marker protocol deploy()
 *  runs on the target before its first --delete. */
export function validatedRemoteRoot(requested: string): string {
  // Trailing slashes name the same directory and must not change the verdict, except "/"
  // itself: stripping it would leave nothing to name.
  const stripped = requested === "/" ? requested : requested.replace(/\/+$/, "");
  // A Windows path (drive letter or UNC root) is a path on THIS machine, never a verified
  // directory on the target host. win32.isAbsolute() alone accepts bare "/opt" too, so the
  // drive/UNC shape is what narrows it.
  const windowsShaped = /^([a-zA-Z]:|\\\\)/.test(stripped);
  if (
    stripped === "" ||
    !stripped.startsWith("/") ||
    stripped.startsWith("//") ||
    stripped.includes("\\") ||
    stripped.includes("\0") ||
    (win32.isAbsolute(stripped) && windowsShaped)
  ) {
    die(
      `--path must be an absolute POSIX path — ${JSON.stringify(requested)} is not.\n` +
        "Deploy mirrors this directory on the server with rsync --delete, so it needs a " +
        "real, fully specified path there: POSIX form (/opt/openclaw), not a relative " +
        "path, not a Windows drive or share path.",
    );
  }
  const normalized = posix.normalize(stripped);
  if (normalized !== stripped) {
    die(
      `--path ${stripped} is not normalized — write it as ${normalized}.\n` +
        "rsync deletes exactly the tree it is pointed at, so the directory named here must " +
        "be the directory that is meant: every component spelled out, no . or .. segments, " +
        "no doubled slashes.",
    );
  }
  if (normalized === "/") {
    die(
      "deploy cannot use the filesystem root (/) as --path: the framework sync mirrors " +
        "with --delete into it, which would erase everything on that host the mirror does " +
        "not carry. Point --path at a directory dedicated to this deployment, such as " +
        "/opt/openclaw.",
    );
  }
  const components = normalized.slice(1).split("/");
  if (components.length < 2) {
    die(
      `--path ${normalized} is shared machine ground: a single top-level directory on a ` +
        "server is shared with every other service and operator there, and a --delete " +
        "mirror into it decides the fate of content this deployment knows nothing about. " +
        "Deploy at least one level deeper — /opt/openclaw, /srv/openclaw — never a bare " +
        "top-level directory.",
    );
  }
  if (components.some((component) => component === "data" || component === "backups")) {
    die(
      `--path ${normalized} puts the deploy root inside data/ or backups/: those hold the ` +
        "deployment's own state — its snapshots and its stores — the things this command " +
        "exists to keep, and the first --delete would mirror over exactly them. The deploy " +
        "root must be a peer of data/ and backups/, never their parent or their child.",
    );
  }
  return normalized;
}
