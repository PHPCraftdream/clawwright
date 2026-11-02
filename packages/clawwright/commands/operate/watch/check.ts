// `clawwright watch check` — one probe cycle: reuse `inspect`'s own gatherer (same probes,
// same problem codes), keep only findings that say whether the instance is doing its job,
// add watch's own channel/disk findings (health.ts), and alert exactly on a change.
//
// Also owns `watch test` (WATCH_TEST, below runWatchCycle): the same webhook/heartbeat
// targets, sent a one-off test message instead of a real transition, so delivery can be
// proven before an outage is the first time it is tried.

import { log, info, warn, die, maskSecrets } from "../../../core/io/log.ts";
import { emit, isCaptured } from "../../../core/io/output.ts";
import { gatherInspection } from "../../orchestration/inspect/gather.ts";
import type { Inspection, Problem, ProblemCode, ChannelsStatusResponse } from "../../../service/inspection.ts";
import type { Context } from "../../../core/context.ts";
import { readWatchState, writeWatchState, withWatchStateLock, withOperatorWatchState } from "./state.ts";
import type { WatchLevel, WatchReason, WatchState } from "./state.ts";
import {
  WATCH_HEARTBEAT_URL_ENV,
  WATCH_WEBHOOK_ENV,
  codeDiff,
  describeTransition,
  parseHeartbeatUrl,
  parseWebhookUrl,
  postHeartbeat,
  postTestAlert,
  postWebhookAlert,
  resolveWebhookTarget,
  transitionPayload,
  watchHeartbeatUrlRaw,
  watchWebhookRaw,
} from "./webhook.ts";
import type { WatchWebhookTarget } from "./webhook.ts";
import { channelFindings, diskFindings, mergeFindings } from "./health.ts";
import { bind, defineAction, tokenize, type ArgumentSpec, type Values } from "../../../core/command/index.ts";

/** Drives both watch check's own slice of watch's declaration — shared by the status and
 *  test actions, which read --json the same way. */
