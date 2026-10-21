// `clawwright cli …` — runs the OpenClaw CLI in a throwaway container that shares the gateway's
// network namespace and data mounts.

import { die, dieWithExitCode } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { isCaptured, emitRaw } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import type { ExecResult } from "#src/runtime/transport/transport.ts";
import { HelperNotRunning, requireBootstrapped } from "#src/runtime/runtime.ts";
import { commandBody, runOnContext } from "#src/core/command/index.ts";
import * as kinds from "#src/core/values/kinds.ts";
import { CLI_HELPER_SERVICE } from "./cli-helper.ts";
import {
  capturedStdinRefusalMessage, cliFailureHeadline, noFileTokenRefusalMessage, readPayloadFile,
  readStdinBounded, replaceFileTokens, stagePayload, ttyStdinRefusalMessage, type ExecPlan,
} from "./groups/exec-payload.ts";

export const CLI_ARGUMENTS = [
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
    summary: "Arguments passed to OpenClaw's CLI verbatim",
    description: "Arguments passed to OpenClaw's CLI verbatim, e.g. [\"config\", \"get\", \"gateway.mode\"]",
    kind: "variadic",
    verbatim: true,
    required: true,
    value: kinds.text("arguments passed to OpenClaw's CLI", { leadingDash: "allow", lines: "multi" }),
  },
] as const;

/** The command body; cli(ctx, args) stays for callers that already hold a Context. The
 *  verbatim tail starts at the first token that is no declared flag of ours — a leading
 *  bare -- is consumed as the boundary, everything after it is literal. */
export const CLI = commandBody({
  effect: "destroy",
  arguments: CLI_ARGUMENTS,
  // Every refusal and payload read happens here, before the pipeline builds any context or
  // transport — a bad payload never costs a target round trip, and `run` never refuses.
  async prepare(call): Promise<ExecPlan> {
    const v = call.values;
    const passed = [...(v.args as readonly string[])];
    const file = v.file as string | undefined;
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
    if (file !== undefined && !passed.includes("@file")) {
      // Do not guess where the path belongs: the argument list is OpenClaw's own, so only the
      // exact @file token is ever replaced.
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
    return { args: passed, stdin, payload };
  },
  async run(ctx, { args: passed, stdin, payload }) {
    await runCli(ctx, passed, stdin, payload);
  },
});

export async function cli(ctx: Context, args: string[]): Promise<void> {
  await runOnContext(CLI, ctx, args);
}

async function runCli(ctx: Context, passed: string[], stdin: string | undefined, payload: Buffer | undefined): Promise<void> {
  // Empty argv is refused by the parser: the verbatim variadic is declared required, so bind
  // refuses before any phase runs.

  // Same never-bootstrapped refusal as every other preflight path; without it the
  // isRunning() preflight below dies with the bare NotBootstrapped message.
  await requireBootstrapped(ctx);

  // Stage after the bootstrap check (the data directory must exist), remove on every path
  // out — including dieWithExitCode below, which throws.
  const staged = payload === undefined ? undefined : await stagePayload(ctx, payload);
  try {
    const args = staged === undefined ? passed : replaceFileTokens(passed, staged.containerPath);
    // Under a sink the child's own stdout would land in the middle of a JSON-RPC message, so
    // it is captured and re-emitted through the same sink as everything else. On a terminal
    // it streams, which is what someone watching a long command wants. allowFailure always: a
    // non-zero exit is reported below with openclaw's own exit code (dieWithExitCode), never
    // surfaced as the transport's own generic rejection. Captured mode with --stdin is
    // refused at prepare, so captured keeps today's input: "" unchanged. With --stdin the
    // transport needs stream: true — finite input alone would make it pipe and accumulate
    // the child's output, which nobody would ever re-emit here.
    const captured = isCaptured();
    const options = captured
      ? { input: "", allowFailure: true }
      : { allowFailure: true, ...(stdin === undefined ? {} : { input: stdin, stream: true }) };

    /** Captured output is re-emitted whole — both streams, whatever the exit code: stderr is
     *  where a command's diagnostics live (every framework log/info writes there), and
     *  compose's progress noise on success is the price. Streamed output already reached the
     *  terminal by the time this runs. */
    const report = (result: ExecResult): void => {
      if (captured) {
        emitRaw(result.stdout);
        emitRaw(result.stderr);
      }
      if (result.code !== 0) dieWithExitCode(cliFailureHeadline(args, result.code), result.code);
    };

    // Tried first, before the isRunning() preflight below: a helper that execs successfully
    // already proves the gateway is reachable, and skipping the extra round trip on the fast
    // path is most of the point of having a helper at all.
    try {
      report(await ctx.runtime.execInHelper(CLI_HELPER_SERVICE, args, options));
      return;
    } catch (error) {
      if (!(error instanceof HelperNotRunning)) throw error;
    }

    if (!(await ctx.runtime.isRunning())) {
      die(`the gateway is not running. Start it with ${commandLine("up")}`);
    }

    // Disposable by design: everything it touches lives in the bind mounts.
    report(await ctx.runtime.runOneOff("cli", args, { profile: "cli", ...options }));
  } finally {
    await staged?.remove();
  }
}
