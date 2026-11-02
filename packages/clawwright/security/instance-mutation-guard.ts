import { randomBytes } from "node:crypto";

import { locksDir } from "../core/env.ts";
import type { Context } from "../core/context.ts";
import { probeEntryExists, type ExecResult } from "../runtime/transport/transport.ts";
import { docsUrl } from "../core/io/docs-url.ts";
import { machineName, removeEmptyDirectory } from "../runtime/lock/process-identity.ts";

export interface MutationOwner {
  readonly generation: string;
  readonly pid: number;
  readonly machine: string;
  readonly takenAt: string;
}

function guardPath(ctx: Context): string {
  return `${locksDir(ctx.settings.dataDir)}/operation.mutation`;
}

function ownerPath(ctx: Context): string {
  return `${guardPath(ctx)}/owner.json`;
}

function claimPath(ctx: Context, generation: string): string {
  return `${guardPath(ctx)}/.claim-${generation}`;
}

/** Where a confirmed foreign takeover is recorded — beside the guard, never inside it, since
 *  the guard directory is removed once the takeover completes and this record must survive
 *  that. One append-only file for the deployment's whole history, rare enough to read by hand. */
function foreignTakeoverLog(ctx: Context): string {
  return `${locksDir(ctx.settings.dataDir)}/foreign-lock-takeovers.jsonl`;
}

/** Who a foreign-lock takeover is recorded as — shared with the check that reads the log. */
export function foreignTakeoverBy(): string {
  return `${process.env.USERNAME ?? process.env.USER ?? "unknown"}@${machineName()} pid ${process.pid}`;
}

/** Best-effort append: a confirmed override of someone else's orphaned guard must not go
 *  unrecorded when writable, but must never be the reason the takeover itself fails. */
async function recordForeignTakeover(ctx: Context, confirmedHost: string, foreignOwner: MutationOwner): Promise<void> {
  const entry = {
    at: new Date().toISOString(),
    by: foreignTakeoverBy(),
    confirmedHost,
    foreignOwner,
  };
  const path = foreignTakeoverLog(ctx);
  let existing = "";
  try {
    existing = await ctx.transport.readFile(path);
  } catch {
    // First takeover ever recorded for this deployment.
  }
  try {
    await ctx.transport.writeFile(path, `${existing}${JSON.stringify(entry)}\n`);
  } catch {
    // Best-effort audit trail: it must never be the reason a confirmed takeover fails.
  }
}

async function writeExclusive(ctx: Context, path: string, content: string): Promise<boolean> {
  const temporary = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    await ctx.transport.writeFile(temporary, content);
    const linked = await ctx.transport.exec("ln", [temporary, path], { allowFailure: true });
    return linked.code === 0;
  } finally {
    await ctx.transport.remove(temporary).catch(() => {});
  }
}

async function claims(ctx: Context): Promise<string[]> {
  const files = await ctx.transport.listFiles(guardPath(ctx));
  return files
    .filter((file) => /^\.claim-[a-f0-9]+$/.test(file))
    .map((file) => `${guardPath(ctx)}/${file}`);
}

async function readOwner(ctx: Context, path: string): Promise<MutationOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await ctx.transport.readFile(path));
    if (typeof value !== "object" || value === null) return undefined;
    const owner = value as Partial<MutationOwner>;
    if (typeof owner.generation !== "string" || !Number.isInteger(owner.pid) || owner.pid! <= 0 ||
        typeof owner.machine !== "string" || typeof owner.takenAt !== "string") return undefined;
    return owner as MutationOwner;
  } catch {
    return undefined;
  }
}

function processIsAlive(owner: MutationOwner): boolean | undefined {
  if (owner.machine !== machineName()) return undefined;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return undefined;
  }
}

/** The refusal a caller sees while another instance-lock change owns the mutation guard.
 *  Exported so the checks can assert the whole message, advice included. */
export function mutationBusyMessage(path: string, owner?: MutationOwner): Error {
  const identity = owner === undefined ? "an unnamed operation" : `pid ${owner.pid} on ${owner.machine}`;
  const advice = owner === undefined
    ? "if no lock change is active, retry with --break-lock"
    : owner.machine === machineName()
      ? "wait for it to finish"
      // A remote pid's liveness can't be checked from here — names the exact flag/host to use.
      : `check whether it is still running on ${owner.machine}; if that process is gone, rerun with ` +
        `--break-foreign-lock ${owner.machine} (see ${docsUrl("architecture.md")}, instance lock)`;
  return new Error(`another instance-lock change is in progress at ${path} (${identity}); ${advice}`);
}

