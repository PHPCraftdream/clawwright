// `upgrade`: digest-pinned image upgrade with backup, health/doctor gates and rollback.

import { log, info, warn, die } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit, withOutputSink } from "#src/core/io/output.ts";
import { sleep, requireBootstrapped } from "#src/runtime/runtime.ts";
import { refreshContext, type Context } from "#src/core/context.ts";
import { envFile } from "#src/runtime/deployment.ts";
import { parseEnv, readEnvFileText } from "#src/core/env.ts";
import { upsertEnvValue } from "#src/security/privacy/private-config.ts";
import { replacePrivateFile } from "#src/security/privacy/private-file.ts";
import { createBackup, NativeBackupUnsupportedError } from "#src/commands/lifecycle/backup/index.ts";
import { restoreArchive } from "#src/commands/lifecycle/restore/index.ts";
import { parse, tryParse, format, repositoryOf, withDigest, sameContent, digestOf, invalidImageReference, type ImageRef } from "#src/runtime/docker/image-ref.ts";
import * as kinds from "#src/core/values/kinds.ts";
import { commandBody, type ArgumentSpec } from "#src/core/command/spec.ts";
import { guardedWith } from "#src/runtime/lock/instance-lock.ts";
import { LOCK_TAKEOVER_ARGUMENTS, takeoverOf } from "#src/commands/interface/groups/shared-arguments.ts";

export const UPGRADE_AVAILABLE = "upgrade available";

export function pinAdviceLine(pinnedReference: string): string {
  return `5. on success: pin OPENCLAW_IMAGE to ${pinnedReference} in .env`;
}

export function settingsImageRefusal(value: string): string {
  return `OPENCLAW_IMAGE: ${invalidImageReference(value)}.`;
}

export const UPGRADE_ARGUMENTS = [
  {
    name: "image",
    summary: "Image to upgrade to",
    description: "Upgrade to this image reference instead of the deployment's own OPENCLAW_IMAGE",
    kind: "option",
    valueName: "ref",
    value: kinds.image(),
  },
  { name: "dry-run", description: "Plan only", kind: "flag", effect: "read" },
  { name: "json", description: "Outcome as JSON", kind: "flag" },
  ...LOCK_TAKEOVER_ARGUMENTS,
] as const satisfies readonly ArgumentSpec[];

/** `channel` is the repo[:tag] the digest was resolved from; `pin` the reference the success
 *  path writes — an explicit tagless digest of the tracked repository keeps the deployment's
 *  tag, so the pin stays a channel a plain `upgrade` can re-resolve. */
interface UpgradeTarget {
  readonly targetDigest: string;
  readonly channel?: string;
  readonly pin?: string;
}

/** An explicit digest is used as-is. Anything else — including a pinned `repo:tag@sha256:…`
 *  OPENCLAW_IMAGE — is a channel re-resolved at the registry, so a plain `upgrade` asks whether
 *  the tag moved. A tagless pin has no recoverable channel and is refused. */
async function resolveUpgradeTarget(
  ctx: Context,
  requestedImage: string | undefined,
  resolveImageDigest: (reference: string) => Promise<string | undefined>,
): Promise<UpgradeTarget> {
  const requested = requestedImage === undefined ? undefined : parse(requestedImage);
  if (requested?.digest !== undefined) {
    // An explicit digest is checked at the registry (buildx imagetools inspect accepts one)
    // before anything else — --dry-run must not sign an unverified reference, and a real run
    // must refuse before the pre-upgrade backup stops the gateway.
    if ((await resolveImageDigest(requestedImage!)) === undefined) {
      die(`the registry does not know ${requestedImage} — refusing before any backup or change`);
    }
    if (requested.tag !== undefined) return { targetDigest: requestedImage! };
    // The channel and the requested digest name the same repository when their tagless
    // repo parts match — compare repositories, never the channel string itself.
    const declared = tryParse(ctx.settings.image);
    if (declared !== undefined && declared.tag !== undefined && repositoryOf(declared) === repositoryOf(requested)) {
      return { targetDigest: requestedImage!, pin: format(withDigest(declared, requested.digest)) };
    }
    return { targetDigest: requestedImage! };
  }

  let channelRef: ImageRef | undefined = requested === undefined ? undefined : { ...requested, digest: undefined };
  if (channelRef === undefined) {
    const declared = tryParse(ctx.settings.image);
    if (declared === undefined) {
      die(settingsImageRefusal(ctx.settings.image));
    }
    if (declared.digest !== undefined && declared.tag === undefined) {
      die(
        `OPENCLAW_IMAGE is "${ctx.settings.image}" — a digest with no tag alongside it, so the channel it was ` +
          "pulled from is unknown and cannot be re-resolved. Name the channel explicitly: " +
          `${commandLine(["upgrade", "--image", "<repo:tag>"])} (upgrade then keeps the tag alongside the digest).`,
      );
    }
    channelRef = { ...declared, digest: undefined };
  }

  const channelString = format(channelRef);
  const targetDigest = await resolveImageDigest(channelString);
  if (targetDigest === undefined) die(`could not resolve a digest for ${channelString} — refusing to upgrade to an unverified reference`);
  return { targetDigest, channel: channelString };
}

