// The two deliveries. The framework is code and is mirrored, deletions included. The
// deployment is configuration, and only the parts that are not secret travel: the
// declaration, the desired state and the recipes. Its .env, its secret stores and its
// snapshots stay here — the server generates its own token, so a leaked local one cannot
// unlock it.

import { log, info, die } from "#src/core/io/log.ts";
import { renderAdvice, renderArguments } from "#src/core/io/invocation/render.ts";
import { targetFrame } from "#src/core/io/invocation/frame.ts";
import { command } from "#src/core/io/invocation/advice.ts";
import { sshTunnelCommand } from "#src/commands/operate/expose/ssh.ts";
import { deploymentDir, recipesDir } from "#src/runtime/deployment.ts";
import {
  EXCLUDES, FRAMEWORK_EXCLUDES, MARKER_FILE, directoryGuardScript, directoryPrepareScript,
  guardedRsyncPath, markerVerifyScript, quoted,
} from "#src/security/privacy/deploy-boundary.ts";
import type { Context } from "#src/core/context.ts";
import { runRemote } from "./server.ts";
import type { RemoteRoot } from "./server.ts";

/** The pasted hints and the executed remote line share one construction: cd into the
 *  remote path (POSIX-quoted), then the shim's own command for the named deployment. */
export function remoteLine(remotePath: string, argv: readonly string[], name: string): string {
  return `cd ${quoted(remotePath)} && ${renderAdvice(command([...argv], { app: name }), targetFrame({ kind: "checkout-shim", root: "" }, "posix"))}`;
}

/** The pasted hint and the executed remote line share one construction: cd into the remote
 *  path, then the shim's own bootstrap for the named deployment. */
export function bootstrapRemoteLine(remotePath: string, name: string): string {
  return remoteLine(remotePath, ["bootstrap"], name);
}

const RSYNC_ENV = { RSYNC_PROTECT_ARGS: "0", RSYNC_OLD_ARGS: "0" };

async function guardDestination(ctx: Context, target: string, path: string): Promise<void> {
  const checked = await runRemote(ctx, target, directoryGuardScript(path), { allowFailure: true });
  if (checked.code !== 0) die(`unsafe deploy destination on ${target}: ${path}`);
}

async function prepareDestination(ctx: Context, target: string, path: string): Promise<void> {
  const prepared = await runRemote(ctx, target, directoryPrepareScript(path, false), {
    allowFailure: true,
  });
  if (prepared.code !== 0) die(`cannot prepare deploy destination on ${target}: ${path}`);
}

/** Mirrors the framework checkout, then the deployment's own files (app.ts, config/,
 *  recipes/) onto the prepared remote root. Same order as the marker protocol expects: the
 *  destructive framework mirror runs first, and its marker survival is verified before the
 *  smaller deployment sync starts. */
