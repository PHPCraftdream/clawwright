// Shell quoting and the remote-side shell scripts every non-local transport needs: private
// and publish staging writes, the `env` prefix that carries variables across the wsl.exe/ssh
// boundary, and the existence probe that tells a genuinely missing path apart from one a
// broken check merely failed to answer. Split out of transport.ts to keep that file a thin
// facade over the per-transport implementations.

import { randomBytes } from "node:crypto";
import { shellQuote } from "../../core/io/shell.ts";
import { UserError } from "../../core/io/log.ts";
import { command } from "../../core/io/invocation/advice.ts";
import type { ExecOptions, ExecResult, Transport } from "./exec.ts";

/** The two name markers of the tooling's own temp-sibling staging families: a private write
 *  stages `<path>.clawwright-private-<hex>`, a publish stages `<path>.clawwright-publish-<hex>`.
 *  A process that dies before the rename leaves them beside the target under a name no
 *  declared exact path matches, so the snapshot policy recognizes the marker families
 *  themselves (service/archive/profile.ts excludes them, verify.ts refuses them). Defined
 *  here, where the names are created, so the policy readers cannot drift from the writers. */
export const PRIVATE_STAGING_MARKER = ".clawwright-private-";
export const PUBLISH_STAGING_MARKER = ".clawwright-publish-";

/** Builds an exclusive, owner-only remote write with cleanup owned by the writer. */
export function privateWriteCommand(path: string): [string, string[]] {
  const temporary = `${path}${PRIVATE_STAGING_MARKER}${randomBytes(8).toString("hex")}`;
  const target = shellQuote(path);
  const staging = shellQuote(temporary);
  const script =
    `umask 077; set -C; temporary=${staging}; ` +
    `if : > "$temporary" 2>/dev/null; then ` +
    `trap 'rm -f -- "$temporary"' EXIT; ` +
    `cat >> "$temporary" && ln -T -- "$temporary" ${target}; status=$?; ` +
    `trap - EXIT; rm -f -- "$temporary"; exit $status; ` +
    `else exit 1; fi`;
  return ["sh", ["-c", script]];
}

/** Builds a publish command for a POSIX target: content lands in a temp sibling that is
 *  renamed over the wanted name. rename(2) swaps the directory entry, so an existing symlink
 *  at the target is replaced rather than written through, and a reader sees either the old
 *  or the new content — never a partial file. */
export function publishCommand(path: string): [string, string[]] {
  const temporary = `${path}${PUBLISH_STAGING_MARKER}${randomBytes(8).toString("hex")}`;
  const script =
    "temporary=$1; target=$2; " +
    "trap 'rm -f -- \"$temporary\"' EXIT; " +
    "cat > \"$temporary\" && mv -f -- \"$temporary\" \"$target\"; status=$?; exit $status";
  return ["sh", ["-c", script, "sh", temporary, path]];
}

/** Builds the target-side `env` wrapper without retaining values that are being cleared.
 *  Setting variables on the local `wsl.exe`/`ssh` process doesn't put them in the target's
 *  process (WSL passes only what WSLENV names, ssh only what AcceptEnv allows), so they are
 *  prepended to the remote command with `env` instead. */
export function withEnvPrefix(
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  unsetEnv: string[] | undefined,
): [string, string[]] {
  const entries = Object.entries(env ?? {});
  const removals = unsetEnv ?? [];
  const removed = new Set(removals);
  const assignments = entries.filter(([key]) => !removed.has(key));
  if (assignments.length === 0 && removals.length === 0) return [command, args];
  return ["env", [...removals.flatMap((name) => ["-u", name]), ...assignments.map(([key, value]) => `${key}=${value}`), command, ...args]];
}

/** Answers the existence question on the target: `exists`, `absent`, `blocked <dir>`, or
 *  `loop <path>` — only the second means the path is not there. `test -e` alone can't make
 *  that distinction (exit 1, no output, for both a missing path and one this user can't
 *  stat), so a negative answer is re-derived by walking the path from the root, confirming
 *  each parent is searchable before the next component — every stat failure then means ENOENT.
 *
 *  A symlink is resolved and its target walked the same way: a config file under a directory
 *  this user can't enter is not a missing config, and answering that it is deletes live
 *  credentials one caller later. `readlink`, not `readlink -f`, so a broken chain names the
 *  actual failing link. Fed to `sh -s` on stdin, since wsl.exe re-parses the command line and
 *  a multi-line argument wouldn't survive. */