/** Waits for /startupz then /readyz, watching the container's own exit code the whole time
 *  so a migration failure (upstream docs: exit 78) is told apart from one still starting —
 *  the caller needs that distinction to decide whether data may already have changed. */
async function waitForUpgradeHealth(ctx: Context, timeoutMs = 180_000): Promise<{ ok: true } | { ok: false; migrationExit78: boolean; reason: string }> {
  for (const endpoint of ["startupz", "readyz"] as const) {
    const deadline = Date.now() + timeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      if ((await ctx.runtime.probe(endpoint)) === 200) { ready = true; break; }
      const exitCode = await ctx.runtime.lastExitCode?.();
      if (exitCode === 78) return { ok: false, migrationExit78: true, reason: `the container exited 78 (migrations could not proceed) while waiting for /${endpoint}` };
      if (exitCode !== undefined && exitCode !== 0 && !(await ctx.runtime.isRunning())) {
        return { ok: false, migrationExit78: false, reason: `the container exited ${exitCode} while waiting for /${endpoint}` };
      }
      await sleep(2000);
    }
    if (!ready) return { ok: false, migrationExit78: false, reason: `the gateway did not answer /${endpoint} within ${timeoutMs / 1000}s` };
  }
  try {
    await ctx.runtime.waitForHealth();
  } catch (error) {
    return { ok: false, migrationExit78: false, reason: (error as Error).message };
  }
  return { ok: true };
}

/** `openclaw doctor --lint --json`, read for blocking findings rather than trusted by exit
 *  code alone: an unconfigured or merely-imperfect instance answers non-zero over routine
 *  "warning" findings (an optional skill's binary missing, say) that have nothing to do with
 *  the upgrade — only a "error"-severity finding, or output this cannot even parse, refuses
 *  it. --severity-min is asked for up front (smaller payload) and re-checked here regardless
 *  of whether an older image honours the flag. */
async function runDoctorLint(ctx: Context): Promise<{ ok: true } | { ok: false; detail: string }> {
  const result = await ctx.runtime.runOneOff("cli", ["doctor", "--lint", "--json", "--non-interactive", "--severity-min", "error"], {
    profile: "cli", input: "", allowFailure: true,
  });
  let parsed: { findings?: unknown };
  try {
    parsed = JSON.parse(result.stdout) as { findings?: unknown };
  } catch {
    return { ok: false, detail: `doctor --lint did not return parseable JSON (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 300)}` };
  }
  const findings = Array.isArray(parsed.findings) ? parsed.findings as Array<{ severity?: unknown; checkId?: unknown; message?: unknown }> : [];
  const blocking = findings.filter((finding) => finding?.severity === "error");
  if (blocking.length === 0) return { ok: true };
  return { ok: false, detail: blocking.map((finding) => `${finding.checkId ?? "?"}: ${finding.message ?? "?"}`).join("; ") };
}

/** Rewrites this deployment's own .env (repo-side, not the target) so a later recreate stays
 *  pinned to a digest rather than the moving tag — one of the few places allowed to rewrite
 *  .env on its own (apply never rewrites the lock; see docs/guide/operations.md), used by
 *  upgrade (the digest just proven healthy) and bootstrap (the digest a fresh pull resolved
 *  to): pinning records a fact just proven, not a decision. */
export async function pinImageReference(digestReference: string): Promise<void> {
  const path = envFile();
  const content = upsertEnvValue(await readEnvFileText(), "OPENCLAW_IMAGE", digestReference);
  await replacePrivateFile(path, content);
}

