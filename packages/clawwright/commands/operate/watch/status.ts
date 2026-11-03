// `clawwright watch status` — the persisted last state, when it changed, whether an alert
// webhook/heartbeat is configured, when `watch check` last ran, the most recent
// config/delivery error, an undelivered alert, and whether the schedule looks stale.
// Never either URL itself, in any form: only booleans and (for the heartbeat) the last
// successful ping time and last failure detail.

import { info, log, warn } from "../../../core/io/log.ts";
import { commandLine } from "../../../core/io/invocation/render.ts";
import { emit, isCaptured } from "../../../core/io/output.ts";
import type { Context } from "../../../core/context.ts";
import { defineAction, type Values } from "../../../core/command/index.ts";
import { readScheduledWatchState } from "./state.ts";
import { codeDiff, describeTransition, watchHeartbeatUrlRaw, watchWebhookRaw } from "./webhook.ts";
import { WATCH_CHECK_ARGUMENTS } from "./check.ts";
import { DEFAULT_WATCH_INTERVAL_MINUTES } from "./install.ts";

// How many missed intervals before "stale" fires — one alone could just be a slow cycle or
// scheduler jitter; three in a row means the scheduled check itself likely stopped running.
const STALE_GRACE_MULTIPLIER = 3;

/** Minutes since the last INVOKED run (lastRunAt — every cycle, config error or not), or
 *  checkedAt for a state file written before lastRunAt existed. Undefined when watch check
 *  has never run at all: "stale" does not apply to a check that was never scheduled. */
function referenceTime(lastRunAt: string | undefined, checkedAt: string | undefined): string | undefined {
  return lastRunAt ?? checkedAt;
}

function staleThresholdMinutes(intervalMinutes: number | undefined): number {
  return (intervalMinutes ?? DEFAULT_WATCH_INTERVAL_MINUTES) * STALE_GRACE_MULTIPLIER;
}

function isStale(reference: string | undefined, intervalMinutes: number | undefined): boolean {
  if (reference === undefined) return false;
  const last = Date.parse(reference);
  if (!Number.isFinite(last)) return false;
  return Date.now() - last > staleThresholdMinutes(intervalMinutes) * 60_000;
}

export const NO_CHECK_YET = "watch: no check has run yet";
export const NO_SUCCESSFUL_CYCLE_YET = "watch: no successful check cycle yet";
export const LAST_ERROR_PREFIX = "last error: ";

export function watchLevelLine(level: string): string {
  return `watch: ${level}`;
}

export function staleRunLine(lastRunAt: string, thresholdMinutes: number): string {
  return (
    `last run was ${lastRunAt} — over ${thresholdMinutes} minutes ago; the scheduled check may not be ` +
    `running (see ${commandLine(["watch", "install"])}, or ${commandLine(["watch", "test"])} to check delivery)`
  );
}

export function alertPendingLine(since: string, transition: string): string {
  return `alert pending since ${since}: ${transition} has not been delivered yet`;
}

async function runStatus(ctx: Context, values: Values<typeof WATCH_CHECK_ARGUMENTS>): Promise<void> {
  const jsonOnly = values.json === true;

  const { state, location, known } = await readScheduledWatchState(ctx);
  const webhookConfigured = watchWebhookRaw(ctx) !== undefined;
  const heartbeatConfigured = watchHeartbeatUrlRaw(ctx) !== undefined;
  const lastRunAt = referenceTime(state?.lastRunAt, state?.checkedAt);
  const thresholdMinutes = staleThresholdMinutes(state?.intervalMinutes);
  const stale = isStale(lastRunAt, state?.intervalMinutes);

  if (jsonOnly || isCaptured()) {
    emit(
      `${JSON.stringify(
        {
          historyLocation: location,
          historyKnown: known,
          level: state?.level ?? null,
          reasons: state?.reasons ?? [],
          checkedAt: state?.checkedAt ?? null,
          changedAt: state?.changedAt ?? null,
          lastRunAt: lastRunAt ?? null,
          lastError: state?.lastError ?? null,
          alertPending: state?.alertPending ?? null,
          intervalMinutes: state?.intervalMinutes ?? null,
          staleThresholdMinutes: known ? thresholdMinutes : null,
          stale: known ? stale : null,
          webhookConfigured,
          heartbeatConfigured,
          heartbeatAt: state?.heartbeatAt ?? null,
          heartbeatError: state?.heartbeatError ?? null,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  info(`watch history: ${location}`);
  if (!known) {
    warn("watch: scheduled history unknown — storage machine unavailable or history unreadable; no local history substituted");
    return;
  }
  if (lastRunAt === undefined) {
    log(NO_CHECK_YET);
    info(`run ${commandLine(["watch", "check"])}, or schedule it with ${commandLine(["watch", "install"])}`);
  } else if (state?.level === undefined) {
    log(NO_SUCCESSFUL_CYCLE_YET);
    info(`last run      ${lastRunAt}`);
  } else {
    log(watchLevelLine(state.level));
    if (state.checkedAt !== undefined) info(`last checked  ${state.checkedAt}`);
    if (state.changedAt !== undefined) info(`last changed  ${state.changedAt}`);
    if (state.lastRunAt !== undefined && state.lastRunAt !== state.checkedAt) info(`last run      ${state.lastRunAt}`);
    for (const reason of state.reasons ?? []) info(`${reason.code}  ${reason.detail}`);
  }
  if (stale) {
    warn(staleRunLine(lastRunAt ?? "", thresholdMinutes));
  }
  if (state?.lastError !== undefined) warn(`${LAST_ERROR_PREFIX}${state.lastError}`);
  if (state?.alertPending !== undefined) {
    const pending = state.alertPending;
    // fromCodes/toCodes are absent on a state file predating this field, or for a pure
    // level transition from "ok" (which never has reasons) — codeDiff then answers empty on
    // both sides, and describeTransition falls back to the plain "from → to" it always did.
    const { added, cleared } = codeDiff(pending.fromCodes ?? [], pending.toCodes ?? []);
    warn(alertPendingLine(pending.since, describeTransition(pending.from, pending.to, added, cleared)));
  }
  info(`webhook: ${webhookConfigured ? "configured" : "not configured"}`);
  info(`heartbeat: ${heartbeatConfigured ? "configured" : "not configured"}${state?.heartbeatAt ? `, last ping ${state.heartbeatAt}` : ""}`);
  if (state?.heartbeatError) warn(`heartbeat: last ping failed — ${state.heartbeatError}`);
}

/** The `watch status` action: reads the persisted state and the schedule, never the URLs. */
export const WATCH_STATUS = defineAction({
  summary: "The persisted last state, delivery errors and schedule staleness",
  arguments: WATCH_CHECK_ARGUMENTS,
  run: runStatus,
});
