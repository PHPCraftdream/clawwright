// One instance, one change at a time.
//
// Several people can reach the same instance now — a coder, an agent through MCP, a cron
// job — and two applying at once is a real race: `apply` writes config, restarts, then
// re-provisions recipes over a window seconds long. Interleaved, the instance ends up in a
// state neither run planned, and both report success.
//
// The lock is a file on the target naming who has it and what they're doing — advisory
// (stops only commands that ask, but every mutating one does). A stale lock — or one of
// unknown death — is REPORTED, never silently taken. The one automatic exception: when the
// holder's own record proves it dead (boot identity, start time, PID namespace — see
// proveOwnerDead in lock-claim.ts), the next operation takes the lock over through the same
// audited path as --break-lock, printing one notice naming the replaced operation id. Taking
// one over is `--break-lock`, deliberately not `--force` (which
// MCP sets automatically from the caller's confirm argument) — reusing that name would let
// every confirmed tool call take over any lock another operation was holding.
//
// On-disk primitives live in lock-claim.ts; this file adds reentrancy (chainLocks/
// heldScopes) and the HeldLock handle.

import { renderAdvice } from "../../core/io/invocation/render.ts";
import { reportBlocking } from "../../core/io/log.ts";
import { command, manual, type Advice } from "../../core/io/invocation/advice.ts";
import { AsyncLocalStorage } from "node:async_hooks";

import { withMutationGuard } from "../../security/instance-mutation-guard.ts";
import { newOperationId } from "../../service/operations.ts";
import { startHeartbeat, type Heartbeat } from "./heartbeat.ts";
import {
  type LockHolder,
  type LockOptions,
  type LockOwnerIdentity,
  readLockOwnerIdentity,
  isLocalLockOwner,
  legacyByOwnerAdvice,
  STALE_AFTER_MS,
  HEARTBEAT_STALE_AFTER_MS,
  lockHome,
  lockPath,
  writeHolderRecord,
  claimOwnedLockDirectory,
  ownsLockGeneration,
  removeOwnedLock,
  readLockHolder,
  ageMs,
  heartbeatAgeMs,
  isStale,
  refusalMessage,
  unreadableLockMessage,
  acquireOrTakeOver,
  mintHolder,
  claimGenerationMarker,
  writeHolderOrRollback,
} from "./lock-claim.ts";
import { localLiveness, platformProbes } from "./process-identity.ts";
import { probeEntryExists } from "../transport/transport.ts";
import type { Context } from "../../core/context.ts";

export interface InstanceLockObservation {
  readonly state: "absent" | "live" | "dead" | "remote" | "unknown";
  readonly identitySource?: LockOwnerIdentity["identitySource"];
  readonly host?: string;
  readonly pid?: number;
  readonly startedAt?: string;
  readonly heartbeatAt?: string;
  readonly operation?: string;
  readonly ageMs?: number;
  readonly heartbeatAgeMs?: number;
  readonly next?: Advice;
  readonly nextActions?: readonly string[];
  readonly takeover: "none" | "explicit-break-lock" | "foreign-confirmation-required";
}

/** Read-only advice; never authorizes a takeover from elapsed time. */
export function instanceLockAdvice(lock: InstanceLockObservation): Advice {
  if (lock.identitySource === "legacy-by" && lock.host !== undefined) return manual(legacyByOwnerAdvice(lock.host));
  return lock.state === "dead" ? manual("owner proven dead; explicitly rerun the intended operation with --break-lock")
    : lock.state === "remote" ? manual(`verify the remote owner in its original PID namespace first; exact confirmation required: --break-foreign-lock ${JSON.stringify(lock.host ?? "<unavailable-host>")} together with --break-lock`)
    : lock.state === "live" ? command(["status", "--json"], { note: "wait for the owner; observes without takeover" })
    : lock.state === "unknown" ? manual("owner identity/read unavailable; do not break by age") : manual("no operation lock");
}

