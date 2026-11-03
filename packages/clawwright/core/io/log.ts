// Console output helpers, matching the format the shell scripts used, so the smoke suite
// and anyone reading logs sees the same shape before and after the migration.

import { outputSink } from "./output.ts";
import type { Advice } from "./invocation/advice.ts";
import { frameOf, type Invocation } from "./invocation/index.ts";
import type { Frame } from "./invocation/frame.ts";
import { renderAdviceRows, renderCurrentAdviceRows } from "./invocation/render.ts";

const useColour = process.stderr.isTTY === true;

/** Diagnostics go to stderr, or to the capture sink when there is one. The text is printed
 *  as it was handed over: the output layer rewrites nothing. */
function write(raw: string): void {
  const sink = outputSink();
  if (sink !== undefined) sink(raw);
  else process.stderr.write(raw);
}

const C = {
  red: useColour ? "\x1b[31m" : "",
  yellow: useColour ? "\x1b[33m" : "",
  green: useColour ? "\x1b[32m" : "",
  dim: useColour ? "\x1b[2m" : "",
  off: useColour ? "\x1b[0m" : "",
};

// Values that must never be printed. A failing child process is reported with its whole
// command line, and onboarding takes the gateway token as an argument — that is how a
// token ends up in a log, a screenshot or a pasted bug report.
const secrets = new Set<string>();

/** Registers a value to be masked in everything this module and the transport print.
 *  Short values are ignored: masking "1" would redact half the output. */
export function registerSecret(value: string | undefined): void {
  if (value === undefined) return;
  const trimmed = value.trim();
  if (trimmed.length < 8) return;
  secrets.add(trimmed);
}

/** Replaces every registered secret and its JSON-escaped form with a marker. */
export function maskSecrets(text: string): string {
  let masked = text;
  for (const secret of secrets) {
    masked = masked.split(secret).join("***");
    // JSON permits each character to use a short escape or a Unicode escape. Match those
    // spellings too, so a client cannot decode an otherwise masked error response.
    masked = masked.replace(secretPattern(secret), "***");
  }
  return masked;
}

/** Escapes every regex metacharacter, so `value` matches only itself inside a `new RegExp`. */
export function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unicodeEscape(code: number): string {
  const hex = code.toString(16).padStart(4, "0");
  const digits = [...hex].map((digit) => /[a-f]/i.test(digit) ? `[${digit.toLowerCase()}${digit.toUpperCase()}]` : digit).join("");
  return `\\\\[uU]${digits}`;
}

function secretPattern(secret: string): RegExp {
  const pieces = [...secret].map((character) => {
    const json = JSON.stringify(character);
    const jsonBody = json === undefined ? character : json.slice(1, -1);
    const escaped = Array.from({ length: character.length }, (_, index) => unicodeEscape(character.charCodeAt(index))).join("");
    const variants = [regexEscape(character), regexEscape(jsonBody), escaped];
    return `(?:${variants.filter((entry, index, all) => all.indexOf(entry) === index).join("|")})`;
  });
  return new RegExp(pieces.join(""), "g");
}

/** Progress line. Goes to stderr so stdout stays usable for machine-readable output.
 *  Not masked: printing a credential here is a deliberate act (`mcp-creds`), unlike a
 *  failure that drags a whole command line into the output. */
export function log(message: string): void {
  write(`${C.green}==>${C.off} ${message}\n`);
}

/** Secondary detail, indented under the preceding log line. A line built for another
 *  shell, host or scheduler — a cron entry, a command on a server, a schtasks line — is
 *  handed to info() as it was built and prints that way under every invocation. */
export function info(message: string): void {
  write(`${C.dim}    ${message}${C.off}\n`);
}

export const WARN_MARK = "warning:";
export function warn(message: string): void {
  write(`${C.yellow}${WARN_MARK}${C.off} ${message}\n`);
}

/** A blocking finding — instance not doing its job, or would not survive a restart — so it
 *  does not read as merely worth noting the way warn()'s "warning:" does. */
export const BLOCKING_MARK = "blocking:";
export function reportBlocking(message: string): void {
  write(`${C.red}${BLOCKING_MARK}${C.off} ${message}\n`);
}

export interface UserErrorOptions {
  readonly advice?: readonly Advice[];
  readonly cause?: unknown;
}

/** Thrown rather than exiting, so callers can clean up; main() turns it into exit 1. */
export class UserError extends Error {
  readonly advice: readonly Advice[];
  constructor(message: string, options?: UserErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "UserError";
    this.advice = options?.advice ?? [];
  }
}

export function die(message: string, ...advice: readonly Advice[]): never {
  throw new UserError(message, advice.length === 0 ? undefined : { advice });
}

/** A UserError carrying the wrapped command's own exit status, for a caller (host, exec,
 *  cli) reporting someone else's process outcome as its own — clamped to 1..255 so a
 *  signal-derived negative or out-of-range value never becomes 0 or unreproducible. */
export class CommandFailedError extends UserError {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "CommandFailedError";
    this.exitCode = Math.min(255, Math.max(1, Math.trunc(exitCode) || 1));
  }
}

/** die, but the process exits with the wrapped command's own status instead of the generic 1. */
export function dieWithExitCode(message: string, exitCode: number): never {
  throw new CommandFailedError(message, exitCode);
}

/** The error message plus, per piece of advice a UserError carries, its rendered lines —
 *  one per DISTINCT text, so an advice spelled for several shells prints every variant.
 *  Both are printed as they were built: the message is whatever the thrower wrote, and an
 *  advice line is rendered by the invocation that reported it. All masked once.
 *
 *  The frame form is the primary one: a caller that already holds the run's Frame passes it
 *  and it renders directly. The Invocation form is for callers that hold no frame — it
 *  rebuilds one from the hand-over alone (frameOf), which is rootless. */
export function formatError(error: unknown, source?: Frame | Invocation): string {
  const message = error instanceof Error ? error.message : String(error);
  const advice = error instanceof UserError ? error.advice : [];
  const frame = source === undefined ? undefined : ("launch" in source ? source : frameOf(source));
  const lines = (frame === undefined ? advice.flatMap(renderCurrentAdviceRows)
    : advice.flatMap((entry) => renderAdviceRows(entry, frame))).map((row) => `\n    → ${row}`).join("");
  return maskSecrets(message + lines);
}

export function reportError(error: unknown, source?: Frame | Invocation): void {
  write(`${C.red}error:${C.off} ${formatError(error, source)}\n`);
}

