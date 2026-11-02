// Command-line argument errors and the edit-distance guess behind "did you mean".

import { UserError } from "#src/core/io/log.ts";

export const ARGUMENT_ERROR_TOKEN: unique symbol = Symbol("clawwright.argument-error");


/** Damerau-Levenshtein edit distance: a transposition of two adjacent characters (the most
 *  common way to mistype a name — "statsu" for "status") costs one edit, not the two a
 *  plain Levenshtein distance would charge it. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => Array.from<number>({ length: cols }).fill(0));
  for (let i = 0; i < rows; i += 1) d[i][0] = i;
  for (let j = 0; j < cols; j += 1) d[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }
  return d[rows - 1][cols - 1];
}

/** The nearest candidate to a typed name, or undefined when nothing is close enough to be
 *  worth guessing at. The threshold scales with length so a couple of wrong letters in a
 *  long name still matches, while two short unrelated names never suggest each other.
 *  Lives here (not integration/gate.ts, its original home) because parseDeclaredArgs below
 *  needs the exact same match against a declared argument's name; gate.ts re-exports this. */
export function closestCommand(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(input, candidate);
    // An exact match is never a suggestion: `help control-mcp` reached the unknown-command
    // path (control-mcp is dispatched elsewhere) and was told "did you mean: control-mcp".
    if (distance === 0) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  if (best === undefined) return undefined;
  const threshold = Math.min(3, Math.max(1, Math.floor(Math.max(input.length, best.length) / 3)));
  return bestDistance <= threshold ? best : undefined;
}

/** A refusal of one argument; `argument` is its declared name, so a caller reads the
 *  structure rather than the prose. The constructor demands the command layer's private
 *  token: only the binder, prepare's refuse/derive and the pipeline mint one (stage 7
 *  S2.5) — the class stays exported for instanceof. */
export class ArgumentError extends UserError {
  name = "ArgumentError";
  readonly argument: string | undefined;
  constructor(token: typeof ARGUMENT_ERROR_TOKEN, message: string, argument?: string) {
    super(message);
    this.argument = argument;
  }
}

/** An ArgumentError that escaped from a `run` phase (stage 7 S2.5: a run cannot build one,
 *  so this is an invariant breach): the pipeline raises this instead, text preserved. */
export class LateArgumentError extends ArgumentError {
  name = "LateArgumentError";
  constructor(original: ArgumentError) {
    super(ARGUMENT_ERROR_TOKEN, original.message, original.argument);
  }
}

/** Thrown for a token matching no declared argument — a UserError, but distinct so the
 *  dispatcher (entry/cli.ts) can point at that command's own --help. */
export class UnknownArgumentError extends ArgumentError {
  name = "UnknownArgumentError";
  constructor(message: string, argument?: string) {
    super(ARGUMENT_ERROR_TOKEN, message, argument);
  }
}

export const UNKNOWN_ARGUMENT = "unknown argument";

export function didYouMeanSuffix(suggestion: string): string {
  return `(did you mean ${suggestion}?)`;
}

export function unknownArgumentMessage(token: string, suggestion?: string): string {
  return suggestion === undefined
    ? `${UNKNOWN_ARGUMENT}: ${token}`
    : `${UNKNOWN_ARGUMENT}: ${token} ${didYouMeanSuffix(suggestion)}`;
}

export function dieUnknownArgument(token: string, suggestion?: string): never {
  throw new UnknownArgumentError(unknownArgumentMessage(token, suggestion), token);
}

/** An unknown sub-action word; an UnknownArgumentError so entry/cli.ts adds the --help pointer. */
export class UnknownActionError extends UnknownArgumentError {
  name = "UnknownActionError";
  constructor(message: string, argument?: string) {
    super(message, argument);
  }
}

/** Refuses an unknown sub-action with `message` plus a did-you-mean guess from `choices`. */
export function dieUnknownAction(action: string, message: string, choices: readonly string[], argument?: string): never {
  const suggestion = closestCommand(action, choices);
  throw new UnknownActionError(suggestion === undefined ? message : `${message} ${didYouMeanSuffix(suggestion)}`, argument);
}

/** An MCP call to a command that replaces or destroys state, made without confirm: true. */
export class ConfirmationRequiredError extends UserError {
  name = "ConfirmationRequiredError";
  constructor(command: string) {
    super(`${command} replaces or destroys state — ${CONFIRM_REQUIRED}`);
  }
}

export const CONFIRM_REQUIRED = "pass confirm: true";