function lockObservation(lock: InstanceLockObservation): InstanceLockObservation {
  const next = instanceLockAdvice(lock);
  return { ...lock, next, nextActions: [renderAdvice(next)] };
}

/** Internal snapshot: the public projection and CAS owner come from one read. */
export interface InstanceLockSnapshot {
  readonly observation: InstanceLockObservation;
  readonly holder?: LockHolder;
}

/** No acquisition, heartbeat refresh or cleanup. Age is never owner-death evidence. */
export async function observeInstanceLockSnapshot(ctx: Context, now = Date.now()): Promise<InstanceLockSnapshot> {
  const unknown = lockObservation({ state: "unknown", takeover: "none" });
  let holder: LockHolder | undefined;
  try {
    if (!(await probeEntryExists(ctx.transport, lockPath(ctx)))) return { observation: lockObservation({ state: "absent", takeover: "none" }) };
    holder = await readLockHolder(ctx);
    if (holder === undefined) return { observation: unknown };
    const identity = readLockOwnerIdentity(holder);
    const time = (value: unknown): string | undefined => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
    const takenAt = time(holder.takenAt);
    const startedAt = identity === undefined ? undefined : time(identity.startedAt);
    const heartbeatAt = identity === undefined ? undefined : time(holder.heartbeatAt);
    const remote = identity !== undefined && !isLocalLockOwner(identity);
    const liveness = identity === undefined || remote ? "unknown" : await localLiveness({ machine: identity.host, pid: identity.pid, startedAt });
    const state = remote ? "remote" : liveness === "alive" ? "live" : liveness;
    return { holder, observation: lockObservation({
      state, identitySource: identity?.identitySource, host: identity?.host,
      pid: identity?.pid, startedAt, heartbeatAt,
      operation: typeof holder.what === "string" && holder.what.length <= 80 ? /^[a-z-]{1,40}(?=\s|$)/.exec(holder.what)?.[0] : undefined,
      ageMs: takenAt === undefined ? undefined : Math.max(0, now - Date.parse(takenAt)),
      heartbeatAgeMs: heartbeatAt === undefined ? undefined : Math.max(0, now - Date.parse(heartbeatAt)),
      takeover: state === "dead" ? "explicit-break-lock" : remote ? "foreign-confirmation-required" : "none",
    }) };
  } catch { return { holder, observation: unknown }; }
}

/** Public observation never exposes the raw owner record. */
export async function observeInstanceLock(ctx: Context, now = Date.now()): Promise<InstanceLockObservation> {
  return (await observeInstanceLockSnapshot(ctx, now)).observation;
}

export {
  STALE_AFTER_MS,
  HEARTBEAT_STALE_AFTER_MS,
  lockHome,
  lockPath,
  readLockHolder,
  ageMs,
  heartbeatAgeMs,
  isStale,
  refusalMessage,
  unreadableLockMessage,
};
export type { LockHolder, LockOptions };

export interface HeldLock {
  readonly holder: LockHolder;
  /** The resource this lock is on — what reentrancy is recognised by. */
  readonly path: string;
  readonly resource: string;
  release(): Promise<void>;
}

/** Stable resource identity for reentrancy: equal paths on different transports are different targets. */
function lockResource(ctx: Context): string {
  return `${ctx.transport.description}\u0000${lockPath(ctx)}`;
}

/** Which lock paths the current asynchronous chain holds. `apply` runs `provision-agent` as
 *  a step, which takes the lock on its own — without reentrancy recognition, apply would
 *  refuse itself. What nests is the chain: an operation's body runs inside the scope
 *  runOwning() gives it, and only a call about the same instance reads as reentrant. */
interface LockLease {
  released: boolean;
}

const chainLocks = new AsyncLocalStorage<Map<string, LockLease>>();
const heldScopes = new WeakMap<HeldLock, { scope: Map<string, LockLease>; lease: LockLease }>();

/** Whether the current asynchronous chain already holds this instance's lock. */
export function lockHeldHere(ctx: Context): boolean {
  const lease = chainLocks.getStore()?.get(lockResource(ctx));
  return lease !== undefined && lease.released !== true;
}

