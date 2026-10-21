// `clawwright exec …` — runs an arbitrary command in the same sidecar `clawwright cli` uses:
// the OpenClaw image, the gateway's network namespace, the same data mounts — but any
// command, not just the app's own CLI entrypoint. For diagnostics `cli` cannot reach: reading
// a file bundled in the image, a curl probe against something only reachable from inside that
// network namespace (a recipe's sidecar port, for instance).

import { die, dieWithExitCode } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { isCaptured, emitRaw } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import type { ExecResult } from "#src/runtime/transport/transport.ts";
import { HelperNotRunning, requireBootstrapped } from "#src/runtime/runtime.ts";
import { commandBody, runOnContext } from "#src/core/command/index.ts";
import * as kinds from "#src/core/values/kinds.ts";
import type { LocalArtifact } from "#src/core/values/plan.ts";
import { CLI_HELPER_SERVICE } from "./cli-helper.ts";
import {
  capturedStdinRefusalMessage, execFailureHeadline, noFileTokenRefusalMessage, readPayloadFile,
  readStdinBounded, replaceFileTokens, stagePayload, ttyStdinRefusalMessage,
  type ExecPlan,
} from "./groups/exec-payload.ts";

export const EXEC_ARGUMENTS = [
  {
    name: "stdin",
    summary: "Read this process's stdin as command stdin",
    description:
      "--stdin reads this process's standard input to EOF (at most 8 MiB) and delivers it as the command's stdin inside the container. " +
      "Refused on a terminal (nothing to read) and in captured mode, where stdin carries the MCP protocol",
    kind: "flag",
  },
  {
    name: "file",
    summary: "Stage a local file for the command",
    description:
      "Stage this local file (a regular file, at most 8 MiB) into the data directory, pass its container path wherever the " +
      "argument list contains the exact token @file, and always remove the staged copy afterwards. " +
      "@file without --file is left untouched — it can be legitimate OpenClaw syntax",
    kind: "option",
    valueName: "path",
    value: kinds.localFile("a local file path"),
  },
  {
    name: "args",
    summary: "Command and arguments to run",
    description: "Command and arguments to run, e.g. [\"curl\", \"-fsS\", \"http://127.0.0.1:18789/healthz\"]",
    kind: "variadic",
    verbatim: true,
    required: true,
    value: kinds.text("command and arguments", { leadingDash: "allow", lines: "multi", example: "@file" }),
  },
] as const;

/** The command body; exec(ctx, args) stays for callers that already hold a Context. Same
 *  verbatim-tail rule as cli: the first token that is no flag of ours starts the command,
 *  and everything from there is literal. */
export const EXEC = commandBody({
  effect: "destroy",
  arguments: EXEC_ARGUMENTS,
  // Every refusal and payload read happens here, before the pipeline builds any context or
  // transport — same rules as cli's prepare (see it for the message provenance).
  async prepare(call): Promise<ExecPlan> {
    const v = call.values;
    const rawArgs = [...(v.args as readonly string[])];
    // localFile's resolve hands over the proven artifact, not the raw path string.
    const file = (v.file as LocalArtifact | undefined)?.path;
    if (v.stdin === true) {
      if (isCaptured()) {
        call.refuse("stdin", capturedStdinRefusalMessage);
      }
      if (process.stdin.isTTY) {
        call.refuse("stdin", ttyStdinRefusalMessage);
      }
    }
    let stdin: string | undefined;
    try {
      stdin = v.stdin === true ? await readStdinBounded() : undefined;
    } catch (error) {
      call.refuse("stdin", error instanceof Error ? error.message : String(error));
    }
    if (file !== undefined && !rawArgs.includes("@file")) {
      // Same no-guessing rule as cli's: only the exact @file token is ever replaced.
      call.refuse("file", noFileTokenRefusalMessage);
    }
    let payload: Buffer | undefined;
    if (file !== undefined) {
      try {
        payload = await readPayloadFile(file);
      } catch (error) {
        call.refuse("file", error instanceof Error ? error.message : String(error));
      }
    }
    return { args: rawArgs, stdin, payload };
  },
  async run(ctx, { args: rawArgs, stdin, payload }) {
    await runExec(ctx, rawArgs, stdin, payload);
  },
});

export async function exec(ctx: Context, args: string[]): Promise<void> {
  await runOnContext(EXEC, ctx, args);
}

async function runExec(ctx: Context, rawArgs: string[], stdin: string | undefined, payload: Buffer | undefined): Promise<void> {
  // Empty argv is refused by the parser: the verbatim variadic is declared required (see cli).
  // rawArgs stays whole: the head/tail split happens after @file replacement below.

  // Same never-bootstrapped refusal as cli's; without it the isRunning() preflight below
  // dies with the bare NotBootstrapped message.
  await requireBootstrapped(ctx);

  // Stage after the bootstrap check; removed on every path out, including failures (finally).
  const staged = payload === undefined ? undefined : await stagePayload(ctx, payload);
  try {
    const [head, ...tail] = staged === undefined ? rawArgs : replaceFileTokens(rawArgs, staged.containerPath);

    // Same capture/streaming and failure-reporting shape as `cli` — see its own comments for
    // why, including the stream: true --stdin needs so the transport does not swallow output.
    const captured = isCaptured();
    const options = captured
      ? { input: "", allowFailure: true }
      : { allowFailure: true, ...(stdin === undefined ? {} : { input: stdin, stream: true }) };

    const report = (result: ExecResult): void => {
      if (captured) {
        // Both streams whatever the exit code: a successful command's diagnostics live on stderr.
        emitRaw(result.stdout);
        emitRaw(result.stderr);
      }
      if (result.code !== 0) dieWithExitCode(execFailureHeadline(rawArgs, result.code), result.code);
    };

    if (ctx.runtime.execCommand === undefined) {
      die(`${ctx.runtime.description} does not support ${commandLine("exec")}`);
    }

    // Tried first, same reasoning as `cli`: an already-running helper answers faster than a
    // fresh one-off container, and proves the gateway is reachable in the same step.
    try {
      report(await ctx.runtime.execCommand(CLI_HELPER_SERVICE, head, tail, options));
      return;
    } catch (error) {
      if (!(error instanceof HelperNotRunning)) throw error;
    }

    if (!(await ctx.runtime.isRunning())) {
      die(`the gateway is not running. Start it with ${commandLine("up")}`);
    }

    // Disposable by design, same as `cli`'s own fallback: everything it touches lives in the
    // bind mounts, and --entrypoint hands the whole command line to the one-off container
    // instead of the "cli" service's own fixed "node dist/index.js" entrypoint.
    report(await ctx.runtime.runOneOff("cli", tail, { profile: "cli", entrypoint: head, ...options }));
  } finally {
    await staged?.remove();
  }
}
