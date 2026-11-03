// The backup/restore round-trip and privacy-check phase of `clawwright smoke`.
//
// The round-trip check is the heaviest: a FULL backup with the gateway held down, restored
// into an isolated scratch root beside the data directory (never over live data) and compared
// byte for byte, private paths included. --quick exists because of it.
//
// It and the two verifier checks (REJECTS_SECRETS_ENTRY, ACCEPTS_SHARE_ENTRY) each need an
// archive taken with the gateway down. Run alone, each manages its own stop/start; run
// together via runSmokeSuite() that would cost three outages, so runArchiveChecks() pauses
// once, takes both archives, restarts, then verifies and restore-diffs with the gateway back up.

import { randomBytes } from "node:crypto";
import { basename, dirname } from "node:path";
import { log, UserError } from "#src/core/io/log.ts";
import { TransportUnreachableError } from "#src/runtime/transport/transport.ts";
import type { Context } from "#src/core/context.ts";
import { CouldNotCheck } from "#src/commands/check-outcome.ts";
import { createBackup } from "#src/commands/lifecycle/backup/index.ts";
import { pullSnapshot } from "#src/commands/lifecycle/state.ts";
import { restoreArchive } from "#src/commands/lifecycle/restore/index.ts";
import { verifySnapshotQuietly } from "#src/commands/lifecycle/verify.ts";
import { dataDirName, dataDirParent } from "#src/service/archive/index.ts";
import { installedRecipePrivatePaths } from "#src/service/recipe.ts";
import { runMaybePrivileged, sudoFor } from "#src/runtime/files/datadir.ts";
import { guardedWith } from "#src/runtime/lock/instance-lock.ts";
import { reach, expect, describeError, evaluate, toResult, type Check, type SmokeResult } from "./verdict.ts";

/** reach() for a call into a command that can refuse on its own: die() is a verdict about
 *  the deployment — a backup that refuses a symlinked data root, or a restore that rejects
 *  an archive, failed the check; it did not go unanswered. Only the transport-level
 *  failures underneath the command are could-not-check. */
async function reachVerdict<T>(doing: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    // The transport refusal is a UserError now (rf6-fix33); the wrap below still answers
    // it, because could-not-check is exactly its verdict — about the connection, not the
    // deployment. Only a deployment's own die() is rethrown as a verdict.
    if (error instanceof UserError && !(error instanceof TransportUnreachableError)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CouldNotCheck(`could not ${doing}: ${message}`);
  }
}

/** Hashes a file or tree as a normalized tar stream on the target. Output remains a digest,
 *  so private bytes never cross the transport or enter an error message. */
async function sha256Of(ctx: Context, path: string): Promise<string> {
  const prefix = await sudoFor(ctx, path);
  const parent = dirname(path);
  const name = basename(path);
  const script = "set -o pipefail; tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=gnu -cf - -C \"$1\" -- \"$2\" | sha256sum";
  const [head, ...rest] = [...prefix, "bash", "-o", "pipefail", "-c", script, "bash", parent, name];
  const result = await reach(`read ${path}`, () => ctx.transport.exec(head, rest));
  if (result.code !== 0) {
    throw new CouldNotCheck(`could not hash ${path}: ${result.stderr.trim() || `tar exited ${result.code}`}`);
  }
  const digest = /^([a-f\d]{64})\s/.exec(result.stdout)?.[1];
  if (digest === undefined) throw new CouldNotCheck(`could not hash ${path}: target returned no sha256 digest`);
  return digest;
}

// Archive-check names, one spelling shared with runArchiveChecks()/index.ts's runSmokeSuite().
export const REJECTS_SECRETS_CHECK = "verifier rejects an archive with secrets";
export const ACCEPTS_SHARE_CHECK = "verifier accepts a share snapshot";
export const ROUND_TRIP_CHECK = "snapshot round-trip is byte-identical";
export const ARCHIVE_CHECK_NAMES: ReadonlySet<string> = new Set([REJECTS_SECRETS_CHECK, ACCEPTS_SHARE_CHECK, ROUND_TRIP_CHECK]);