export const PRESENCE_PROBE = `
p=$1
entry=\${2:-follow}
if [ "$entry" != entry ] && [ -e "$p" ]; then echo exists; exit 0; fi
case $p in
  /*) rest=$p ;;
  *) rest=\${PWD%/}/$p ;;
esac
cur=
hops=0
while :; do
  while [ "\${rest#/}" != "$rest" ]; do rest=\${rest#/}; done
  [ -z "$rest" ] && break
  comp=\${rest%%/*}
  if [ "$comp" = "$rest" ]; then rest=; else rest=\${rest#*/}; fi
  [ "$comp" = "." ] && continue
  parent=\${cur:-/}
  if [ ! -d "$parent" ]; then echo absent; exit 0; fi
  if [ ! -x "$parent" ]; then echo "blocked $parent"; exit 0; fi
  if [ "$comp" = ".." ]; then cur=\${cur%/*}; continue; fi
  cur=$cur/$comp
  # -h is an lstat: it sees the link itself, so it answers even when the target does not.
  if [ -h "$cur" ]; then
    # Preserve only the final entry, after its parent was checked; parents still resolve.
    if [ "$entry" = entry ] && [ -z "$rest" ]; then echo exists; exit 0; fi
    hops=$((hops + 1))
    if [ "$hops" -gt 40 ]; then echo "loop $cur"; exit 0; fi
    target=$(readlink "$cur") || { echo "unreadable $cur"; exit 0; }
    case $target in
      /*) cur=; rest=$target/$rest ;;
      *) cur=\${cur%/*}; rest=$target/$rest ;;
    esac
    continue
  fi
  if [ ! -e "$cur" ]; then echo absent; exit 0; fi
  if [ "$entry" = entry ] && [ -z "$rest" ]; then echo exists; exit 0; fi
done
# Every component is there while the path as written is not: a trailing slash on a file, or
# something created since the first check. Either way the answer above stands.
echo absent
`;

/** Present, absent, or "the check itself could not run" — the third must never be answered
 *  as the second. `result.code === 0` alone would read ssh exiting 255 or a failed wsl.exe
 *  distro start as "not there"; exit 1 with empty stderr is the same trap. Callers act on the
 *  answer (`secrets --apply` deletes keys, `restore` unpacks with sudo), so anything short of
 *  a definite "not there" throws. */
export async function existsVia(
  exec: (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>,
  path: string,
  finalLeaf: "follow" | "entry" = "follow",
): Promise<boolean> {
  // `sh -s -- <path>`: the script arrives on stdin and the path is its $1, so neither is ever
  // part of a command line — a space or a quote in the path is data, never syntax.
  const result = await exec("sh", ["-s", "--", path, ...(finalLeaf === "entry" ? ["entry"] : [])], { allowFailure: true, input: PRESENCE_PROBE });
  const verdict = result.stdout.trim().split("\n").at(-1)?.trim() ?? "";

  if (result.code === 0) {
    if (verdict === "exists") return true;
    if (verdict === "absent") return false;
    if (verdict.startsWith("blocked ")) {
      throw new Error(cannotSearchMessage(path, verdict.slice("blocked ".length)));
    }
    if (verdict.startsWith("loop ")) {
      throw new Error(`${cannotCheckMessage(path)}: ${verdict.slice("loop ".length)} ${SYMLINK_LOOP}`);
    }
    if (verdict.startsWith("unreadable ")) {
      throw new Error(
        `${cannotCheckMessage(path)}: ${verdict.slice("unreadable ".length)} is a symlink whose target could not be read`,
      );
    }
  }

  const detail = result.stderr.trim() === "" ? verdict : result.stderr.trim();
  throw new Error(`${cannotCheckMessage(path)} (exit ${result.code})${detail === "" ? "" : `: ${detail}`}`);
}


// The target-read contract (S3.4), beside the probe it is built on: reading and enumerating
// on the target distinguish THREE answers — present (a value), absent (the target answered:
// no such file/dir), unknown (the target could not answer: unreachable, unreadable, timeout).
// "unknown" is never read as "absent/empty" here: it throws, and the error carries Advice (a
// next step the operator can actually run), so every surface renders the same remedy. Callers
// use these helpers instead of ad-hoc try/catch around transport.readFile/exists/listFiles.


/** Present with a value, or a definite "the target answered: not there". */
export type TargetRead<T> =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly value: T };