export const WATCH_CHECK_ARGUMENTS = [
  { name: "json", description: "Emit JSON instead of text", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

/** The subset of `inspect`'s problem codes that say something about LIVENESS — the gateway
 *  answering, bootstrapped, reaching its own configured endpoints. Deliberately narrower
 *  than full inspection: CONFIG_DRIFT etc. are real findings `doctor` owns, but none mean
 *  the instance stopped doing its job. PROVIDER_MISSING is excluded: env-keyed/subscription
 *  providers read as missing, which here would be a permanent false "degraded". */
const LIVENESS_CODES: ReadonlySet<ProblemCode> = new Set([
  "NOT_BOOTSTRAPPED",
  "TARGET_UNREACHABLE",
  "GATEWAY_DOWN",
  "GATEWAY_UNHEALTHY",
  "EGRESS_UNREACHABLE",
  "CHANNEL_UNKNOWN",
  "CHANNEL_PROXY_DOWN",
]);

/** Blocking-severity liveness findings mean the instance is not doing its job at all
 *  ("down"); warning-severity ones mean it is serving but impaired ("degraded") — the same
 *  severity `service/inspection.ts` already assigns each code, read rather than re-decided
 *  here, so this cannot disagree with what `doctor` calls blocking. */
export function watchLevel(problems: readonly Problem[]): { level: WatchLevel; reasons: WatchReason[] } {
  const relevant = problems.filter((entry) => LIVENESS_CODES.has(entry.code));
  const reasons = relevant.map((entry) => ({ code: entry.code, detail: entry.detail }));
  if (relevant.some((entry) => entry.severity === "blocking")) return { level: "down", reasons };
  if (relevant.length > 0) return { level: "degraded", reasons };
  return { level: "ok", reasons };
}

function summary(level: WatchLevel): string {
  return level === "ok" ? "ok — doing its job" : level === "degraded" ? "degraded — serving, but impaired" : "down — not doing its job";
}

/** Transport/webhook/heartbeat errors may echo a credential: masked, and capped before
 *  reaching the state file — shared by TARGET_UNREACHABLE's detail and a heartbeat failure's. */
const ERROR_DETAIL_MAX = 200;

function errorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const masked = maskSecrets(message);
  return masked.length > ERROR_DETAIL_MAX ? `${masked.slice(0, ERROR_DETAIL_MAX)}…` : masked;
}

/** Whether this cycle differs from the last completed one: the level changed, or at the same
 *  non-ok level the set of reason codes did (details are ignored — see codeDiff). The first
 *  cycle is a baseline, never a transition. */
function isTransition(previousLevel: WatchLevel | undefined, level: WatchLevel, added: readonly string[], cleared: readonly string[]): boolean {
  if (previousLevel === undefined) return false;
  if (previousLevel !== level) return true;
  if (level === "ok") return false;
  return added.length > 0 || cleared.length > 0;
}

/** watchLevel()'s verdict, or "down" when the inspection could not run at all (Docker daemon
 *  down, SSH refused, wsl.exe silent). Also carries observed.channels through — unread here,
 *  but what withAdditionalFindings() needs, from one gatherInspection() call rather than a
 *  second just for channel data. A test passing its own `gather` decides for itself whether
 *  to include channels. */
export async function resolveWatchOutcome(
  ctx: Context,
  gather: (ctx: Context) => Promise<Inspection> = (target) => gatherInspection(target, { channels: true }),
): Promise<{ level: WatchLevel; reasons: WatchReason[]; channels?: ChannelsStatusResponse }> {
  try {
    const inspection = await gather(ctx);
    return { ...watchLevel(inspection.problems), channels: inspection.observed.channels };
  } catch (error) {
    return { level: "down", reasons: [{ code: "TARGET_UNREACHABLE", detail: errorDetail(error) }] };
  }
}

/** Everything after "what is the level right now": transition detection, the alert (only on
 *  change), the heartbeat ping (only while this cycle is ok), persistence (skipped when a
 *  required alert could not deliver, so the next cycle retries), reporting, and the exit
 *  code. Split out of watchCheck() so it is testable with a synthetic level/reasons pair and
 *  stub targets, without gatherInspection's target-reaching machinery. */
/** What changed since the last completed cycle. No previous state is not a transition:
 *  there is nothing to have changed FROM, and the first cycle after `watch install` (or
 *  after a corrupt/missing state file) should establish a baseline rather than page on it. */
interface WatchTransition {
  readonly previous: WatchState | undefined;
  readonly previousLevel: WatchLevel | undefined;
  readonly previousReasons: readonly WatchReason[];
  readonly added: readonly string[];
  readonly cleared: readonly string[];
  readonly transitioned: boolean;
}

async function detectWatchTransition(level: WatchLevel, reasons: WatchReason[]): Promise<WatchTransition> {
  const previous = await readWatchState();
  const previousLevel = previous?.level;
  const previousReasons = previous?.reasons ?? [];
  const { added, cleared } = codeDiff(
    previousReasons.map((entry) => entry.code),
    reasons.map((entry) => entry.code),
  );
  return { previous, previousLevel, previousReasons, added, cleared, transitioned: isTransition(previousLevel, level, added, cleared) };
}

export const ALERT_NOT_DELIVERED = "was not delivered";

/** Sends the transition webhook alert, when one applies. On delivery failure, persists a
 *  retry marker (level/reasons untouched, so the next cycle retries the same change) and
 *  dies — this cycle must not go on to report a change it never actually announced. */
async function deliverTransitionAlert(
  webhookTarget: WatchWebhookTarget | undefined,
  transition: WatchTransition,
  level: WatchLevel,
  reasons: WatchReason[],
  now: string,
): Promise<void> {
  const { transitioned, previous, previousLevel, previousReasons, added, cleared } = transition;
  if (!transitioned || previousLevel === undefined || webhookTarget === undefined) return;

  try {
    await postWebhookAlert(webhookTarget, transitionPayload(previousLevel, level, previousReasons, reasons, now));
  } catch (error) {
    // Level and reasons stay as they were so the next cycle retries the same change; only
    // the diagnostics move. since/fromCodes keep the start of the streak, toCodes this attempt.
    const detail = errorDetail(error);
    await writeWatchState({
      ...previous!,
      lastRunAt: now,
      lastError: detail,
      alertPending: {
        from: previousLevel,
        to: level,
        since: previous!.alertPending?.since ?? now,
        fromCodes: previous!.alertPending?.fromCodes ?? previousReasons.map((entry) => entry.code),
        toCodes: reasons.map((entry) => entry.code),
      },
    });
    die(
      `watch: ${summary(level)}, but the alert for ${describeTransition(previousLevel, level, added, cleared)} ${ALERT_NOT_DELIVERED}: ` +
        `${detail}\nstate was left at "${previousLevel}" so this is retried next cycle`,
    );
  }
}

type WatchHeartbeatOutcome = { ok: true } | { ok: false; detail: string };

/** Dead-man's switch: pinged only while THIS cycle itself reads ok — a ping mid-outage
 *  would tell the external service the instance is fine when it is not, defeating the whole
 *  point of a heartbeat that is supposed to stop the moment something really is down. A
 *  failed ping is a warning only: the heartbeat target being unreachable says nothing about
 *  the instance watch exists to report on, so it never moves level or the exit code. */
async function pingWatchHeartbeat(level: WatchLevel, heartbeatUrl: URL | undefined): Promise<WatchHeartbeatOutcome | undefined> {
  if (level !== "ok" || heartbeatUrl === undefined) return undefined;
  try {
    await postHeartbeat(heartbeatUrl);
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: errorDetail(error) };
  }
}

