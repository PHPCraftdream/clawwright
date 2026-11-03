// `clawwright cli-start` / `cli-stop` — explicit control over the persistent CLI helper
// container that `cli` and `mcp-serve` exec into when it is running, instead of paying a
// fresh container's create/destroy cost on every call.

import { log, die } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import type { Context } from "#src/core/context.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import { commandBody, runOnContext } from "#src/core/command/index.ts";

export const CLI_HELPER_SERVICE = "cli-helper";
export const CLI_PROFILE = "cli";

// Both take nothing — an unrecognised argument (e.g. a misplaced --app) must not run silently.

/** The command body; cliStart(ctx, args) stays for callers that already hold a Context. */
export const CLI_START = commandBody({
  effect: "change",
  arguments: [] as const,
  async run(ctx) {
    // Preflight before anything touches the target: a never-bootstrapped deployment refuses
    // with the bootstrap remedy, not the raw NotBootstrapped from isRunning().
    await requireBootstrapped(ctx);
    if (!(await ctx.runtime.isRunning())) {
      die(`the gateway is not running. Start it with ${commandLine("up")}`);
    }
    if (await ctx.runtime.helperRunning(CLI_HELPER_SERVICE)) {
      log("the CLI helper is already running");
      return;
    }
    await ctx.runtime.startHelper(CLI_HELPER_SERVICE, CLI_PROFILE);
    log(`CLI helper started — ${commandLine("cli")} and ${commandLine("mcp-serve")} will exec into it`);
  },
});

/** The command body; cliStop(ctx, args) stays for callers that already hold a Context. */
export const CLI_STOP = commandBody({
  effect: "change",
  arguments: [] as const,
  async run(ctx) {
    // No running-check first: `rm --force --stop` is already a safe no-op when nothing is
    // there, and a check-then-act here would miss a container that exists but already
    // stopped on its own (e.g. after a host reboot), leaving it behind uncleaned.
    await ctx.runtime.stopHelper(CLI_HELPER_SERVICE, CLI_PROFILE);
    log("CLI helper stopped");
  },
});

export async function cliStart(ctx: Context, args: string[]): Promise<void> {
  await runOnContext(CLI_START, ctx, args);
}

export async function cliStop(ctx: Context, args: string[]): Promise<void> {
  await runOnContext(CLI_STOP, ctx, args);
}
