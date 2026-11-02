// Everyday lifecycle commands: up, restart, down.
//
// Nothing here mentions Docker: the runtime and the
// transport in the context decide how the instance is actually started.

import { log, info, die } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import type { Context } from "#src/core/context.ts";
import { preflightSecrets } from "#src/commands/management/configuration/secrets.ts";
import { guardedWith } from "#src/runtime/lock/instance-lock.ts";
import { preflightPort } from "#src/commands/lifecycle/bootstrap/prereqs.ts";
import { commandBody, runOnContext, type Values } from "#src/core/command/index.ts";
import { LOCK_TAKEOVER_ARGUMENTS, takeoverOf } from "#src/commands/interface/groups/shared-arguments.ts";

interface LockValues extends Values<typeof LOCK_TAKEOVER_ARGUMENTS> {}

/** Starts the gateway and waits until it actually serves, not just until the container
 *  exists — a container that is "up" while crash-looping is the failure mode we hit. */
export const UP = commandBody({
  effect: "change",
  arguments: LOCK_TAKEOVER_ARGUMENTS,
  async run(ctx, values) {
    await requireBootstrapped(ctx);
    return guardedWith(ctx, "up", takeoverOf(values), () => startInstance(ctx));
  },
});

async function startInstance(ctx: Context): Promise<void> {
  // Checked before starting: a missing referenced variable makes the gateway fail with
  // SecretRefResolutionError and restart in a loop, with the reason only in its log.
  await preflightSecrets(ctx);
  await preflightPort(ctx);
  await ctx.runtime.start();
  log(`waiting for the gateway at ${ctx.settings.serviceUrl}`);
  await ctx.runtime.waitForHealth();
  log("gateway is healthy");
  info(ctx.settings.serviceUrl);
}

/** Restarts the instance so it re-reads configuration loaded only at startup.
 *
 *  `up` cannot do this: it converges on "running", and an already-healthy instance is already
 *  converged — a bind-mount edit changes nothing the runtime compares. Mirror image: restart
 *  re-reads files but keeps the container's own environment, interpolated from .env at
 *  creation — an edited .env needs Runtime.reconcile() (secrets --apply / `up`), not restart.
 *
 *  Secrets are checked first, same as `up`, since an unresolvable variable would crash-loop
 *  the restart. The port is not checked — the container keeps its existing binding. */
export const RESTART = commandBody({
  effect: "change",
  arguments: LOCK_TAKEOVER_ARGUMENTS,
  async run(ctx, values) {
    await requireBootstrapped(ctx);
    return guardedWith(ctx, "restart", takeoverOf(values), () => restartInstance(ctx));
  },
});

async function restartInstance(ctx: Context): Promise<void> {
  if (!(await ctx.runtime.isRunning())) {
    die(`the gateway is not running — start it with ${commandLine("up")}`);
  }
  await preflightSecrets(ctx);
  log("restarting the gateway");
  await ctx.runtime.restart();
  log(`waiting for the gateway at ${ctx.settings.serviceUrl}`);
  await ctx.runtime.waitForHealth();
  log("gateway is healthy");
}

/** Stops and removes the containers. Data survives: it lives in host bind mounts, not in
 *  runtime-managed volumes. No compose passthrough: only the lock-takeover flags reach
 *  here, so nothing typed after `down` (e.g. --rmi all, -v) can widen what it does. */
export const DOWN = commandBody({
  effect: "change",
  arguments: LOCK_TAKEOVER_ARGUMENTS,
  async run(ctx, values) {
    await requireBootstrapped(ctx);
    return guardedWith(ctx, "down", takeoverOf(values), async () => {
      await ctx.runtime.stop();
      log(`stopped; data kept in ${ctx.settings.dataDir}`);
    });
  },
});

export type { LockValues };

// Legacy signatures for importers outside this group (orchestration, sets): a thin wrapper
// over the body's own parse → run, exactly like calling the command.
export const up = (ctx: Context, args: string[]): Promise<void> => runOnContext(UP, ctx, args);
export const restart = (ctx: Context, args: string[]): Promise<void> => runOnContext(RESTART, ctx, args);
export const down = (ctx: Context, args: string[]): Promise<void> => runOnContext(DOWN, ctx, args);
