// The alert webhook: a URL in `.env` (`OC_WATCH_WEBHOOK`), treated as a secret from the
// moment it is read — registered with core/io/log.ts's masking so any error message it ends
// up in is scrubbed the same way a leaked gateway token is. Nothing here ever hands the raw
// value to log()/info()/emit() (only reportError() is masked), so the only safe rule is to
// never construct a string with it.
//
// Also owns the heartbeat "dead-man's switch" (`OC_WATCH_HEARTBEAT_URL`): a GET on every
// cycle that reads `ok`, so an external service (healthchecks.io, Uptime Kuma, Better Stack)
// alerts on its own the moment the whole instance — or this tooling's own scheduler — stops
// running, something a webhook fired FROM here can never report.

import { deploymentName } from "../../../runtime/deployment.ts";
import { commandLine } from "../../../core/io/invocation/render.ts";
import type { Context } from "../../../core/context.ts";
import type { WatchLevel, WatchReason } from "./state.ts";

export const WATCH_WEBHOOK_ENV = "OC_WATCH_WEBHOOK";
export const WATCH_WEBHOOK_FORMAT_ENV = "OC_WATCH_WEBHOOK_FORMAT";
export const WATCH_TELEGRAM_CHAT_ID_ENV = "OC_WATCH_TELEGRAM_CHAT_ID";
export const WATCH_HEARTBEAT_URL_ENV = "OC_WATCH_HEARTBEAT_URL";

const REQUEST_TIMEOUT_MS = 10_000;

