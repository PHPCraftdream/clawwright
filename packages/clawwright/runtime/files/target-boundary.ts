// Target-side containment for provisioning writes.
//
// A process inside the instance can leave symlinks in its own workspace before the
// operator provisions: a link named like a wanted file redirects the write OUTSIDE the
// data mount (writeFile follows the final symlink), or a link in the target's ancestry
// moves the whole write site — overwriting the victim with the operator's privileges.
//
// The contract, checked BEFORE any target mutation: every path must physically resolve
// inside the intended root. The deepest EXISTING ancestor is resolved through every
// symlink it crosses; landing outside the root refuses the write. A dangling final
// symlink passes the probe and is handled at publish time (writeFile renames a temp
// sibling over the name, replacing the link). Both halves are point-in-time checks — a
// hostile CONCURRENT writer would need no-follow syscalls this transport can't express.

import { realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { type ExecOptions, type ExecResult, type Transport } from "#src/runtime/transport/transport.ts";

/** Verifies on the target that every path — after resolving every symlink it crosses —
 *  stays inside root. Throws, naming the escape, otherwise.
 *
 *  A "local" transport's target shares this filesystem, so node:fs is the honest channel
 *  for it. Every other transport targets POSIX, where the probe script runs via exec. */
export async function assertTargetContained(transport: Transport, root: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  if (transport.description === "local") return verifyContainedLocally(paths, root);
  await containmentVia((command, args, options) => transport.exec(command, args, options), root, paths);
}

/** The node:fs half of assertTargetContained, exported for testing: the deepest existing
 *  ancestor of each path is canonicalized and must land inside the canonical root.
 *  A root that does not exist (yet) passes: nothing inside it can be a planted link either,
 *  and creating under an unusable root fails loudly on its own. */
export async function verifyContainedLocally(paths: readonly string[], root: string): Promise<void> {
  const base = resolve(root);
  let canon: string;
  try {
    canon = await realpath(base);
  } catch {
    return;
  }
  const inside = (candidate: string): boolean => candidate === canon || candidate.startsWith(canon + sep);
  for (const path of paths) {
    const full = resolve(path);
    if (full !== base && !full.startsWith(base + sep)) {
      throw new Error(`refusing to write: ${path} is not inside the target root ${root}`);
    }
    // Ascend to the deepest existing ancestor, then demand its resolved location stays
    // inside the root. ENOTDIR ascends too: a non-directory ancestor fails the write anyway.
    let probe = full;
    for (;;) {
      let real: string;
      try {
        real = await realpath(probe);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const parent = dirname(probe);
        if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === probe) {
          throw new Error(`refusing to write: ${probe} cannot be resolved to a real path`);
        }
        probe = parent;
        continue;
      }
      if (!inside(real)) {
        throw new Error(`refusing to write: ${path} resolves to ${real}, outside the target root ${root}`);
      }
      break;
    }
  }
}

/** Answers containment on a POSIX target with one shell invocation for the whole batch:
 *  the script arrives on stdin (`sh -s`), paths as arguments, so neither is re-parsed as
 *  command-line syntax (same reason as transport.ts's PRESENCE_PROBE). POSIX sh +
 *  coreutils only, so it runs on whatever WSL distribution or ssh host is configured. */
export async function containmentVia(
  exec: (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>,
  root: string,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) return;
  const result = await exec("sh", ["-s", "--", root, ...paths], { allowFailure: true, input: CONTAINMENT_PROBE });
  if (result.code === 0) return;
  const verdict = result.stdout.trim().split("\n").at(-1)?.trim() ?? "";
  const space = verdict.indexOf(" ");
  const kind = space === -1 ? verdict : verdict.slice(0, space);
  const detail = space === -1 ? "" : verdict.slice(space + 1);
  if (kind === "escape") throw new Error(`refusing to write: a target path resolves to ${detail}, outside the target root ${root}`);
  if (kind === "outside") throw new Error(`refusing to write: ${detail} is not inside the target root ${root}`);
  if (kind === "unresolved") throw new Error(`refusing to write: ${detail} cannot be resolved to a real path on the target`);
  throw new Error(`refusing to write: ${root} is not a usable target root (${detail})`);
}

// Each path must sit under the root as written, then its deepest existing ancestor is
// canonicalized and must land inside the canonical root. A dangling final link ascends to
// its parent, and is replaced no-follow at publish time.
const CONTAINMENT_PROBE = `
root=$1
shift
canon=$(realpath "$root" 2>/dev/null) || { [ -e "$root" ] || exit 0; printf 'badroot %s\\n' "$root"; exit 1; }
status=0
for p in "$@"; do
  case $p in
    "$root"|"$root"/*) ;;
    *) printf 'outside %s\\n' "$p"; status=1; continue ;;
  esac
  probe=$p
  while :; do
    { [ -e "$probe" ] || [ "$probe" = "$root" ]; } && break
    parent=$(dirname "$probe")
    [ "$parent" = "$probe" ] && break
    probe=$parent
  done
  real=$(realpath "$probe" 2>/dev/null) || { printf 'unresolved %s\\n' "$probe"; status=1; continue; }
  case $real in
    "$canon"|"$canon"/*) ;;
    *) printf 'escape %s\\n' "$real"; status=1 ;;
  esac
done
exit $status
`;
