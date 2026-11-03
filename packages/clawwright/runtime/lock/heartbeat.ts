// The holder refreshes its own lock record while it lives, so a build that legitimately runs
// past STALE_AFTER_MS is never read as abandoned — only a stopped heartbeat means that now
// (isStale in instance-lock.ts reads heartbeatAt over takenAt once a record has one).
//
// Dependency-injected rather than importing instance-lock.ts's own readLockHolder/holderPath:
// this module only needs "read the current holder" and "write it back", and taking those as
// parameters keeps the two files from importing each other's values.

import { info } from "../../core/io/log.ts";
import { withMutationGuard } from "../../security/instance-mutation-guard.ts";
import type { Context } from "../../core/context.ts";
import type { LockHolder } from "./instance-lock.ts";

/** How often the holder rewrites heartbeatAt. Far below HEARTBEAT_STALE_AFTER_MS (instance-
 *  lock.ts) so a handful of missed writes in a row still reads as alive. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Swappable for checks: a real 30s interval has no place in a fast, deterministic unit check
 *  — the same "swappable for checks" idiom as process-identity.ts's platformProbes. A check
 *  replaces `schedule` with a stand-in it fires and awaits on demand, exercising refresh
 *  and release interleavings without waiting for the wall clock. */
export const heartbeatScheduler = {
  schedule(tick: () => Promise<void>, intervalMs: number): TimerHandle {
    const timer = setInterval(tick, intervalMs);
    // Never keeps the process alive on its own — a command that finished its real work must
    // not hang around for a lock heartbeat.
    timer.unref();
    return timer;
  },
  cancel(timer: TimerHandle): void {
    clearInterval(timer as Parameters<typeof clearInterval>[0]);
  },
};

/** Opaque timer handle: keeps `@types/node` out of the published typings. */
export type TimerHandle = object;

export type ReadHolder = (ctx: Context) => Promise<LockHolder | undefined>;
export type WriteHolder = (ctx: Context, holder: LockHolder) => Promise<void>;

/** Stops future ticks and drains the current refresh; call before taking the removal guard. */
export interface Heartbeat {
  stop(): Promise<void>;
}

/** Checks ownership and publishes under the acquisition/release guard. */
export async function refreshHeartbeat(
  ctx: Context,
  generation: string,
  readHolder: ReadHolder,
  writeHolder: WriteHolder,
  active: () => boolean = () => true,
): Promise<void> {
  if (!active()) return;
  await withMutationGuard(ctx, async () => {
    if (!active()) return;
    const current = await readHolder(ctx);
    if (!active() || current === undefined || current.generation !== generation) return;
    await writeHolder(ctx, { ...current, heartbeatAt: new Date().toISOString() });
  });
}

/** Runs one refresh at a time; failed attempts retry on the next tick. */
export function startHeartbeat(
  ctx: Context,
  generation: string,
  readHolder: ReadHolder,
  writeHolder: WriteHolder,
): Heartbeat {
  let stopped = false;
  let failureLogged = false;
  let pending: Promise<void> | undefined;
  const timer = heartbeatScheduler.schedule(() => {
    if (stopped) return Promise.resolve();
    if (pending !== undefined) return pending;
    pending = refreshHeartbeat(ctx, generation, readHolder, writeHolder, () => !stopped).catch((error: unknown) => {
      if (failureLogged) return;
      failureLogged = true;
      if (process.env.OC_DEBUG === "1") {
        const message = error instanceof Error ? error.message : String(error);
        info(`instance lock heartbeat refresh failed — retrying silently from here on: ${message}`);
      }
    }).finally(() => { pending = undefined; });
    return pending;
  }, HEARTBEAT_INTERVAL_MS);
  return {
    async stop(): Promise<void> {
      if (!stopped) {
        stopped = true;
        heartbeatScheduler.cancel(timer);
      }
      await pending;
    },
  };
}