function rawEnvValue(ctx: Context, envName: string): string | undefined {
  const raw = ctx.settings.env[envName];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** `.env`'s raw value, or undefined when unset/blank — alerting is optional. */
export function watchWebhookRaw(ctx: Context): string | undefined {
  return rawEnvValue(ctx, WATCH_WEBHOOK_ENV);
}

/** Same optionality as the webhook: unset/blank means no dead-man's switch is wired up. */
export function watchHeartbeatUrlRaw(ctx: Context): string | undefined {
  return rawEnvValue(ctx, WATCH_HEARTBEAT_URL_ENV);
}

function isLocalhostHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** https, or plain http only against localhost/127.0.0.1/::1 — mirrors the framework's
 *  inbound posture (loopback by default). The message never repeats the value, only that
 *  the variable is invalid, so a mistyped scheme is never echoed back into logs. Shared by
 *  both URLs so they can never quietly diverge. */
export function webhookUrlRefusal(envName: string): string {
  return `${envName} must be https, or http only against localhost/127.0.0.1`;
}

function parseSecretUrl(envName: string, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${envName} is not a valid URL`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLocalhostHostname(url.hostname)) return url;
  throw new Error(webhookUrlRefusal(envName));
}

/** Throws rather than dying directly: the caller (check.ts) decides how the refusal is
 *  reported, the same split every other pure validator in this codebase keeps. */
export function parseWebhookUrl(raw: string): URL {
  return parseSecretUrl(WATCH_WEBHOOK_ENV, raw);
}

export function parseHeartbeatUrl(raw: string): URL {
  return parseSecretUrl(WATCH_HEARTBEAT_URL_ENV, raw);
}

export type WatchWebhookFormat = "generic" | "slack" | "discord" | "telegram";

const WEBHOOK_FORMATS: ReadonlySet<string> = new Set<WatchWebhookFormat>(["generic", "slack", "discord", "telegram"]);

/** Each vendor's own incoming-webhook host, verified against their docs (docs/guide/monitoring-and-access.md links them):
 *  Slack's are always hooks.slack.com; Discord's live at discord.com or the legacy
 *  discordapp.com under /api/webhooks/; Telegram's Bot API is always api.telegram.org.
 *  Anything else stays "generic" — the original {deployment, from, to, reasons, at} JSON. */
function detectWebhookFormat(url: URL): WatchWebhookFormat {
  if (url.hostname === "hooks.slack.com") return "slack";
  if ((url.hostname === "discord.com" || url.hostname === "discordapp.com") && url.pathname.startsWith("/api/webhooks/")) return "discord";
  if (url.hostname === "api.telegram.org") return "telegram";
  return "generic";
}

export interface WatchWebhookTarget {
  readonly url: URL;
  readonly format: WatchWebhookFormat;
  /** Only present (and only meaningful) for format "telegram" — sendMessage's own required
   *  destination parameter, kept apart from the URL because the URL already carries the bot
   *  token (`api.telegram.org/bot<token>/sendMessage`). */
  readonly telegramChatId?: string;
}

/** Resolves OC_WATCH_WEBHOOK's target shape before any probe cycle runs: an unrecognized
 *  OC_WATCH_WEBHOOK_FORMAT value, or format=telegram with no OC_WATCH_TELEGRAM_CHAT_ID, is a
 *  configuration error surfaced the same way an invalid URL already is — not one first
 *  discovered when a real transition tries (and fails) to deliver. */
export function resolveWebhookTarget(ctx: Context, url: URL): WatchWebhookTarget {
  const rawFormat = ctx.settings.env[WATCH_WEBHOOK_FORMAT_ENV]?.trim();
  let format: WatchWebhookFormat;
  if (rawFormat === undefined || rawFormat === "") {
    format = detectWebhookFormat(url);
  } else if (WEBHOOK_FORMATS.has(rawFormat)) {
    format = rawFormat as WatchWebhookFormat;
  } else {
    throw new Error(`${WATCH_WEBHOOK_FORMAT_ENV} must be generic, slack, discord or telegram`);
  }

  if (format !== "telegram") return { url, format };

  const chatId = rawEnvValue(ctx, WATCH_TELEGRAM_CHAT_ID_ENV);
  if (chatId === undefined) {
    throw new Error(`${WATCH_TELEGRAM_CHAT_ID_ENV} is required when the webhook format is telegram`);
  }
  return { url, format, telegramChatId: chatId };
}

/** Reason codes only, never the volatile detail text (free MB, an error message), so a
 *  detail-only change never reads as added/cleared. Shared by the payload, check and status. */
export function codeDiff(
  previousCodes: readonly string[],
  codes: readonly string[],
): { readonly added: readonly string[]; readonly cleared: readonly string[] } {
  const previous = new Set(previousCodes);
  const current = new Set(codes);
  return {
    added: [...current].filter((code) => !previous.has(code)),
    cleared: [...previous].filter((code) => !current.has(code)),
  };
}

/** Compact "from → to" one-liner, or "from → to (+ADDED -CLEARED)" when the reason-code set
 *  also moved — the same shape whether the level changed, only the codes did, or both did.
 *  Shared by check.ts's die()/info() text and status.ts's alertPending line. */
export function describeTransition(from: WatchLevel, to: WatchLevel, added: readonly string[], cleared: readonly string[]): string {
  const level = `${from} → ${to}`;
  if (added.length === 0 && cleared.length === 0) return level;
  const codes = [added.length > 0 ? `+${added.join(",")}` : undefined, cleared.length > 0 ? `-${cleared.join(",")}` : undefined]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  return `${level} (${codes})`;
}

export interface WatchTransitionPayload {
  readonly deployment: string;
  readonly from: WatchLevel;
  readonly to: WatchLevel;
  readonly reasons: readonly WatchReason[];
  readonly at: string;
  /** Reason codes present now that were not present in the previous cycle — non-empty
   *  exactly when this alert is (wholly or partly) a codes-only change at the same level.
   *  Always present, appended after the original five fields so a consumer reading only
   *  {deployment,from,to,reasons,at} sees that shape unchanged. */
  readonly codesAdded: readonly string[];
  /** Reason codes present in the previous cycle that are no longer present now. */
  readonly codesCleared: readonly string[];
}

export function transitionPayload(
  from: WatchLevel,
  to: WatchLevel,
  previousReasons: readonly WatchReason[],
  reasons: readonly WatchReason[],
  at: string,
): WatchTransitionPayload {
  const { added, cleared } = codeDiff(
    previousReasons.map((entry) => entry.code),
    reasons.map((entry) => entry.code),
  );
  return { deployment: deploymentName(), from, to, reasons, at, codesAdded: added, codesCleared: cleared };
}

// Each chat format's own documented text limit: Slack's hard per-message cap (40,000
// chars), Discord's `content` field (2,000), Telegram's `text` field (4,096, after entity
// parsing) — sources in docs/guide/monitoring-and-access.md's Health monitoring section.
const FORMAT_TEXT_LIMIT: Record<"slack" | "discord" | "telegram", number> = {
  slack: 40_000,
  discord: 2_000,
  telegram: 4_096,
};

// Per-reason cap, so one long detail cannot crowd out every other reason before the whole
// message even reaches its format's own limit.
const REASON_DETAIL_MAX = 80;

function reasonsLine(reasons: readonly WatchReason[]): string {
  if (reasons.length === 0) return "no reason recorded";
  return reasons
    .map((entry) => {
      const detail = entry.detail.length > REASON_DETAIL_MAX ? `${entry.detail.slice(0, REASON_DETAIL_MAX)}…` : entry.detail;
      return detail === "" ? entry.code : `${entry.code}: ${detail}`;
    })
    .join("; ");
}

function capToLimit(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function webhookRespondedWith(status: number): string {
  return `webhook responded with ${status}`;
}

/** "new: X, Y" / "cleared: X" / both; undefined when no code moved. */
export function codesChangeLine(added: readonly string[], cleared: readonly string[]): string | undefined {
  if (added.length === 0 && cleared.length === 0) return undefined;
  const parts: string[] = [];
  if (added.length > 0) parts.push(`new: ${added.join(", ")}`);
  if (cleared.length > 0) parts.push(`cleared: ${cleared.join(", ")}`);
  return parts.join("; ");
}

/** Two-three lines for the chat formats: deployment + transition (readable even when
 *  from===to, a codes-only change), which reason codes appeared/cleared since the last
 *  cycle, then the current reasons (with a short detail each) and when. Generic keeps the
 *  original structured JSON instead — this is only for a format a human reads in a chat
 *  client. */
function transitionText(payload: WatchTransitionPayload): string {
  const header = `${payload.deployment}: ${payload.from} → ${payload.to}`;
  const changeLine = codesChangeLine(payload.codesAdded, payload.codesCleared);
  const lines = [header, ...(changeLine === undefined ? [] : [changeLine]), `${reasonsLine(payload.reasons)} — ${payload.at}`];
  return lines.join("\n");
}

function webhookBody(target: WatchWebhookTarget, payload: WatchTransitionPayload): string {
  if (target.format === "generic") return JSON.stringify(payload);
  const text = capToLimit(transitionText(payload), FORMAT_TEXT_LIMIT[target.format]);
  if (target.format === "slack") return JSON.stringify({ text });
  if (target.format === "discord") return JSON.stringify({ content: text });
  return JSON.stringify({ chat_id: target.telegramChatId, text });
}

/** Every Bot API response carries a boolean `ok`; only `ok: true` proves delivery, and an
 *  unparseable body does not. */
async function telegramDelivered(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

/** POSTs `body` and throws on anything short of proof of delivery — a timeout, a refused
 *  connection, a non-2xx status, or (Telegram only) a 2xx answer with `ok:false` — so the
 *  caller can tell "delivered" from "not". Shared by postWebhookAlert (a real transition)
 *  and postTestAlert (`watch test`'s one-off proof): same target, same delivery contract,
 *  only the message differs. */
async function deliverWebhook(target: WatchWebhookTarget, body: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(target.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // The URL is registered with core/io/log.ts's masking regardless of fetch's own message
    // shape, so a future Node/undici version repeating it here still comes out masked.
    throw new Error(`webhook request failed: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new Error(webhookRespondedWith(response.status));
  }
  if (target.format === "telegram" && !(await telegramDelivered(response))) {
    throw new Error("webhook responded 2xx but telegram reported ok:false");
  }
}