/** A strict verification failure is an unresolved ambiguity about a cleanup that may or may
 *  not have landed — never something a blind retry can settle, so it is never retried. */
class ReleaseVerificationError extends Error {}

/** Assembles the handle a caller releases; release() closes over this acquisition's own generation. */
function buildHeldLock(ctx: Context, holder: LockHolder, generation: string, heartbeat: Heartbeat, strictVerification = false): HeldLock {
  let releasing: Promise<void> | undefined;
  const resource = lockResource(ctx);
  let handle: HeldLock;
  handle = {
    holder,
    path: lockPath(ctx),
    resource,
    async release(): Promise<void> {
      if (releasing !== undefined) return releasing;

      const binding = heldScopes.get(handle);
      if (binding !== undefined) {
        binding.lease.released = true;
        if (binding.scope.get(resource) === binding.lease) binding.scope.delete(resource);
        heldScopes.delete(handle);
      }

      // Only ours, checked with one operation instead of two: read-then-remove left a gap
      // where a takeover completing in between had its fresh lock deleted by a release that
      // read the old holder. Ownership is answered by moving this acquisition's own
      // generation marker aside — atomic, and only we can still own that exact path.
      releasing = (async () => {
        // Drain before claiming the guard: a queued refresh may still need that guard
        // to observe cancellation, and an in-flight publication must finish before removal.
        await heartbeat.stop();
        // A live competing claim can hold the mutation guard for its whole acquisition window;
        // a single refused claim used to abandon cleanup of a lock we still own. The retry is
        // bounded and ends in a report - the guard hold is short, the cleanup idempotent (the
        // generation-marker claim is the compare-and-swap either way).
        let lastError: unknown;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 25));
          try {
            await withMutationGuard(ctx, async () => {
              const trash = await claimOwnedLockDirectory(ctx, generation);
              if (trash === undefined) {
                // The marker is gone: a takeover displaced this acquisition, so the lock is no
                // longer ours to remove. Still-present marker means cleanup is still owed.
                if (await ownsLockGeneration(ctx, generation)) throw new Error("owned instance lock release claim was not verified");
                return;
              }
              await removeOwnedLock(ctx, generation, trash);
              if (strictVerification && await probeEntryExists(ctx.transport, lockPath(ctx))) {
                throw new ReleaseVerificationError("instance lock release was not verified");
              }
            }, false, undefined, { strictVerification });
            return;
          } catch (error) {
            lastError = error;
            if (error instanceof ReleaseVerificationError) break;
          }
        }
        if (strictVerification) throw lastError;
        // Failed cleanup leaves a stale lock behind — reported loudly, never silently
        // swallowed: the next operation must be told it exists and must be broken manually.
        reportBlocking(
          `instance lock release failed to clean up ${lockPath(ctx)}; the stale lock must be reported or broken manually: ${(lastError as Error).message}`,
        );
      })();
      return releasing;
    },
  };
  return handle;
}

/** Takes the lock for the duration of an operation, or refuses. Each step (lock-claim.ts) runs
 *  in order: win or take over the directory, mint this acquisition's identity, stake its
 *  generation marker, publish holder.json, start its heartbeat, hand back the release handle. */
async function takeLockClaim(
  ctx: Context,
  what: string,
  operationId: string,
  options: LockOptions = {},
): Promise<HeldLock> {
  await acquireOrTakeOver(ctx, options);

  // Recorded beside the holder so a later reader can prove this acquisition dead if it dies.
  const [bootId, start] = await Promise.all([
    platformProbes.bootIdentity(),
    platformProbes.processStartIdentity(process.pid),
  ]);
  const { generation, holder } = mintHolder(what, operationId, bootId, start);
  await claimGenerationMarker(ctx, generation);
  await writeHolderOrRollback(ctx, generation, holder);

  // Refreshes heartbeatAt on an interval for as long as this acquisition is held — the fix
  // for STALE_AFTER_MS alone reading a live `recipe install` as abandoned mid-build.
  const heartbeat = startHeartbeat(ctx, generation, readLockHolder, writeHolderRecord);

  return buildHeldLock(ctx, holder, generation, heartbeat, options.strictVerification);
}