/** Failure exit from anywhere the marker exists: drop it (best effort), then raise `error`.
 *  Never resolves — always throws — so callers can `await` it mid-branch. */
async function abortClaim(ctx: Context, marker: string, error: unknown): Promise<never> {
  await ctx.transport.remove(marker).catch(() => {});
  throw error;
}

/** The uncontested path: nobody held `guard` a moment ago, so this `mkdir` alone is the win.
 *  Publishes the marker as owner and drops it; any failure gives the guard directory back
 *  rather than leaving an empty one behind. */
async function claimFreshGuard(
  ctx: Context,
  guard: string,
  marker: string,
  content: string,
  candidate: MutationOwner,
): Promise<MutationOwner> {
  try {
    const written = await writeExclusive(ctx, marker, content);
    const linked = written && (await ctx.transport.exec("ln", [marker, ownerPath(ctx)], { allowFailure: true })).code === 0;
    if (linked) {
      await ctx.transport.remove(marker).catch(() => {});
      return candidate;
    }
  } catch (error) {
    await removeEmptyDirectory(ctx, guard);
    throw error;
  }
  await ctx.transport.remove(marker).catch(() => {});
  await removeEmptyDirectory(ctx, guard);
  throw mutationBusyMessage(guard, await readOwner(ctx, ownerPath(ctx)));
}

/** Whether an existing guard can be taken over, before any marker is written: a live owner
 *  always refuses; a dead one is free; a foreign one needs `breakForeignLockHost` to match
 *  its recorded machine exactly. Returns whether this is a confirmed foreign takeover. */
function resolveGuardOwner(
  guard: string,
  current: MutationOwner | undefined,
  breakLock: boolean,
  breakForeignLockHost: string | undefined,
): boolean {
  if (current === undefined) {
    if (!breakLock) throw mutationBusyMessage(guard);
    return false;
  }
  const alive = processIsAlive(current);
  if (alive === true) throw mutationBusyMessage(guard, current);
  if (alive === undefined) {
    // processIsAlive returns undefined for two reasons: a genuinely foreign machine, or a
    // probe error on THIS machine that proves nothing. Only the first is what
    // --break-foreign-lock is for — an owner already recorded as this machine is never
    // treated as foreign.
    if (current.machine === machineName() || breakForeignLockHost === undefined) throw mutationBusyMessage(guard, current);
    if (breakForeignLockHost !== current.machine) {
      throw new Error(
        `refusing to take over the instance-lock guard at ${guard}: its recorded owner is on ` +
          `"${current.machine}", not "${breakForeignLockHost}" — pass the exact host to confirm, or leave it alone`,
      );
    }
    // Confirmed: an explicit, host-matched operator override, never automatic.
    return true;
  }
  // alive === false: proven dead on this machine, recoverable regardless of any flag — unlike
  // the outer instance lock (instance-lock.ts), which still requires --break-lock even then.
  return false;
}

/** Removes every other live claim this run can see before it can safely proceed: a live or
 *  unverifiable competitor refuses outright, a provably dead one is dropped in place. */
async function retireDeadCompetitors(
  ctx: Context,
  guard: string,
  marker: string,
  current: MutationOwner | undefined,
): Promise<void> {
  let otherClaims: string[] = [];
  try {
    otherClaims = (await claims(ctx)).filter((path) => path !== marker);
  } catch (error) {
    await abortClaim(ctx, marker, error);
  }
  for (const other of otherClaims) {
    const otherOwner = await readOwner(ctx, other);
    const alive = otherOwner === undefined ? undefined : processIsAlive(otherOwner);
    if (alive === true || alive === undefined) await abortClaim(ctx, marker, mutationBusyMessage(guard, otherOwner ?? current));
    await ctx.transport.remove(other).catch(() => {});
  }
}

/** Parks the guard's current owner.json aside so publishClaim can replace it — refuses if the
 *  owner moved since it was read or if parking itself fails. */