async function rollbackUpgrade(
  ctx: Context,
  previousDigest: string,
  previousReference: string,
  backupArchive: string,
  restoreData: boolean,
  cause: unknown,
  recreateWithImage: (reference: string) => Promise<void>,
): Promise<never> {
  const reason = cause instanceof Error ? cause.message : String(cause);
  warn(`upgrade failed — rolling back to ${previousDigest}: ${reason}`);
  // Container and .env must end on the same content: Compose reads OPENCLAW_IMAGE into the
  // recreated container's image, so recreating on a different SPELLING than the pin records
  // (tagless RepoDigests under a tagged pin) leaves the next up recreating again even though
  // the digest matches. The pin below is computed once and used for BOTH: the recreated
  // container's image IS the string .env will hold.
  const previous = tryParse(previousReference);
  const previousContent = digestOf(previousDigest);
  const pinned = previous === undefined || previousContent === undefined || previous.tag === undefined
    || sameContent(previousReference, previousDigest)
    ? previousReference
    : format(withDigest({ ...previous, digest: undefined }, previousContent));
  try {
    // Restore before starting the old code against data that migrations may have changed.
    // noStart prevents restore from restarting the failed target's transient settings.
    if (restoreData) {
      warn(`migrations may have run against the new image — restoring the pre-upgrade backup: ${backupArchive}`);
      await restoreArchive(ctx, backupArchive, { force: true, noStart: true });
    }
    await recreateWithImage(pinned);
    await ctx.runtime.waitForHealth();
    const identity = await ctx.runtime.runningImageIdentity?.();
    if (!identity?.digests.some((digest) => sameContent(digest, previousDigest))) {
      throw new Error(`could not confirm the rollback gateway is running ${previousDigest}`);
    }
    // The exact string the container was recreated on — never a different spelling of it.
    await pinImageReference(pinned);
  } catch (compensationError) {
    const detail = compensationError instanceof Error ? compensationError.message : String(compensationError);
    throw new AggregateError(
      [cause, compensationError],
      `upgrade failed: ${reason}; rollback to ${previousDigest} failed: ${detail}; pre-upgrade backup: ${backupArchive}`,
    );
  }
  throw new Error(`upgrade failed and was rolled back to ${previousDigest}: ${reason}; pre-upgrade backup: ${backupArchive}`, { cause });
}

async function upgradeLocked(
  ctx: Context,
  previousDigest: string,
  targetDigest: string,
  pinnedReference: string,
  previousReference: string,
  recreateWithImage: (reference: string, onMutationStart?: () => void) => Promise<void>,
): Promise<void> {
  log(`upgrading from ${previousDigest} to ${targetDigest}`);

  log("taking a pre-upgrade backup");
  let backupArchive: string;
  try {
    backupArchive = await createBackup(ctx, { profile: "full", native: true, purpose: "upgrade" });
  } catch (error) {
    if (!(error instanceof NativeBackupUnsupportedError)) throw error;
    warn(`native backup unavailable (${error.message}) — falling back to a stopped full backup`);
    backupArchive = await createBackup(ctx, { profile: "full", purpose: "upgrade" });
  }
  log(`pre-upgrade backup: ${backupArchive}`);

  let restoreData = false;
  let mutationStarted = false;
  try {
    // From this call onward Compose may have changed the container even when it throws.
    // Recreate on the exact string that will be pinned, so Compose's config hash does not
    // change again at the next up/apply.
    log(`recreating the gateway on ${pinnedReference}`);
    await recreateWithImage(pinnedReference, () => { mutationStarted = true; });

    const health = await waitForUpgradeHealth(ctx);
    if (!health.ok) {
      restoreData = health.migrationExit78;
      throw new Error(health.reason);
    }

    log("running openclaw doctor --lint");
    const lint = await runDoctorLint(ctx);
    if (!lint.ok) throw new Error(`openclaw doctor --lint reported blocking finding(s): ${lint.detail}`);

    const identity = await ctx.runtime.runningImageIdentity?.();
    if (!identity?.digests.some((digest) => sameContent(digest, targetDigest))) {
      throw new Error(`could not confirm the validated gateway is running ${targetDigest}`);
    }
    await pinImageReference(pinnedReference);
  } catch (error) {
    if (!mutationStarted) throw error;
    // An exception from recreation/probes can precede the normal exit-78 observation.
    // Failure to query that code must not replace the original upgrade failure.
    if (!restoreData) {
      try { restoreData = (await ctx.runtime.lastExitCode?.()) === 78; } catch { /* unknown */ }
    }
    await rollbackUpgrade(ctx, previousDigest, previousReference, backupArchive, restoreData, error, recreateWithImage);
  }
  log(`upgrade complete: now running ${targetDigest}`);
  info(`re-pin the deployment's own record of this: ${commandLine("lock")}`);
}

/** `clawwright upgrade` — pulls the target image by digest (never moving a shared local tag),
 *  takes a consistent pre-upgrade backup, recreates the gateway on it, and rolls back to the
 *  digest it was running before on any failure — restoring that backup too when the failure
 *  was a migration (exit 78) that may already have changed the data.
 *
 *  --image <ref> upgrades to that reference instead of the deployment's own OPENCLAW_IMAGE;
 *  see resolveUpgradeTarget for how the target is chosen.
 *  --dry-run prints the plan and changes nothing — not even taking the instance lock. */
