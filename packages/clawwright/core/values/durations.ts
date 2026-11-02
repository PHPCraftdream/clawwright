// One grammar for the durations the framework accepts by name: schedule intervals
// (`--interval`), .env thresholds (OC_BACKUP_MAX_AGE) and `logs --since`. Each mode is its
// own small function; callers keep their own refusal policy (fallbacks, the scheduler's
// range check) but share the grammar, so the accepted spellings cannot drift between them.

import { UserError } from "../io/log.ts";
import { ValueError, type ValueParser } from "./value.ts";

const INTERVAL_PATTERN = /^(\d+)([mhd]?)$/;
const INTERVAL_UNIT_MINUTES: Readonly<Record<string, number>> = { m: 1, h: 60, d: 1440 };

export interface IntervalOptions {
  /** backup install: a cadence that stops the gateway must carry an explicit unit. */
  readonly requireUnit?: boolean;
  /** For the bare-value refusal in requireUnit mode: spellings the caller would accept. */
  readonly nearestUnit?: (bareMinutes: number) => string;
}

export const INTERVAL_GRAMMAR_WITH_UNIT = "--interval must look like 30m, 6h or 1d (an explicit unit is required)";
export const INTERVAL_GRAMMAR = "--interval must be a number of minutes or look like 30m, 6h or 1d (minutes, hours or days)";
export const NEAREST_VALID = " — nearest valid: ";

/** `--interval`: "30m" / "6h" / "1d", or — unless requireUnit — a bare number of minutes
 *  ("10" = "10m", watch's historical form). An empty or malformed value is refused, naming
 *  the input; the scheduler's own range check stays with the caller. */
export function parseInterval(raw: string, options: IntervalOptions = {}): { minutes: number; bare: boolean } {
  const grammar = options.requireUnit === true ? INTERVAL_GRAMMAR_WITH_UNIT : INTERVAL_GRAMMAR;
  if (raw.trim() === "") throw new UserError(`${grammar} — got "${raw}"`);
  const match = INTERVAL_PATTERN.exec(raw.trim());
  if (match === null) throw new UserError(`${grammar} — got "${raw}"`);
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === "" && options.requireUnit === true) {
    const nearest = options.nearestUnit === undefined ? "" : `${NEAREST_VALID}${options.nearestUnit(value)}`;
    throw new UserError(`--interval needs an explicit unit${nearest}; a bare number is minutes only for watch install — got "${raw}"`);
  }
  return { minutes: unit === "" ? value : value * INTERVAL_UNIT_MINUTES[unit], bare: unit === "" };
}

const THRESHOLD_PATTERN = /^(\d+)(m|h|d)$/;
const THRESHOLD_UNIT_MS: Readonly<Record<string, number>> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** A threshold duration like 2d or 36h in milliseconds; undefined when raw is not that
 *  spelling. 0/off are a caller-level policy ("disabled"), not a spelling of duration. */
export function durationMs(raw: string): number | undefined {
  const match = THRESHOLD_PATTERN.exec(raw);
  return match === null ? undefined : Number(match[1]) * THRESHOLD_UNIT_MS[match[2]];
}

// A Go-style duration (docker compose's own --since grammar): at least one of hours,
// minutes, seconds, each a bare integer plus its unit, in that order.
const SINCE_DURATION = /^(?:\d+h)?(?:\d+m)?(?:\d+s)?$/;
// RFC3339/ISO: a date, optionally followed by a time with optional fractional seconds and
// an offset or "Z". Deliberately not node:util's Date.parse, which accepts far more than
// compose's own --since does and would let an otherwise-meaningless string through.
const SINCE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/;

/** `logs --since`: a duration compose accepts or an RFC3339/ISO date-time; the value is
 *  forwarded as-is, so anything else is refused before it reaches the runtime. */
export function validSince(value: string): boolean {
  return (SINCE_DURATION.test(value) && /\d/.test(value)) || SINCE_TIMESTAMP.test(value);
}

const SINCE_EXPECTED = "a duration (10m, 2h, 1h30m) or an RFC3339/ISO date-time";

/** `logs --since` as an argument parser: the value is forwarded as-is once validSince accepts it. */
export const sinceValue: ValueParser<string> = {
  expected: SINCE_EXPECTED,
  example: "10m",
  invalidExample: "yesterday",
  parse(raw) {
    if (!validSince(raw)) throw new ValueError(`takes ${SINCE_EXPECTED}, not "${raw}"`);
    return raw;
  },
};