async function parkCurrentOwner(
  ctx: Context,
  guard: string,
  marker: string,
  current: MutationOwner,
  ownerFile: string,
): Promise<void> {
  const latest = await readOwner(ctx, ownerFile);
  if (latest?.generation !== current.generation) await abortClaim(ctx, marker, mutationBusyMessage(guard, latest));
  const parked = `${guard}/.stale-owner-${current.generation}`;
  const moved = await ctx.transport.exec("mv", [ownerFile, parked], { allowFailure: true });
  if (moved.code !== 0) await abortClaim(ctx, marker, mutationBusyMessage(guard, await readOwner(ctx, ownerFile)));
}

/** No current owner, but other claim markers were left behind — an ownerless guard is only
 *  free once every one of them is proven dead; one retired claim is enough to proceed. */
async function retireStaleUnclaimedMarkers(ctx: Context, guard: string, marker: string): Promise<void> {
  let staleClaims: string[] = [];
  try {
    staleClaims = (await claims(ctx)).filter((path) => path !== marker);
  } catch (error) {
    await abortClaim(ctx, marker, error);
  }
  if (staleClaims.length === 0) return;
  let claimed = false;
  for (const staleClaim of staleClaims) {
    const staleOwner = await readOwner(ctx, staleClaim);
    if (staleOwner !== undefined && processIsAlive(staleOwner) !== false) continue;
    const retired = `${guard}/.retired-claim-${randomBytes(6).toString("hex")}`;
    const moved = await ctx.transport.exec("mv", [staleClaim, retired], { allowFailure: true });
    if (moved.code === 0) {
      await ctx.transport.remove(retired).catch(() => {});
      claimed = true;
      break;
    }
  }
  if (!claimed) await abortClaim(ctx, marker, mutationBusyMessage(guard));
}

/** Publishes the marker as owner.json via `ln`, rolling the parked stale owner back if that
 *  fails — a failed publish must leave *something* readable as owner. */
async function publishClaim(
  ctx: Context,
  guard: string,
  marker: string,
  ownerFile: string,
  current: MutationOwner | undefined,
  confirmedForeignTakeover: boolean,
  breakForeignLockHost: string | undefined,
  candidate: MutationOwner,
): Promise<MutationOwner> {
  const published = await ctx.transport.exec("ln", [marker, ownerFile], { allowFailure: true });
  if (published.code !== 0) {
    if (current !== undefined) {
      const parked = `${guard}/.stale-owner-${current.generation}`;
      const restored = await ctx.transport.exec("ln", [parked, ownerFile], { allowFailure: true });
      if (restored.code === 0) await ctx.transport.remove(parked).catch(() => {});
    }
    if (await readOwner(ctx, ownerFile) !== undefined) await ctx.transport.remove(marker).catch(() => {});
    throw mutationBusyMessage(guard, await readOwner(ctx, ownerFile));
  }
  await ctx.transport.remove(marker).catch(() => {});
  if (current !== undefined) await ctx.transport.remove(`${guard}/.stale-owner-${current.generation}`).catch(() => {});
  if (confirmedForeignTakeover && current !== undefined && breakForeignLockHost !== undefined) {
    await recordForeignTakeover(ctx, breakForeignLockHost, current);
  }
  return candidate;
}

/** The contested path: `guard` already exists, so winning it means proving its current owner
 *  is takeable, staking a claim marker, clearing every other claim, and publishing over
 *  whatever was there. */
async function claimExistingGuard(
  ctx: Context,
  guard: string,
  acquired: ExecResult,
  generation: string,
  content: string,
  candidate: MutationOwner,
  breakLock: boolean,
  breakForeignLockHost: string | undefined,
): Promise<MutationOwner> {
  const exists = await ctx.transport.exec("test", ["-d", guard], { allowFailure: true });
  if (exists.code !== 0) throw new Error(`could not serialize instance-lock changes at ${guard}: ${(acquired.stderr || acquired.stdout).trim()}`);

  const ownerFile = ownerPath(ctx);
  const current = await readOwner(ctx, ownerFile);
  const confirmedForeignTakeover = resolveGuardOwner(guard, current, breakLock, breakForeignLockHost);

  const marker = claimPath(ctx, generation);
  if (!(await writeExclusive(ctx, marker, content))) throw mutationBusyMessage(guard, current);

  await retireDeadCompetitors(ctx, guard, marker, current);
  if (current !== undefined) {
    await parkCurrentOwner(ctx, guard, marker, current, ownerFile);
  } else {
    await retireStaleUnclaimedMarkers(ctx, guard, marker);
  }

  return publishClaim(ctx, guard, marker, ownerFile, current, confirmedForeignTakeover, breakForeignLockHost, candidate);
}