/** Serializes every path-changing claim from the initial read through holder publication. */
export async function takeLock(
  ctx: Context,
  what: string,
  operationId: string,
  options: LockOptions = {},
): Promise<HeldLock> {
  let held: HeldLock | undefined;
  try {
    return await withMutationGuard(
      ctx,
      async () => {
        held = await takeLockClaim(ctx, what, operationId, options);
        return held;
      },
      options.breakLock === true,
      options.breakForeignLockHost,
      { strictVerification: options.strictVerification },
    );
  } catch (error) {
    // Guard cleanup can fail after acquisition, before the caller receives the handle.
    // Stop its heartbeat and attempt only ownership-checked release; retain the original error.
    if (held !== undefined) await held.release().catch(() => {});
    throw error;
  }
}

/** Runs `body` holding the lock, and releases it whatever happens — including when the body
 *  throws, which is the case that matters: a failed operation that keeps the lock blocks the
 *  very command someone would run next to fix it. */
export async function withInstanceLock<T>(
  ctx: Context,
  what: string,
  operationId: string,
  options: LockOptions,
  body: (held: HeldLock) => Promise<T>,
): Promise<T> {
  const held = await takeLock(ctx, what, operationId, options);
  try {
    return await runOwning(held, () => body(held));
  } finally {
    await held.release();
  }
}

/** Runs `body` as the chain that owns `held`'s lock: everything `body` calls recognises the
 *  hold until `body` settles. Releasing stays in the caller's own finally. `held === undefined`
 *  is the nested shape: the calling chain is already inside the owning operation's scope. */
export async function runOwning<T>(held: HeldLock | undefined, body: () => Promise<T>): Promise<T> {
  if (held === undefined) return body();
  const scope = new Map(chainLocks.getStore() ?? []);
  const lease: LockLease = { released: false };
  scope.set(held.resource, lease);
  heldScopes.set(held, { scope, lease });
  try {
    return await chainLocks.run(scope, body);
  } finally {
    lease.released = true;
    if (scope.get(held.resource) === lease) scope.delete(held.resource);
    if (heldScopes.get(held)?.scope === scope) heldScopes.delete(held);
  }
}

/** The command-level shape: hold the lock for the duration of `body` unless the calling
 *  chain already does. `provision-agent` under `apply`, `apply --set` under `rollback
 *  --previous-set`, `set forget` under `apply` — each takes the lock when someone invoked
 *  it directly and rides its caller's when it runs as a step. */
export async function withLockUnlessHeld<T>(
  ctx: Context,
  what: string,
  operationId: string,
  options: LockOptions,
  body: () => Promise<T>,
): Promise<T> {
  if (lockHeldHere(ctx)) return body();
  const held = await takeLock(ctx, what, operationId, options);
  try {
    return await runOwning(held, body);
  } finally {
    await held.release();
  }
}

/** The takeover a call asked for: `--break-lock`, and the host id of `--break-foreign-lock`. */
export interface LockTakeover {
  readonly breakLock: boolean;
  readonly breakForeignLockHost?: string;
}

/** What every mutating command wraps its work in, with the takeover already bound. Nested calls
 *  are a no-op. `options.breakLockSupported` is the one thing a call site still states
 *  explicitly, for a command whose parser refuses --break-lock. */
export async function guardedWith<T>(
  ctx: Context,
  what: string,
  takeover: LockTakeover,
  body: () => Promise<T>,
  options: { breakLockSupported?: boolean } = {},
): Promise<T> {
  return withLockUnlessHeld(
    ctx,
    what,
    newOperationId(what),
    {
      breakLock: takeover.breakLock,
      breakLockSupported: options.breakLockSupported,
      breakForeignLockHost: takeover.breakForeignLockHost,
    },
    body,
  );
}