/** Posts the transition, in `target.format`'s own shape — see deliverWebhook for what
 *  counts as delivered, which is what decides whether the new state is allowed to replace
 *  the old one. */
export async function postWebhookAlert(target: WatchWebhookTarget, payload: WatchTransitionPayload): Promise<void> {
  await deliverWebhook(target, webhookBody(target, payload));
}

/** `watch test`'s own message: never transitionPayload's shape, so a receiving chat or
 *  telegram thread cannot mistake it for a real alert. */
function testMessageText(at: string): string {
  return `${deploymentName()}: ${commandLine(["watch", "test"])} — this is a TEST alert, not a real transition\nsent ${at}`;
}

function testWebhookBody(target: WatchWebhookTarget, at: string): string {
  if (target.format === "generic") return JSON.stringify({ deployment: deploymentName(), test: true, at });
  const text = capToLimit(testMessageText(at), FORMAT_TEXT_LIMIT[target.format]);
  if (target.format === "slack") return JSON.stringify({ text });
  if (target.format === "discord") return JSON.stringify({ content: text });
  return JSON.stringify({ chat_id: target.telegramChatId, text });
}

/** Same delivery proof as postWebhookAlert, a clearly-marked test message instead of a
 *  transition — what `watch test` sends so delivery can be proven before a real outage is
 *  the first time it is tried. */
export async function postTestAlert(target: WatchWebhookTarget, at: string): Promise<void> {
  await deliverWebhook(target, testWebhookBody(target, at));
}

/** The dead-man's switch: a plain GET, proven to be what all three reference services
 *  (healthchecks.io, Uptime Kuma push, Better Stack heartbeat) accept — no per-service
 *  method configuration needed. Throws the same way postWebhookAlert does; the caller
 *  decides how a failed ping is reported (never the level, never the exit code — see
 *  check.ts). */
export async function postHeartbeat(url: URL): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`heartbeat request failed: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new Error(`heartbeat responded with ${response.status}`);
  }
}