export const UPGRADE = commandBody({
  effect: "destroy",
  arguments: UPGRADE_ARGUMENTS,
  async run(ctx, values) {
    const options = { image: values.image === undefined ? undefined : format(values.image), dryRun: values["dry-run"] === true, jsonOnly: values.json === true };
    await requireBootstrapped(ctx);

  if (ctx.runtime.resolveImageDigest === undefined || ctx.runtime.recreateWithImage === undefined) {
    die(`${ctx.runtime.description} does not support ${commandLine("upgrade")}`);
  }
  const resolveImageDigest = ctx.runtime.resolveImageDigest.bind(ctx.runtime);
  const recreateWithImage = ctx.runtime.recreateWithImage.bind(ctx.runtime);

  const target = await resolveUpgradeTarget(ctx, options.image, resolveImageDigest);
  // The one string both the recreate and the .env write use, and every report names.
  const pinnedReference = target.pin ?? target.targetDigest;
  const preparedEnv = await readEnvFileText();
  const previousReference = parseEnv(preparedEnv, envFile()).OPENCLAW_IMAGE ?? ctx.settings.image;

  const identity = await ctx.runtime.runningImageIdentity?.();
  if (identity === undefined || identity.digests.length === 0) {
    die(`could not determine the currently running image digest — refusing to upgrade with no rollback target. Is the gateway running (${commandLine("up")})?`);
  }
  const previousDigest = identity.digests[0];
  const upToDate = sameContent(target.targetDigest, previousDigest);

  if (options.dryRun === true) {
    if (options.jsonOnly) {
      emit(
        `${JSON.stringify(
          { ok: true, changed: false, current: previousDigest, channel: target.channel ?? null, target: target.targetDigest, pinnedImage: pinnedReference, upToDate },
          null,
          2,
        )}\n`,
      );
      return;
    }
    log(`current    ${previousDigest}`);
    if (target.channel !== undefined) log(`channel    ${target.channel}`);
    log(`registry   ${target.targetDigest}`);
    if (upToDate) {
      log(target.channel === undefined ? "up to date — nothing to upgrade" : `up to date — ${target.channel} still resolves to what is running`);
    } else {
      log(`${UPGRADE_AVAILABLE}: ${previousDigest} -> ${target.targetDigest}`);
      info("1. pre-upgrade backup (native, i.e. hot, if the image supports it — else a stopped full backup)");
      info(`2. recreate the gateway on ${pinnedReference}`);
      info("3. wait for /startupz then /readyz, then run openclaw doctor --lint");
      info("4. on any failure: recreate on the previous digest; also restore the backup if migrations ran (exit 78)");
      info(pinAdviceLine(pinnedReference));
    }
    info("--dry-run changes nothing, and takes no lock");
    return;
  }

  let changed = false;
  const execute = () => guardedWith(ctx, "upgrade", takeoverOf(values), async () => {
    // Preparation is only an observation. Never let a completed competing upgrade
    // supply the backup while the old Context supplies its CLI/image or rollback.
    const current = await ctx.runtime.runningImageIdentity?.();
    if (!(await ctx.runtime.isRunning()) || current === undefined || current.digests.length === 0) {
      die("could not determine the currently running image digest under the instance lock — refusing to upgrade with no rollback target");
    }
    if (!sameContent(current.digests[0], previousDigest)) {
      die("the running image changed while preparing upgrade — refusing before backup or recreation; retry the command");
    }
    const refreshed = await refreshContext(ctx);
    if (await readEnvFileText() !== preparedEnv || (refreshed !== undefined && (refreshed.changed.length > 0 || refreshed.targetChanges.length > 0))) {
      die("deployment settings changed while preparing upgrade — refusing before backup or recreation; retry the command");
    }
    // Even a no-op must be decided against the authoritative predecessor.
    if (sameContent(target.targetDigest, current.digests[0])) {
      log(target.channel === undefined ? `already running ${current.digests[0]} — nothing to upgrade` : `already on the latest ${target.channel} (${current.digests[0]}) — nothing to upgrade`);
      return;
    }
    changed = true;
    await upgradeLocked(ctx, current.digests[0], target.targetDigest, pinnedReference, previousReference, recreateWithImage);
  });

  if (options.jsonOnly) {
    let caught: unknown;
    await withOutputSink(() => {}, async () => {
      try {
        await execute();
      } catch (error) {
        caught = error;
      }
    });
    if (caught !== undefined) {
      const message = caught instanceof Error ? caught.message : String(caught);
      emit(`${JSON.stringify({ ok: false, changed, from: previousDigest, to: target.targetDigest, problems: [message] }, null, 2)}\n`);
      throw caught;
    }
    emit(`${JSON.stringify(changed
      ? { ok: true, changed: true, from: previousDigest, to: target.targetDigest, pinnedImage: pinnedReference }
      : { ok: true, changed: false, current: previousDigest, target: target.targetDigest, upToDate: true }, null, 2)}\n`);
    return;
  }

  await execute();
  },
});
