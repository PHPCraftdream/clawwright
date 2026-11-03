// `clawwright bootstrap` — brings an instance up from nothing. Idempotent: re-running it on
// a live instance re-pulls the image (a digest pin is left alone) and rewrites desired-state,
// but does not restart the running gateway — changed settings need clawwright restart.
//
// Order matters:
//   1. .env and the gateway token — compose interpolates them
//   2. data directories owned by uid 1000, or the gateway cannot write
//   3. the image, before anything tries to run it
//   4. baseline config, or the gateway crash-loops on "Missing config"
//   5. declarative settings — a custom provider's baseUrl/models must exist before OpenClaw
//      accepts an apiKey for a provider id it does not already know
//   6. the provider, from the key in config/.env
//   7. only then start and wait for /healthz

import JSON5 from "json5";
import { log, info, warn } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit, withOutputSink } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import { refreshContext } from "#src/core/context.ts";
import { ensureDataDirs, ensureSecretsFile, ensureLockHome } from "#src/runtime/files/datadir.ts";
import { ensureBaselineConfig, configureProvider } from "#src/commands/management/configuration/credentials/provider.ts";
import { applyConfig } from "#src/commands/orchestration/config.ts";
import { preflightSecrets } from "#src/commands/management/configuration/secrets.ts";
import { preflightPort } from "#src/commands/lifecycle/bootstrap/prereqs.ts";
import { pinImageReference } from "#src/commands/lifecycle/instance/upgrade.ts";
import { guardedWith } from "#src/runtime/lock/instance-lock.ts";
import { collectConfiguredProviders } from "#src/service/secrets.ts";
import { format, withDigest, tryParse, digestOf, hasDigest } from "#src/runtime/docker/image-ref.ts";
import { commandBody, type ArgumentSpec } from "#src/core/command/spec.ts";
import { LOCK_TAKEOVER_ARGUMENTS, takeoverOf } from "#src/commands/interface/groups/shared-arguments.ts";
import { bootstrapCheck } from "./check.ts";