/** A target that could not answer, thrown — never returned as a default. A UserError that
 *  already carries advice (TransportUnreachableError, LocalTargetUnsupportedError) travels
 *  as-is; anything else is wrapped so the remedy rides along. */
export class TargetReadUnknownError extends UserError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, {
      ...(options?.cause === undefined ? {} : { cause: options.cause }),
      advice: [command("status", { note: "reports whether the target answers at all" })],
    });
    this.name = "TargetReadUnknownError";
  }
}

function unknownAnswer(message: string, error: unknown): unknown {
  // The contract's Advice guarantee: an unknown answer ALWAYS carries a next step — also
  // when a UserError arrives that was built without one (TransportUnreachableError's
  // nextAction is optional).
  if (error instanceof UserError && error.advice.length > 0) return error;
  return new TargetReadUnknownError(`${message}: ${(error as Error).message}`, { cause: error });
}

/** exists(), with the unknown answer thrown instead of guessed: a transport that cannot
 *  stat never reads as "not there". */
export async function probeExists(transport: Transport, path: string): Promise<boolean> {
  try {
    return await transport.exists(path);
  } catch (error) {
    throw unknownAnswer(`could not check whether ${path} exists on the target`, error);
  }
}

/** Directory-entry presence: dangling final symlinks are present, checked parents still
 * resolve normally. Never fall back to follow-target exists() or bare test exit status. */
export async function probeEntryExists(transport: Transport, path: string): Promise<boolean> {
  try {
    return transport.existsEntry !== undefined
      ? await transport.existsEntry(path)
      : await existsVia((command, args, options) => transport.exec(command, args, options), path, "entry");
  } catch (error) {
    throw unknownAnswer(`could not check whether entry ${path} exists on the target`, error);
  }
}

/** Reads a target file, distinguishing absent from unknown. An exists()-probe first (it, not
 *  `cat`'s exit status, distinguishes a missing path from an unreadable one), then the read;
 *  a read that still fails is unknown and throws. */
export async function readIfExists(transport: Transport, path: string): Promise<TargetRead<string>> {
  if (!(await probeExists(transport, path))) return { kind: "absent" };
  try {
    return { kind: "present", value: await transport.readFile(path) };
  } catch (error) {
    throw unknownAnswer(`could not read ${path} on the target`, error);
  }
}

/** Lists a target directory, all three outcomes: a non-empty listing is present; an empty one
 *  is told apart by the probe (transports answer [] for a missing directory, so the listing
 *  alone cannot tell it from an empty directory): not there is absent, there is present and
 *  empty; a target that cannot answer throws. */
export async function listIfExists(transport: Transport, dir: string): Promise<TargetRead<string[]>> {
  let listed: string[];
  try {
    listed = await transport.listFiles(dir);
  } catch (error) {
    throw unknownAnswer(`could not list ${dir} on the target`, error);
  }
  if (listed.length > 0) return { kind: "present", value: listed };
  return (await probeExists(transport, dir)) ? { kind: "present", value: listed } : { kind: "absent" };
}

/** The third answer the probe must never be read as "absent": the check itself could not run. */
export function cannotCheckMessage(path: string): string {
  return `could not check whether ${path} exists`;
}

/** The probe walked into a directory it may not enter: named, so the refusal says which
 *  directory blocked the walk. */
export function cannotSearchMessage(path: string, dir: string): string {
  return `${cannotCheckMessage(path)}: ${dir} cannot be searched by the target user`;
}

export const SYMLINK_LOOP = "is a symlink loop";