function buildWatchCycleState(
  level: WatchLevel,
  reasons: WatchReason[],
  now: string,
  transitioned: boolean,
  previous: WatchState | undefined,
  heartbeatOutcome: WatchHeartbeatOutcome | undefined,
): WatchState {
  return {
    level,
    reasons,
    checkedAt: now,
    changedAt: transitioned || previous?.changedAt === undefined ? now : previous.changedAt,
    // Reaching here means the cycle completed — delivered, or nothing needed delivering —
    // so any earlier failure streak is over.
    lastRunAt: now,
    lastError: undefined,
    alertPending: undefined,
    intervalMinutes: previous?.intervalMinutes,
    heartbeatAt: heartbeatOutcome?.ok ? now : previous?.heartbeatAt,
    heartbeatError: heartbeatOutcome === undefined ? previous?.heartbeatError : heartbeatOutcome.ok ? undefined : heartbeatOutcome.detail,
  };
}

function reportWatchCycle(
  jsonOnly: boolean,
  level: WatchLevel,
  reasons: WatchReason[],
  transitioned: boolean,
  webhookTarget: WatchWebhookTarget | undefined,
  state: WatchState,
  previousLevel: WatchLevel | undefined,
  added: readonly string[],
  cleared: readonly string[],
  heartbeatOutcome: WatchHeartbeatOutcome | undefined,
  now: string,
): void {
  if (jsonOnly || isCaptured()) {
    emit(
      `${JSON.stringify(
        {
          level,
          reasons,
          transitioned,
          alerted: transitioned && webhookTarget !== undefined,
          checkedAt: now,
          changedAt: state.changedAt,
          codesAdded: added,
          codesCleared: cleared,
          ...(heartbeatOutcome !== undefined && !heartbeatOutcome.ok ? { heartbeatWarning: heartbeatOutcome.detail } : {}),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  log(`watch: ${summary(level)}`);
  if (reasons.length === 0) info("no liveness problems found");
  for (const reason of reasons) warn(`${reason.code}  ${reason.detail}`);
  if (heartbeatOutcome !== undefined && !heartbeatOutcome.ok) warn(`heartbeat ping failed: ${heartbeatOutcome.detail}`);
  info(
    previousLevel === undefined
      ? "first cycle — baseline recorded, no alert sent"
      : transitioned ? `state changed: ${describeTransition(previousLevel, level, added, cleared)}` : "state unchanged since the last cycle",
  );
}

export async function runWatchCycle(
  webhookTarget: WatchWebhookTarget | undefined,
  level: WatchLevel,
  reasons: WatchReason[],
  jsonOnly: boolean,
  heartbeatUrl?: URL,
): Promise<void> {
  await withWatchStateLock(async () => {
  const now = new Date().toISOString();
  const transition = await detectWatchTransition(level, reasons);
  await deliverTransitionAlert(webhookTarget, transition, level, reasons, now);

  const heartbeatOutcome = await pingWatchHeartbeat(level, heartbeatUrl);

  const state = buildWatchCycleState(level, reasons, now, transition.transitioned, transition.previous, heartbeatOutcome);
  await writeWatchState(state);

  reportWatchCycle(jsonOnly, level, reasons, transition.transitioned, webhookTarget, state, transition.previousLevel, transition.added, transition.cleared, heartbeatOutcome, now);

  // Every cycle's exit code says what an external scheduler needs to know, independent of
  // whether an alert fired this time: 0 while the instance is doing its job, non-zero
  // otherwise — the same binary vocabulary `doctor` already uses for "blocking found".
  if (level !== "ok") {
    die(`the instance is ${level}: ${reasons.map((entry) => entry.code).join(", ") || "no reason recorded"}`);
  }
  });
}

/** Adds channel/disk findings unless the target is unreachable or not bootstrapped; channels
 *  are skipped while the gateway is down, disk is still read (a full disk often is why).
 *  channelFindings() reads base.channels — resolveWatchOutcome's own gatherInspection call,
 *  not a second CLI round-trip here. */
async function withAdditionalFindings(
  ctx: Context,
  base: { level: WatchLevel; reasons: WatchReason[]; channels?: ChannelsStatusResponse },
): Promise<{ level: WatchLevel; reasons: WatchReason[] }> {
  const hasCode = (code: string): boolean => base.reasons.some((entry) => entry.code === code);
  if (hasCode("TARGET_UNREACHABLE") || hasCode("NOT_BOOTSTRAPPED")) return base;

  const findings = [
    ...(hasCode("GATEWAY_DOWN") ? [] : channelFindings(base.channels)),
    ...(await diskFindings(ctx)),
  ];
  return mergeFindings(base, findings);
}

/** A configuration error stops watchCheck before any cycle; record it so `watch status`
 *  shows it. Only lastRunAt/lastError move. */
async function recordConfigError(error: unknown): Promise<void> {
  await withWatchStateLock(async () => {
    const previous = await readWatchState();
    await writeWatchState({ ...previous, lastRunAt: new Date().toISOString(), lastError: errorDetail(error) });
  });
}

async function runCheck(ctx: Context, values: Values<typeof WATCH_CHECK_ARGUMENTS>): Promise<void> {
  await withOperatorWatchState(ctx, async () => {
  const jsonOnly = values.json === true;

  // Validated before gatherInspection ever reaches the target: a misconfigured webhook or
  // heartbeat URL is a configuration error worth stopping on every cycle, not just the one
  // that would have tried to use it, and there is no reason to pay for a probe cycle first.
  let webhookTarget: WatchWebhookTarget | undefined;
  let heartbeatUrl: URL | undefined;
  try {
    const webhookRaw = watchWebhookRaw(ctx);
    const webhookUrl = webhookRaw === undefined ? undefined : parseWebhookUrl(webhookRaw);
    webhookTarget = webhookUrl === undefined ? undefined : resolveWebhookTarget(ctx, webhookUrl);

    const heartbeatRaw = watchHeartbeatUrlRaw(ctx);
    heartbeatUrl = heartbeatRaw === undefined ? undefined : parseHeartbeatUrl(heartbeatRaw);
  } catch (error) {
    await recordConfigError(error);
    throw error;
  }

  const base = await resolveWatchOutcome(ctx);
  const { level, reasons } = await withAdditionalFindings(ctx, base);

  await runWatchCycle(webhookTarget, level, reasons, jsonOnly, heartbeatUrl);
  });
}

/** The `watch check` action. */
export const WATCH_CHECK = defineAction({
  summary: "One probe cycle; alerts and records on a state change",
  arguments: WATCH_CHECK_ARGUMENTS,
  run: runCheck,
});

/** Legacy (ctx, argv) entry: parse this action's slice and run on the given context — the
 *  same shape the pipeline's parse stage runs. Kept for importers outside this group. */
export async function watchCheck(ctx: Context, args: string[]): Promise<void> {
  const values = bind(WATCH_CHECK_ARGUMENTS, tokenize(WATCH_CHECK_ARGUMENTS, args)) as Values<typeof WATCH_CHECK_ARGUMENTS>;
  await runCheck(ctx, values);
}

// --- `watch test` -----------------------------------------------------------------------

export interface WatchTestResult {
  readonly target: "webhook" | "heartbeat";
  readonly ok: boolean;
  /** Absent on success. Masked/capped the same way runWatchCycle's own failures are. */
  readonly detail?: string;
}

/** A test ping is the same signal as a cycle's, so it updates only the heartbeat fields. */
async function recordHeartbeatOutcome(now: string, detail: string | undefined): Promise<void> {
  await withWatchStateLock(async () => {
    const previous = await readWatchState();
    await writeWatchState({ ...previous, heartbeatAt: detail === undefined ? now : previous?.heartbeatAt, heartbeatError: detail });
  });
}

/** Proves delivery on demand: a test message (marked as a test, never a transition payload)
 *  to the webhook and a heartbeat ping, for whichever is configured. Any configured target
 *  that fails exits non-zero; none configured is reported, not failed. */
async function runTest(ctx: Context, values: Values<typeof WATCH_CHECK_ARGUMENTS>): Promise<void> {
  await withOperatorWatchState(ctx, async () => {
  const jsonOnly = values.json === true;
  const now = new Date().toISOString();
  const results: WatchTestResult[] = [];

  const webhookRaw = watchWebhookRaw(ctx);
  if (webhookRaw !== undefined) {
    try {
      const webhookTarget = resolveWebhookTarget(ctx, parseWebhookUrl(webhookRaw));
      await postTestAlert(webhookTarget, now);
      results.push({ target: "webhook", ok: true });
    } catch (error) {
      results.push({ target: "webhook", ok: false, detail: errorDetail(error) });
    }
  }

  const heartbeatRaw = watchHeartbeatUrlRaw(ctx);
  if (heartbeatRaw !== undefined) {
    try {
      await postHeartbeat(parseHeartbeatUrl(heartbeatRaw));
      results.push({ target: "heartbeat", ok: true });
      await recordHeartbeatOutcome(now, undefined);
    } catch (error) {
      const detail = errorDetail(error);
      results.push({ target: "heartbeat", ok: false, detail });
      await recordHeartbeatOutcome(now, detail);
    }
  }

  if (jsonOnly || isCaptured()) {
    emit(`${JSON.stringify({ configured: results.length > 0, results }, null, 2)}\n`);
  } else if (results.length === 0) {
    info(`neither ${WATCH_WEBHOOK_ENV} nor ${WATCH_HEARTBEAT_URL_ENV} is configured — nothing to test`);
  } else {
    log("watch test");
    for (const result of results) {
      if (result.ok) info(`${result.target}: delivered`);
      else warn(`${result.target}: failed — ${result.detail}`);
    }
  }

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    die(`watch test: ${failed.map((result) => result.target).join(", ")} failed to deliver`);
  }
  });
}

/** The `watch test` action: proves webhook/heartbeat delivery before an outage is the first
 *  time it is tried. */
export const WATCH_TEST = defineAction({
  summary: "Send one test webhook message and heartbeat ping",
  arguments: WATCH_CHECK_ARGUMENTS,
  run: runTest,
});