async function claim(ctx: Context, breakLock: boolean, breakForeignLockHost?: string): Promise<MutationOwner | undefined> {
  const homePath = locksDir(ctx.settings.dataDir);
  const home = await ctx.transport.exec("mkdir", ["-p", homePath], { allowFailure: true });
  if (home.code !== 0) {
    const homeExists = await ctx.transport.exec("test", ["-d", homePath], { allowFailure: true });
    if (homeExists.code !== 0) return undefined;
  }

  const guard = guardPath(ctx);
  const generation = randomBytes(12).toString("hex");
  const candidate: MutationOwner = { generation, pid: process.pid, machine: machineName(), takenAt: new Date().toISOString() };
  const content = `${JSON.stringify(candidate)}\n`;
  const acquired = await ctx.transport.exec("mkdir", [guard], { allowFailure: true });

  if (acquired.code === 0) return claimFreshGuard(ctx, guard, claimPath(ctx, generation), content, candidate);

  // A failed mkdir followed by an absent guard means the previous owner RELEASED between our
  // mkdir and the follow-up — the guard vanished under us, not "someone else holds it". Retry
  // immediately and boundedly: the plain mkdir is the same atomic primitive the fresh path
  // uses, so winning a retry is a genuinely fresh claim, and falling through to the existing
  // paths when it loses is exactly today's behavior.
  let attempt: ExecResult = acquired;
  for (let tries = 0; tries < 3; tries++) {
    const present = await ctx.transport.exec("test", ["-d", guard], { allowFailure: true });
    if (present.code === 0) break; // Someone holds the guard after all — contested path.
    attempt = await ctx.transport.exec("mkdir", [guard], { allowFailure: true });
    if (attempt.code === 0) return claimFreshGuard(ctx, guard, claimPath(ctx, generation), content, candidate);
  }

  return claimExistingGuard(ctx, guard, attempt, generation, content, candidate, breakLock, breakForeignLockHost);
}

async function release(ctx: Context, owner: MutationOwner): Promise<void> {
  const current = await readOwner(ctx, ownerPath(ctx));
  if (current?.generation !== owner.generation) return;
  await ctx.transport.remove(ownerPath(ctx)).catch(() => {});
  await removeEmptyDirectory(ctx, guardPath(ctx));
}

/** Runs a lock-state mutation under the shared, recoverable mutation guard.
 *  `breakForeignLockHost` is the exact host id an operator has confirmed as the orphaned
 *  owner's machine — never inferred, never automatic. A mismatch refuses; a match takes over
 *  and records who did it, when, and which foreign owner it replaced. */
export async function withMutationGuard<T>(
  ctx: Context,
  body: () => Promise<T>,
  breakLock = false,
  breakForeignLockHost?: string,
  options: { strictVerification?: boolean } = {},
): Promise<T> {
  const owner = await claim(ctx, breakLock, breakForeignLockHost);
  if (owner === undefined) {
    if (options.strictVerification) throw new Error("mutation guard acquisition was not verified");
    return body();
  }
  if (!options.strictVerification) {
    try {
      return await body();
    } finally {
      await release(ctx, owner);
    }
  }

  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    const published = await readOwner(ctx, ownerPath(ctx));
    if (published?.generation !== owner.generation || published.pid !== process.pid ||
        published.machine !== machineName() || published.takenAt !== owner.takenAt ||
        (await ctx.transport.exec("test", ["-d", guardPath(ctx)], { allowFailure: true })).code !== 0) {
      throw new Error("published mutation guard ownership was not verified");
    }
    outcome = { ok: true, value: await body() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  let cleanupFailure: { error: unknown } | undefined;
  try {
    await release(ctx, owner);
    if (await probeEntryExists(ctx.transport, guardPath(ctx))) {
      throw new Error("mutation guard release/quiescence was not verified");
    }
  } catch (error) {
    cleanupFailure = { error };
  }
  if (!outcome.ok) throw outcome.error;
  if (cleanupFailure !== undefined) throw cleanupFailure.error;
  return outcome.value;
}