export async function syncTrees(
  ctx: Context,
  target: string,
  sourceRoot: string,
  remotePath: string,
  remoteApp: string,
  remoteRecipes: string,
  name: string,
  root: RemoteRoot,
): Promise<void> {
  const source = await ctx.paths.toTarget(sourceRoot);
  const rootRsync = guardedRsyncPath(remotePath, remotePath);
  const appRsync = guardedRsyncPath(remotePath, remoteApp);
  const configPath = `${remoteApp}/config`;
  const configRsync = guardedRsyncPath(remotePath, configPath);
  const recipesRsync = guardedRsyncPath(remotePath, remoteRecipes);
  log(`syncing the framework to ${target}:${remotePath}`);
  await guardDestination(ctx, target, remotePath);
  await ctx.transport.exec(
    "rsync",
    [
      "-az",
      // Deletions are mirrored, but only within what is actually sent: excluded paths on
      // the server — its .env, its data, other deployments — are left alone.
      "--delete",
      "--no-secluded-args",
      "--rsync-path",
      rootRsync,
      // This generated remote file is absent from the source tree; protect only its root path.
      "--exclude",
      `/${MARKER_FILE}`,
      ...FRAMEWORK_EXCLUDES.flatMap((pattern) => ["--exclude", pattern]),
      `${source}/`,
      `${target}:${remotePath}/`,
    ],
    { stream: true, env: RSYNC_ENV },
  );

  if (root.createdMarkerLine !== undefined) {
    const verified = await runRemote(
      ctx,
      target,
      markerVerifyScript(root.markerPath, root.expectedMarker, root.createdMarkerLine),
      { allowFailure: true },
    );
    if (verified.code !== 0) {
      die(`the deploy root marker did not survive the framework sync at ${remotePath} on ${target}`);
    }
  }

  // The deployment, by name and file. Anything not listed here does not travel.
  const local = await ctx.paths.toTarget(deploymentDir());
  log(`syncing the ${name} deployment (declaration, desired state, recipes)`);
  // No secrets directory: the server creates its own when keys are installed there.
  await prepareDestination(ctx, target, configPath);
  await prepareDestination(ctx, target, remoteRecipes);
  await guardDestination(ctx, target, remoteApp);
  await ctx.transport.exec("rsync", [
    "-az", "--no-secluded-args", "--rsync-path", appRsync,
    `${local}/app.ts`, `${target}:${remoteApp}/`,
  ], { env: RSYNC_ENV });

  // Same exclusions as the framework sync, so what --delete may touch stays symmetric with
  // what was actually sent — a recipe's own .env or a stray secret store under config/ must
  // not be erased just because it wasn't mirrored.
  const deploymentExcludes = EXCLUDES.flatMap((pattern) => ["--exclude", pattern]);
  const localRecipes = await ctx.paths.toTarget(recipesDir());
  await guardDestination(ctx, target, configPath);
  await ctx.transport.exec("rsync", [
    "-az",
    "--delete",
    "--no-secluded-args",
    "--rsync-path",
    configRsync,
    ...deploymentExcludes,
    `${local}/config/`,
    `${target}:${remoteApp}/config/`,
  ], { env: RSYNC_ENV });
  await guardDestination(ctx, target, remoteRecipes);
  await ctx.transport.exec("rsync", [
    "-az",
    "--delete",
    "--no-secluded-args",
    "--rsync-path",
    recipesRsync,
    ...deploymentExcludes,
    `${localRecipes}/`,
    `${target}:${remoteRecipes}/`,
  ], { env: RSYNC_ENV });

  // rsync from a Windows-mounted filesystem loses the executable bit.
  await runRemote(ctx, target, `chmod +x ${quoted(`${remotePath}/clawwright`)}`);
}

/** Either leaves the files synced with a hint for a manual bootstrap, or bootstraps the
 *  remote instance and prints how to reach it. */
export async function bootstrapAndReport(
  ctx: Context,
  target: string,
  remotePath: string,
  name: string,
  runBootstrap: boolean,
  remotePathNote: string | undefined,
): Promise<void> {
  if (!runBootstrap) {
    log(`files synced to ${target}:${remotePath} (bootstrap skipped)`);
    info(`bring it up there with: ${bootstrapRemoteLine(remotePath, name)}`);
    if (remotePathNote !== undefined) info(remotePathNote);
    return;
  }

  log(`bootstrapping ${name} on ${target}`);
  // The deployment is named: the server's default would otherwise be a different one.
  // -t only when we have a terminal to give it.
  await runRemote(ctx, target, bootstrapRemoteLine(remotePath, name), {
    stream: true,
    tty: process.stdout.isTTY === true,
  });

  log("deployed");
  info("the gateway listens on the remote loopback only. Open a tunnel from here:");
  info(`  ${renderArguments(sshTunnelCommand(target, ctx.settings.gatewayPort, ctx.settings.gatewayPort))}`);
  info(`provider keys are not copied — install them there: ${remoteLine(remotePath, ["secrets", "--apply"], name)}`);
  if (remotePathNote !== undefined) info(remotePathNote);
}
