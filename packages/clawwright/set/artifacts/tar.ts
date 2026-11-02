// The single owner of LOCAL tar invocations in tools/framework: the flags per operation,
// the forward-slash spelling for every argument tar itself decodes, the one retry that
// bsdtar's `--force-local` refusal answers, and the timeouts. Local tar callers under
// tools/framework must go through this module; tar over ctx.transport (service/archive,
// commands/lifecycle) runs on the target and is a different concern.

import { rm } from "node:fs/promises";
import type { ExecResult } from "#src/runtime/transport/transport.ts";
import { spawnLocal, tarFlagRejected, tarLocalFlags, tarLocalPath } from "#src/runtime/transport/transport.ts";

/** What executes the archiver; injectable so checks can answer instead of spawning. */
export type LocalTarRunner = typeof spawnLocal;

let localTarRunner: LocalTarRunner = spawnLocal;

/** Runs `body` with the archiver answered by `substitute` instead of executed. */
export async function withLocalTarRunner<T>(substitute: LocalTarRunner, body: () => Promise<T>): Promise<T> {
  const previous = localTarRunner;
  localTarRunner = substitute;
  try {
    return await body();
  } finally {
    localTarRunner = previous;
  }
}

/** One local tar run with the platform flags and the single flag-refusal retry. Never
 *  throws on a non-zero exit — the caller reports the result. GNU tar reads a drive letter
 *  in an absolute `-f` path as a remote host spec (`--force-local` stops that); stock bsdtar
 *  doesn't know the flag, so retry without it only for that refusal. When the retry ALSO
 *  fails, the FIRST attempt's result is reported (its stderr is the build's own reported
 *  cause, not remote-host noise); a successful retry is returned as-is. */
export async function runLocalTar(args: string[], options: { timeoutMs?: number; archivePath?: string } = {}): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? 600_000;
  const forceLocal = tarLocalFlags();
  const first = await localTarRunner("tar", [...forceLocal, ...args.map(tarLocalPath)], { allowFailure: true, timeoutMs });
  if (first.code !== 0 && forceLocal.length > 0 && tarFlagRejected(first)) {
    // Drop whatever the failed attempt left so the retry starts clean.
    if (options.archivePath !== undefined) await rm(options.archivePath, { force: true });
    const retry = await localTarRunner("tar", args.map(tarLocalPath), { allowFailure: true, timeoutMs });
    return retry.code === 0 ? retry : first;
  }
  return first;
}

// Every argument tar itself decodes goes forward-slash (tarLocalPath in runLocalTar): a
// backslashed -C value reads its escapes and every artifact is refused (rf6-fix33).

/** Pack a directory tree into a gzipped archive. */
export function tarCreateArchive(archive: string, fromDir: string, options: { timeoutMs?: number } = {}): Promise<ExecResult> {
  return runLocalTar(["-czf", archive, "-C", fromDir, "."], { ...options, archivePath: archive });
}

/** List a gzipped archive's entry names. */
export function tarListArchive(archive: string, options: { timeoutMs?: number } = {}): Promise<ExecResult> {
  return runLocalTar(["-tzf", archive], options);
}

/** List a gzipped archive's entries with metadata (permissions, links, dates). */
export function tarInspectArchive(archive: string, options: { timeoutMs?: number } = {}): Promise<ExecResult> {
  return runLocalTar(["-tvzf", archive], options);
}

/** Extract a gzipped archive into a destination directory; extra flags go before -xzf. */
export function tarExtractArchive(archive: string, destination: string, flags: readonly string[] = [], options: { timeoutMs?: number } = {}): Promise<ExecResult> {
  return runLocalTar([...flags, "-xzf", archive, "-C", destination], options);
}