export const REJECTS_SECRETS_ENTRY: Check = {
  name: REJECTS_SECRETS_CHECK,
  run: async (ctx) => {
    const archive = await reach("take a backup to verify", () => createBackup(ctx, { profile: "full", purpose: "internal" }));
    const passed = await verifySnapshotQuietly(ctx, archive, "share");
    expect(!passed, "the verifier accepted an archive containing credentials");
  },
};

export const ACCEPTS_SHARE_ENTRY: Check = {
  name: ACCEPTS_SHARE_CHECK,
  run: async (ctx) => {
    try {
      await pullSnapshot(ctx, "share", { purpose: "internal" });
    } catch (error) {
      // pull's own die() IS the verdict — a rejected snapshot is a failed check, not an
      // unreachable instance. Anything else never got far enough to judge anything. The
      // transport refusal is a UserError now (rf6-fix33) but stays not-a-verdict: the wrap
      // below answers it.
      if (error instanceof UserError && !(error instanceof TransportUnreachableError)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new CouldNotCheck(`could not take a share snapshot: ${message}`);
    }
  },
};

// Disaster-recovery test in the only shape a smoke run may take: it takes a FULL backup
// with the gateway held down and restores it into an isolated scratch root beside the
// data directory, then compares private paths as normalized archive streams. It never
// writes a witness into the live data root: a migrate-profile snapshot pushed straight
// back over the working tree would drop every privatePath on the floor while still
// reporting success. A live overwrite-and-restore drill, if anyone wants one, is an
// explicit, separately confirmed operation — not a side effect of `smoke`.
//
// Self-contained on purpose: called directly (as the tests beside this file do), it
// manages its own single stop/start cycle. Called together with its two sibling
// archive-based checks through the real `smoke` command, runArchiveChecks() (below) runs
// the offline half of this same check — roundTripUsingArchive — against an archive the
// shared window already took, so the whole trio costs one outage instead of three.
export const ROUND_TRIP_ENTRY: Check = {
  name: ROUND_TRIP_CHECK,
  run: async (ctx) => {
    // `smoke` itself declares no --break-lock (only --quick): a refusal from this internal
    // step must not offer a flag the command has nowhere to read it from.
    await guardedWith(ctx, "smoke round-trip", { breakLock: false }, () => roundTripCheck(ctx), { breakLockSupported: false });
  },
};

/** Hashes the live witnesses a round-trip restore must reproduce byte-for-byte: the
 *  required config file, plus whatever private paths are declared. Read on the LIVE data
 *  directory, so what gets hashed is what the archive about to be taken will actually
 *  contain — every caller below reads this before the archive that has to match it. */
async function collectRoundTripWitnesses(ctx: Context): Promise<Map<string, string>> {
  const dataDir = ctx.settings.dataDir;
  const witnesses = new Map<string, string>();
  const paths = new Set(["config/openclaw.json", ...await installedRecipePrivatePaths()]);
  for (const relative of paths) {
    const live = `${dataDir}/${relative}`;
    if (!(await reach(`look for ${relative}`, () => ctx.transport.exists(live)))) {
      if (relative === "config/openclaw.json") throw new CouldNotCheck("required smoke witness config/openclaw.json is missing");
      continue;
    }
    witnesses.set(relative, await sha256Of(ctx, live));
  }
  return witnesses;
}

interface RoundTripScratch {
  readonly scratch: string;
  readonly restored: string;
  readonly isolated: Context;
}

/** The scratch root keeps the data directory's own basename — restore refuses an archive
 *  whose root does not match the data directory's name — under a scratch parent of its own.
 *  The restore must not reach the live gateway: restoreArchive stops "the" runtime before
 *  unpacking, but the scratch root has no compose project behind it. Everything else the
 *  restore asks of the runtime (the recipe stacks' state) passes through to the real one —
 *  bound to it, so private state keeps working — and the live service state is the caller's
 *  own compensation to manage, not this function's. */
function roundTripScratch(ctx: Context): RoundTripScratch {
  const dataDir = ctx.settings.dataDir;
  const scratch = `${dataDirParent(dataDir)}/.clawwright-smoke-roundtrip-${randomBytes(4).toString("hex")}`;
  const restored = `${scratch}/${dataDirName(dataDir)}`;
  const isolated: Context = {
    ...ctx,
    settings: { ...ctx.settings, dataDir: restored },
    runtime: new Proxy(ctx.runtime, {
      get(target, property) {
        if (property === "stop") return async () => {};
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  } as unknown as Context;
  return { scratch, restored, isolated };
}

/** Confirms every witness in `witnesses` came back byte-identical under the isolated root
 *  `restored`. */
async function compareRestoredWitnesses(ctx: Context, restored: string, witnesses: Map<string, string>): Promise<void> {
  for (const [relative, digest] of witnesses) {
    const copy = `${restored}/${relative}`;
    expect(await reach(`look for ${relative} in the isolated root`, () => ctx.transport.exists(copy)), `the restore lost the smoke witness ${relative}`);
    expect((await sha256Of(ctx, copy)) === digest, `the restore changed the smoke witness ${relative}`);
  }
}

/** Folds compensation failures into whatever the body already decided: never swallowed — a
 *  compensation error always surfaces — and never allowed to replace the body's own verdict
 *  either. Shared by the round-trip check's standalone and offline-consolidated
 *  shapes below, since both owe the same discipline to their own scratch-root cleanup. */
function settleWithCompensation(bodyError: unknown, compensationErrors: unknown[]): void {
  if (bodyError !== undefined) {
    if (compensationErrors.length === 0) throw bodyError;
    throw new AggregateError(
      [bodyError, ...compensationErrors],
      `the round-trip check failed and its cleanup also failed: ${describeError(bodyError)}; ${compensationErrors.map(describeError).join("; ")}`,
    );
  }
  if (compensationErrors.length > 0) {
    throw new AggregateError(compensationErrors, `the round-trip check passed but its cleanup failed: ${compensationErrors.map(describeError).join("; ")}`);
  }
}

/** The round-trip check's standalone shape: reads the gateway's own starting state,
 *  collects the witnesses, pauses (via createBackup's own leaveStopped-aware pause) to take
 *  the full backup, restores into an isolated root and compares, then always restarts to the
 *  state it found the gateway in — its own single stop/start cycle, unrelated to any
 *  other check. This is what ROUND_TRIP_ENTRY runs, and what the tests beside this file call
 *  directly. */
async function roundTripCheck(ctx: Context): Promise<void> {
  // The initial service state is read before anything is touched. This read cannot
  // be compensated if it fails — but it is also the only thing that happens before the
  // first mutation, so a failure here aborts the check with the instance exactly as it
  // was found.
  const initialRunning = await reach("ask whether the gateway is running", () => ctx.runtime.isRunning());
  const { scratch, restored, isolated } = roundTripScratch(ctx);

  let bodyError: unknown;
  try {
    const witnesses = await collectRoundTripWitnesses(ctx);

    // FULL, not migrate: full is the only profile that keeps privatePaths, identity and
    // keys — the only restore that is a round trip.
    const archive = await reachVerdict("take the full backup", () =>
      createBackup(ctx, { profile: "full", leaveStopped: true, purpose: "internal" }),
    );

    await reachVerdict("restore the backup into the isolated root", () =>
      restoreArchive(isolated, archive, { force: true, noStart: true, internal: true }),
    );

    await compareRestoredWitnesses(ctx, restored, witnesses);
  } catch (error) {
    bodyError = error;
  }

  // Compensation, on every exit path: the scratch root is this check's own litter;
  // the gateway goes back to the state the check found it in.
  const compensationErrors: unknown[] = [];

  try {
    await runMaybePrivileged(ctx, scratch, "rm", ["-rf", scratch]);
  } catch (cleanupError) {
    compensationErrors.push(cleanupError);
  }

  if (initialRunning) {
    try {
      await ctx.runtime.start();
      await ctx.runtime.waitForHealth();
    } catch (startError) {
      compensationErrors.push(startError);
    }
  }
  // else: nothing between reading initialRunning and here can have started the gateway —
  // the backup only ever pauses it, and the restore runs with noStart against the no-op
  // runtime — so "stopped" already is the initial state.

  settleWithCompensation(bodyError, compensationErrors);
}

/** The round-trip check's offline shape: everything roundTripCheck() does AFTER an archive
 *  and its witnesses already exist, and none of it touches the gateway — used by
 *  runArchiveChecks() once the shared stop/start window has already produced both. The
 *  scratch root is still this call's own litter and is still cleaned up unconditionally. */
async function roundTripUsingArchive(ctx: Context, archive: string, witnesses: Map<string, string>): Promise<void> {
  const { scratch, restored, isolated } = roundTripScratch(ctx);

  let bodyError: unknown;
  try {
    await reachVerdict("restore the backup into the isolated root", () =>
      restoreArchive(isolated, archive, { force: true, noStart: true, internal: true }),
    );
    await compareRestoredWitnesses(ctx, restored, witnesses);
  } catch (error) {
    bodyError = error;
  }

  const compensationErrors: unknown[] = [];
  try {
    await runMaybePrivileged(ctx, scratch, "rm", ["-rf", scratch]);
  } catch (cleanupError) {
    compensationErrors.push(cleanupError);
  }

  settleWithCompensation(bodyError, compensationErrors);
}

/** A restart failure never hides behind a check that otherwise looked fine, and never
 *  replaces a verdict the check already reached either — the same never-swallow discipline
 *  settleWithCompensation() applies to the round-trip check's own cleanup, extended here to
 *  the whole shared window: a passed verdict downgrades to failed, anything already failed
 *  or could-not-check just gains the extra detail. */
function foldRestartFailure(result: SmokeResult, restartError: unknown): SmokeResult {
  if (restartError === undefined) return result;
  const note = `gateway restart failed after this check ran: ${describeError(restartError)}`;
  if (result.status === "passed") return { name: result.name, status: "failed", detail: note };
  return { ...result, detail: result.detail === undefined ? note : `${result.detail}; ${note}` };
}

/** The three archive checks in ONE stop window (see the header). The full backup
 *  serves both the reject-check and the round-trip restore; it and the share snapshot are
 *  taken independently so one failing does not block the other; verification runs after the
 *  restart. The checks stay exported individually for standalone use, each managing its own
 *  window. `wanted` is `selected`'s subset (--quick drops the round-trip): unselected = not
 *  run. */
export async function runArchiveChecks(ctx: Context, wanted: ReadonlySet<string>): Promise<SmokeResult[]> {
  const wantRejects = wanted.has(REJECTS_SECRETS_CHECK);
  const wantAccepts = wanted.has(ACCEPTS_SHARE_CHECK);
  const wantRoundTrip = wanted.has(ROUND_TRIP_CHECK);
  const names = [REJECTS_SECRETS_CHECK, ACCEPTS_SHARE_CHECK, ROUND_TRIP_CHECK].filter((name) => wanted.has(name));
  if (names.length === 0) return [];

  return guardedWith(ctx, "smoke archives", { breakLock: false }, async (): Promise<SmokeResult[]> => {
    let initialRunning: boolean;
    try {
      initialRunning = await reach("ask whether the gateway is running", () => ctx.runtime.isRunning());
    } catch (error) {
      // Nothing has been touched yet — the same boundary the standalone round-trip check's
      // own initial read draws: abort every archive check the same unanswered way
      // rather than guess at a starting state to restore later.
      return names.map((name) => toResult(name, error));
    }

    if (initialRunning) {
      log("stopping the gateway once for this run's archive-based checks");
      try {
        await reach("pause the gateway", () => ctx.runtime.pause());
      } catch (error) {
        // Never paused, so nothing to restart either — same as above.
        return names.map((name) => toResult(name, error));
      }
    }

    // From here the gateway is stopped (or was never running). Each artifact is attempted
    // independently so one failing does not block work that does not need it.
    let witnesses: Map<string, string> | undefined;
    let witnessError: unknown;
    if (wantRoundTrip) {
      try {
        witnesses = await collectRoundTripWitnesses(ctx);
      } catch (error) {
        witnessError = error;
      }
    }

    let fullArchive: string | undefined;
    let fullError: unknown;
    if (wantRejects || wantRoundTrip) {
      try {
        // FULL, not migrate: full is the only profile that keeps privatePaths, identity and
        // keys — the only archive the round-trip restore below is a genuine round trip of,
        // and the only one guaranteed to still carry whatever the reject-check needs to see
        // rejected. leaveStopped: true — this shared window restarts the gateway itself,
        // once, below; createBackup would otherwise restart it the moment this call returns.
        fullArchive = await reachVerdict("take the full backup", () => createBackup(ctx, { profile: "full", leaveStopped: true, purpose: "internal" }));
      } catch (error) {
        fullError = error;
      }
    }

    let shareError: unknown;
    if (wantAccepts) {
      try {
        // Same leaveStopped reasoning as the full backup above — and harmless either way
        // here, since createBackup()/pull() already skip re-pausing a gateway they find
        // already stopped (isRunning() is read fresh on every call).
        await pullSnapshot(ctx, "share", { leaveStopped: true, purpose: "internal" });
      } catch (error) {
        // pull's own die() IS the verdict — a rejected snapshot is a failed check, not an
        // unreachable instance. Anything else never got far enough to judge anything. Same
        // distinction the standalone check draws.
        shareError = error instanceof UserError && !(error instanceof TransportUnreachableError)
          ? error
          : new CouldNotCheck(`could not take a share snapshot: ${describeError(error)}`);
      }
    }

    let restartError: unknown;
    if (initialRunning) {
      try {
        log("starting the gateway again");
        await ctx.runtime.start();
        await ctx.runtime.waitForHealth();
        log("gateway is healthy");
      } catch (error) {
        restartError = error;
      }
    }

    // Offline from here: verification and the restore-diff never touch the gateway again.
    const results: SmokeResult[] = [];

    if (wantRejects) {
      const result = fullError !== undefined
        ? toResult(REJECTS_SECRETS_CHECK, fullError)
        : await evaluate(REJECTS_SECRETS_CHECK, async () => {
            const passed = await verifySnapshotQuietly(ctx, fullArchive as string, "share");
            expect(!passed, "the verifier accepted an archive containing credentials");
          });
      results.push(foldRestartFailure(result, restartError));
    }

    if (wantAccepts) {
      const result = shareError !== undefined ? toResult(ACCEPTS_SHARE_CHECK, shareError) : { name: ACCEPTS_SHARE_CHECK, status: "passed" as const };
      results.push(foldRestartFailure(result, restartError));
    }

    if (wantRoundTrip) {
      const priorError = witnessError ?? fullError;
      const result = priorError !== undefined
        ? toResult(ROUND_TRIP_CHECK, priorError)
        : await evaluate(ROUND_TRIP_CHECK, () => roundTripUsingArchive(ctx, fullArchive as string, witnesses as Map<string, string>));
      results.push(foldRestartFailure(result, restartError));
    }

    return results;
  }, { breakLockSupported: false });
}