export const BOOTSTRAP_ARGUMENTS = [
  { name: "no-pull", description: "Use the local image", kind: "flag" },
  // A read flag: --check runs none of the mutation, so the call itself is a read.
  { name: "check", description: "Prerequisite report; read-only", kind: "flag", effect: "read" },
  ...LOCK_TAKEOVER_ARGUMENTS,
  { name: "json", description: "Outcome as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

/** After a fresh pull, repoints this deployment's OWN OPENCLAW_IMAGE from the moving tag to
 *  the exact digest just pulled — so a later pull of the same shared tag by another
 *  deployment can no longer silently switch what THIS one recreates onto next. Already-pinned
 *  deployments (`image` carries "@sha256:") are left alone: only clawwright upgrade moves
 *  those.
 *
 *  Best effort: a runtime that cannot resolve the digest just pulled leaves it a tag rather
 *  than guessing. Returns the context later steps should use: refreshContext() re-derives one
 *  from the .env this just rewrote; a context not built through createContext() has nothing to
 *  refresh and is returned unchanged. */
async function pinFreshPull(ctx: Context, image: string): Promise<Context> {
  const ref = tryParse(image);
  if (ref === undefined || hasDigest(image)) return ctx;
  const pulled = await ctx.runtime.imageReference();
  if (pulled === undefined) {
    warn(`pulled ${image} but could not resolve the digest it now holds locally — OPENCLAW_IMAGE stays a moving tag`);
    return ctx;
  }
  const digest = digestOf(pulled);
  if (digest === undefined) {
    warn(`pulled ${image} but could not resolve the digest it now holds locally — OPENCLAW_IMAGE stays a moving tag`);
    return ctx;
  }
  const pinned = format(withDigest(ref, digest));
  await pinImageReference(pinned);
  info(`pinned OPENCLAW_IMAGE to ${pinned} in .env — another deployment pulling ${image} on this Docker daemon can no longer move this one; ${commandLine("upgrade")} is how to move it from here`);
  const refreshed = await refreshContext(ctx);
  return refreshed?.context ?? ctx;
}

export const BOOTSTRAP = commandBody({
  effect: "change",
  preparesEnvironment: true,
  arguments: BOOTSTRAP_ARGUMENTS,
  async run(ctx, values) {
    const jsonOnly = values.json === true;

    // Read-only, and returned before anything below touches a lock or the target: --check
    // answers "would this bootstrap need something I have not prepared yet" without ever
    // creating ensureLockHome's own directory, let alone taking the instance lock guardedWith()
    // below does. See bootstrap/check.ts.
    if (values.check === true) {
      await bootstrapCheck(ctx, jsonOnly);
      return;
    }

    const noPull = values["no-pull"] === true;
    const takeover = takeoverOf(values);

    if (jsonOnly) {
      let outcome: BootstrapOutcome | undefined;
      let caught: unknown;
      await withOutputSink(() => {}, async () => {
        try {
          await ensureLockHome(ctx);
          outcome = await guardedWith(ctx, "bootstrap", takeover, () => bootstrapLocked(ctx, noPull));
        } catch (error) {
          caught = error;
        }
      });
      if (caught !== undefined) {
        const message = caught instanceof Error ? caught.message : String(caught);
        emit(`${JSON.stringify({ ok: false, changed: true, problems: [message] }, null, 2)}\n`);
        throw caught;
      }
      emit(`${JSON.stringify({ ok: true, changed: true, ...outcome }, null, 2)}\n`);
      return;
    }

    // Ahead of the lock, not inside it: the lock directory's PARENT is root:root on a fresh
    // host, needing the same sudo escalation ensureDataDirs uses — which cannot run while this
    // process is already trying to take a lock inside the very directory it is escalating to
    // create. Idempotent and side-effect-free beyond permissions, so running it unlocked
    // reintroduces none of the race the lock below exists to prevent.
    await ensureLockHome(ctx);

    // One lock for the whole sequence: separate locks per sub-command would let a run refused
    // by another operation already holding the lock still WRITE config/.env (ensureSecretsFile)
    // before the refusal surfaced. guardedWith() is nesting-safe, so applyConfig()/configureProvider()
    // below run inside this one outer hold instead of each acquiring their own.
    await guardedWith(ctx, "bootstrap", takeover, () => bootstrapLocked(ctx, noPull));
  },
});

/** What bootstrap's own --json emits — assembled from the same facts the narration path
 *  prints, not a second read of anything. */
interface BootstrapOutcome {
  serviceUrl: string;
  dataDir: string;
  image?: string;
  providerConfigured: boolean;
}

async function bootstrapLocked(ctx: Context, noPull: boolean): Promise<BootstrapOutcome> {
  // .env and the token exist before this runs: the CLI prepares them for commands that
  // declare preparesEnvironment, so ctx already carries the finished settings.
  const fresh = ctx.settings;
  let live = ctx;
  const token = fresh.env.OPENCLAW_GATEWAY_TOKEN ?? "";

  // Refuse a port already published by another deployment before preparing data or pulling
  // an image. The check and Docker's later bind are not atomic.
  await preflightPort(live);
  await ensureDataDirs(live);
  await ensureSecretsFile(live);

  if (noPull) {
    info("skipping pull (--no-pull)");
  } else {
    // A tag is resolved to its digest at the registry and pinned BEFORE the pull, so the
    // pull is by digest and never moves the shared local tag other deployments run on.
    const resolved = hasDigest(fresh.image) ? undefined : await live.runtime.resolveImageDigest?.(fresh.image);
    if (resolved !== undefined) {
      await pinImageReference(resolved);
      info(`pinned OPENCLAW_IMAGE to ${resolved} in .env — pulled by digest, the shared ${fresh.image} tag stays where it is; ${commandLine("upgrade")} moves it from here`);
      live = (await refreshContext(live))?.context ?? live;
      log(`pulling ${resolved}`);
      await live.runtime.pullImage();
    } else {
      log(`pulling ${fresh.image}`);
      await live.runtime.pullImage();
      // Fallback (digest unresolvable at the registry): the pull moved the local tag for every
      // deployment on it; at least this one is pinned to what it got.
      live = await pinFreshPull(live, fresh.image);
    }
  }

  await ensureBaselineConfig(live);
  // Declared settings before the provider key: a custom provider's baseUrl/model catalog
  // (config/desired-state.json) must exist first, since OpenClaw's schema requires baseUrl
  // on any provider id it does not already know — writing just the apiKey first leaves that
  // entry incomplete and OpenClaw refuses it. Built-in providers are exempt, so this order
  // costs them nothing.
  // Advice is suppressed only for a gateway this run is about to start; `compose up
  // --detach` leaves an already-running container untouched, so a live instance must hear
  // that the newly written desired state needs a restart to take effect.
  const wasRunning = await live.runtime.isRunning();
  await applyConfig(live, [], { restartAdvice: wasRunning });
  await configureProvider(live, []);

  await preflightSecrets(live);

  log("starting the gateway");
  await live.runtime.start();
  await live.runtime.waitForHealth();
  log("gateway is healthy");

  // Reported as the pinned string (the image-ref grammar's format(ref)), not Docker's bare
  // RepoDigest: the .env pin and the recreate both use repo:tag@sha256, so the report names
  // the same string a reader finds in .env (rf6-fix33). A configured image that does not
  // parse falls back to Docker's own spelling.
  const pulled = await live.runtime.imageReference();
  let image: string | undefined;
  if (pulled !== undefined) {
    const ref = tryParse(fresh.image);
    const digest = digestOf(pulled);
    image = ref !== undefined && digest !== undefined ? format(withDigest(ref, digest)) : pulled;
  }
  if (image !== undefined) info(`running image: ${image}`);

  log("OpenClaw is up");
  info(`gateway: ${fresh.serviceUrl}`);
  // Named, not printed: control-mcp hands this output back to an agent, so a token printed
  // here would land in a transcript. `clawwright mcp-creds --token` prints it on request.
  info(`token:   ${token === "" ? "(not generated)" : `in .env — print it with ${commandLine(["mcp-creds", "--token"])}`}`);
  info(`data:    ${fresh.dataDir}`);

  // "up" and "healthy" are not the job: answering a prompt is. Read the same way inspect does
  // (collectConfiguredProviders against the live config), not guessed from env vars, so a
  // provider-less instance is reported as such. Best effort: an unreadable config here is
  // doctor's finding to make, not a reason to fail a bootstrap that just succeeded.
  let providerConfigured = false;
  try {
    const liveConfig = JSON5.parse(await live.transport.readFile(`${fresh.dataDir}/config/openclaw.json`)) as unknown;
    providerConfigured = collectConfiguredProviders(liveConfig).length > 0;
    if (!providerConfigured) {
      info(`provider: none configured yet — an agent cannot answer until one is: ${commandLine("configure-provider")}`);
    }
  } catch {
    // Doctor's own read of the same file reports a broken config; this is only a bonus hint.
  }

  return { serviceUrl: fresh.serviceUrl, dataDir: fresh.dataDir, image, providerConfigured };
}
