// File tests that must answer as the identity that will use the file.
//
// uutils coreutils is the default /usr/bin/test on Ubuntu 25.10+. Its released -r/-w/-x (through
// 0.12) do not ask the kernel: they compare the file's mode bits with the caller's euid/egid. root owns nothing
// and shares no group with a 1000:1000 mode 700 directory, so `sudo -n test -r DIR` answers 1
// while the kernel would let root in. The shell's own `test` (dash: faccessat with
// AT_EACCESS) and GNU test give the kernel's answer, so these probes run through `sh`.
// The path is a positional parameter, never part of the script.

import type { Context } from "../../core/context.ts";
import type { ExecResult } from "../transport/transport.ts";

export const FILE_TEST_SCRIPTS = {
  "-d": 'test -d "$1"',
  "-r": 'test -r "$1"',
  "-x": 'test -x "$1"',
} as const;

export type FileTestFlag = keyof typeof FILE_TEST_SCRIPTS;

/** The argv for `test <flag> <path>` under `prefix`. Exit codes are test's own: 0 yes, 1 no. */
export function fileTestArgv(prefix: readonly string[], flag: FileTestFlag, path: string): string[] {
  return [...prefix, "sh", "-c", FILE_TEST_SCRIPTS[flag], "sh", path];
}

export function fileTest(ctx: Context, prefix: readonly string[], flag: FileTestFlag, path: string): Promise<ExecResult> {
  const [head, ...rest] = fileTestArgv(prefix, flag, path);
  return ctx.transport.exec(head, rest, { allowFailure: true });
}

const EXTERNAL_TEST_BINARY = 'for p in /usr/bin/test /bin/test; do if [ -x "$p" ]; then readlink -f "$p"; "$p" --version 2>&1 | head -n 1; break; fi; done';

function brief(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}...` : flat;
}

function rendered(result: ExecResult): string {
  const parts = [`exit ${result.code}`];
  if (brief(result.stdout) !== "") parts.push(`stdout ${JSON.stringify(brief(result.stdout))}`);
  if (brief(result.stderr) !== "") parts.push(`stderr ${JSON.stringify(brief(result.stderr))}`);
  return parts.join(", ");
}

async function observed(ctx: Context, argv: readonly string[]): Promise<string> {
  const [head, ...rest] = argv;
  return rendered(await ctx.transport.exec(head, rest, { allowFailure: true }));
}

/** The error for an elevated probe that did not say yes: `headline` plus what the elevated
 *  identity is, which `test` it ran, and what the external test and the file itself say. Only
 *  built on failure. Evidence never carries file content: ids, tool versions, owner and mode. */
export async function elevatedProbeFailure(
  ctx: Context,
  prefix: readonly string[],
  flag: FileTestFlag,
  path: string,
  probe: ExecResult,
  headline: string,
): Promise<Error> {
  let lines: string[];
  try {
    lines = [
      `probe: ${rendered(probe)}`,
      `uid: ${await observed(ctx, [...prefix, "id", "-u"])}`,
      `builtin: ${await observed(ctx, [...prefix, "sh", "-c", "command -v test"])}`,
      `binary: ${await observed(ctx, [...prefix, "sh", "-c", EXTERNAL_TEST_BINARY])}`,
      `external: ${await observed(ctx, [...prefix, "test", flag, path])}`,
      `target: ${await observed(ctx, [...prefix, "stat", "-c", "%u:%g %a %F", "--", path])}`,
    ];
  } catch (error) {
    throw new Error(`${headline} (probe ${rendered(probe)}; evidence unavailable: ${error instanceof Error ? error.message : String(error)})`);
  }
  return new Error([headline, ...lines.map((line) => `  ${line}`)].join("\n"));
}
