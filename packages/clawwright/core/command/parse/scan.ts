// The stage-7 token machine: step() and its strict and lenient drivers, split out of
// core/command/parse/index.ts at S2.8 (the 700-line layout limit) — parse/index.ts keeps the binder and
// the action selection and delegates tokenizing here.

import type { CommandArgument } from "#src/core/app.ts";
import {
  ARGUMENT_ERROR_TOKEN, ArgumentError, closestCommand, dieUnknownArgument, UnknownArgumentError,
} from "#src/core/command/errors.ts";
import {
  argumentScopeRefusal, bindsAsFlag, selectAction,
  type ActionScope, type CallShape, type Scanned, type SelectedAction, type TokenEntry,
} from "#src/core/command/parse/index.ts";

/** The strict driver over step(): the lenient driver's decisions, with each refusal thrown
 *  in today's words. The lenient reading shares scanLenient below. */
export function scan(
  declared: readonly CommandArgument[],
  argv: readonly string[],
  scope: ActionScope | undefined,
  verbatimTail: boolean,
  refuse: Readonly<Record<string, string>> | undefined,
  lenient: boolean,
): Scanned {
  if (lenient) {
    const scanned = scanLenient(declared, argv, verbatimTail, refuse);
    return {
      entries: scanned.entries, given: scanned.given, optionsEnded: scanned.optionsEnded,
      ...(scanned.pending === undefined ? {} : { pending: scanned.pending }),
    };
  }
  const slice: ScanSlice<CommandArgument> = { arguments: declared, verbatimTail, ...(refuse === undefined ? {} : { refuse }) };
  const named = new Map<string, CommandArgument>();
  for (const argument of declared) {
    if (argument.kind !== "positional" && argument.kind !== "variadic") named.set(argument.name, argument);
  }
  let state = INITIAL_TOKEN_STATE;
  const entries: TokenEntry[] = [];
  const given: string[] = [];
  for (const token of argv) {
    const transition = step(state, token, slice);
    if (transition.kind === "refusal") {
      switch (transition.reason) {
        case "refused-token": {
          const match = refuseMatch(refuse, token)!;
          throw new ArgumentError(ARGUMENT_ERROR_TOKEN, match.message, match.name.replace(/^-+/, ""));
        }
        case "unknown": {
          if (state.optionsEnded) dieUnknownArgument(token);
          const eq = token.indexOf("=");
          const key = token.startsWith("--") ? (eq === -1 ? token.slice(2) : token.slice(2, eq)) : undefined;
          if (key !== undefined && scope !== undefined) {
            const sibling = scope.siblings.find((candidate) => candidate.name === key);
            const scopeRefusal = sibling === undefined ? undefined : argumentScopeRefusal(sibling, scope.action, `--${key}`);
            if (scopeRefusal !== undefined) throw new UnknownArgumentError(scopeRefusal, key);
          }
          const suggestion = key === undefined ? undefined : closestCommand(key, [...named.keys()]);
          dieUnknownArgument(token, suggestion === undefined ? undefined : `--${suggestion}`);
        }
        case "flag-with-value":
          throw new ArgumentError(ARGUMENT_ERROR_TOKEN, `--${transition.argument!.name} is a flag and takes no value`, transition.argument!.name);
        case "option-missing-value":
          throw new ArgumentError(ARGUMENT_ERROR_TOKEN, `--${transition.argument!.name} needs a value`, transition.argument!.name);
        case "option-repeated":
          throw new ArgumentError(ARGUMENT_ERROR_TOKEN, `--${transition.argument!.name} given more than once`, transition.argument!.name);
        case "no-slot":
          dieUnknownArgument(token);
      }
    }
    if (transition.kind === "option-value") {
      // Today's strict lookahead is gone: the pending option's declared-long-token refusal lives wholly in step().
      const waiting = declared.find((argument) => argument.name === state.pending)!;
      entries.push({ argument: waiting, value: token });
    } else switch (transition.kind) {
      case "flag":
        entries.push({ argument: transition.argument, value: true });
        given.push(transition.argument.name);
        break;
      case "option-inline":
        entries.push({ argument: transition.argument, value: transition.value });
        given.push(transition.argument.name);
        break;
      case "option-pending":
        given.push(transition.argument.name);
        break;
      case "positional": case "variadic": case "tail-start":
        entries.push({ argument: transition.argument, value: token });
        break;
      case "options-end": break;
    }
    state = advance(state, transition);
  }
  if (state.pending !== undefined) {
    const waiting = declared.find((argument) => argument.name === state.pending)!;
    throw new ArgumentError(ARGUMENT_ERROR_TOKEN, `--${waiting.name} needs a value`, waiting.name);
  }
  return { entries, given, optionsEnded: state.optionsEnded };
}

/** The tokenizer's state between tokens — where the strict and the lenient reader agree. */
export interface TokenState {
  readonly optionsEnded: boolean;
  readonly tail: boolean;
  /** The option awaiting its value (its name). */
  readonly pending?: string;
  readonly filled: number;
  /** Option names already bound — the strict repeat refusal's memory. */
  readonly seen: readonly string[];
}
export const INITIAL_TOKEN_STATE: TokenState = { optionsEnded: false, tail: false, filled: 0, seen: [] };

export type TokenRefusalReason =
  | "unknown" | "flag-with-value" | "option-missing-value"
  | "option-repeated" | "no-slot" | "refused-token";

export type ScanRefusalReason = TokenRefusalReason | "unknown-action";

export type TokenTransition<A extends CommandArgument> =
  | { readonly kind: "flag"; readonly argument: A }
  | { readonly kind: "option-inline"; readonly argument: A; readonly value: string }
  | { readonly kind: "option-pending"; readonly argument: A }
  | { readonly kind: "option-value"; readonly value: string }
  | { readonly kind: "positional"; readonly argument: A }
  | { readonly kind: "variadic"; readonly argument: A; readonly startTail: boolean }
  | { readonly kind: "options-end" }
  | { readonly kind: "tail-start"; readonly argument: A }
  | { readonly kind: "refusal"; readonly reason: TokenRefusalReason; readonly token: string; readonly argument?: A };

export interface ScanSlice<A extends CommandArgument> {
  readonly arguments: readonly A[];
  readonly verbatimTail: boolean;
  readonly refuse?: Readonly<Record<string, string>>;
}

/** The one token decision, pure and total: today's scan() order, one token at a time.
 *  A refusal carries the token and (when one is named) the argument; the caller decides
 *  what a refusal means — strict throws, lenient records. */
export function step<A extends CommandArgument>(state: TokenState, token: string, slice: ScanSlice<A>): TokenTransition<A> {
  const long = token.startsWith("--");
  const variadic = slice.arguments.find((argument) => argument.kind === "variadic");
  if (state.tail && variadic !== undefined) return { kind: "variadic", argument: variadic, startTail: false };
  const waiting = state.pending === undefined ? undefined : slice.arguments.find((argument) => argument.name === state.pending);
  if (!state.optionsEnded && waiting !== undefined) {
    if (long) {
      const eq = token.indexOf("=");
      const named = slice.arguments.find((argument) => argument.name === (eq === -1 ? token.slice(2) : token.slice(2, eq)) && (argument.kind === "flag" || argument.kind === "option"));
      if (named !== undefined) {
        return { kind: "refusal", reason: "option-missing-value", token, argument: waiting };
      }
      // The token is gone from the pending branch's allowance: a declared long flag OR option
      // is refused (option-missing-value) by the one rule in step() itself.
    }
    return { kind: "option-value", value: token };
  }
  if (!state.optionsEnded && token === "--") return { kind: "options-end" };
  if (!state.optionsEnded) {
    if (refuseMatch(slice.refuse, token) !== undefined) return { kind: "refusal", reason: "refused-token", token };
  }
  if (!state.optionsEnded && bindsAsFlag(token)) {
    // --opt=value is split before lookup so every declared option reads the same syntax.
    let flagToken = token;
    let inlineValue: string | undefined;
    if (long) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        flagToken = token.slice(0, eq);
        inlineValue = token.slice(eq + 1);
      }
    }
    const argument = flagToken.startsWith("--") ? slice.arguments.find((candidate) => candidate.name === flagToken.slice(2) && (candidate.kind === "flag" || candidate.kind === "option")) : undefined;
    if (argument === undefined) {
      if (slice.verbatimTail && variadic !== undefined) return { kind: "tail-start", argument: variadic };
      return { kind: "refusal", reason: "unknown", token };
    }
    if (argument.kind === "flag") {
      // A flag carries no value — "=value" on one is a mistake worth naming.
      if (inlineValue !== undefined) return { kind: "refusal", reason: "flag-with-value", token, argument };
      return { kind: "flag", argument };
    }
    if (state.seen.includes(argument.name)) return { kind: "refusal", reason: "option-repeated", token, argument };
    if (inlineValue !== undefined) return { kind: "option-inline", argument, value: inlineValue };
    return { kind: "option-pending", argument };
  }
  const positionals = slice.arguments.filter((argument) => argument.kind === "positional");
  if (state.filled < positionals.length) return { kind: "positional", argument: positionals[state.filled] };
  if (variadic !== undefined) return { kind: "variadic", argument: variadic, startTail: slice.verbatimTail };
  // Both die dieUnknownArgument in strict mode; the reason only tells the lenient reader apart.
  return { kind: "refusal", reason: token !== "" && token[0] === "-" ? "unknown" : "no-slot", token };
}

/** The state after a non-refusal transition (a refusal never advances — the driver decides). */
function advance(state: TokenState, transition: Exclude<TokenTransition<CommandArgument>, { kind: "refusal" }>): TokenState {
  switch (transition.kind) {
    case "flag": case "variadic":
      return transition.kind === "variadic" && transition.startTail ? { ...state, tail: true } : state;
    case "option-inline": return { ...state, pending: undefined, seen: [...state.seen, transition.argument.name] };
    case "option-pending": return { ...state, pending: transition.argument.name, seen: [...state.seen, transition.argument.name] };
    case "option-value": return { ...state, pending: undefined };
    case "positional": return { ...state, filled: state.filled + 1 };
    case "options-end": return { ...state, optionsEnded: true, pending: undefined };
    case "tail-start": return { ...state, tail: true };
  }
}

/** An exact token the declaration refuses with its own reason: `--flag` also covers its
 *  inline spelling `--flag=...`. A value is never refused — the pending branch precedes. */
function refuseMatch(refuse: Readonly<Record<string, string>> | undefined, token: string): { readonly name: string; readonly message: string } | undefined {
  if (refuse === undefined) return undefined;
  const eq = token.indexOf("=");
  const name = token.startsWith("--") && eq !== -1 ? token.slice(0, eq) : token;
  return Object.hasOwn(refuse, name) ? { name, message: refuse[name] } : undefined;
}

/** A repeated option overwrites its earlier entry in place (design section 9); a variadic
 *  never does. Only reached for options. */
function setOptionEntry(entries: TokenEntry[], argument: CommandArgument, value: string): void {
  const at = entries.findIndex((entry) => entry.argument.name === argument.name);
  if (at === -1) entries.push({ argument, value });
  else entries[at] = { argument: entries[at].argument, value };
}

/** The shared lenient reader: a refusal is recorded, not thrown, and the scan continues. */
interface LenientScan<A extends CommandArgument> {
  readonly entries: TokenEntry[];
  readonly given: string[];
  readonly optionsEnded: boolean;
  readonly pending?: A;
  readonly tail: boolean;
  readonly refusals: readonly ScanRefusal[];
}

function scanLenient<A extends CommandArgument>(
  declared: readonly A[],
  argv: readonly string[],
  verbatimTail: boolean,
  refuse?: Readonly<Record<string, string>>,
): LenientScan<A> {
  const slice: ScanSlice<A> = { arguments: declared, verbatimTail, ...(refuse === undefined ? {} : { refuse }) };
  let state = INITIAL_TOKEN_STATE;
  const entries: TokenEntry[] = [];
  const given: string[] = [];
  const refusals: ScanRefusal[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    // A bounded recovery loop: option-missing-value clears the pending option and
    // option-repeated un-marks the repeat, each re-processing the SAME token — every
    // recovery moves the state strictly closer to a binding (pending cleared, seen
    // shortened), so it can never oscillate; the cap is one past the six refusal kinds.
    let transition = step(state, token, slice);
    for (let attempts = 0; attempts < 7; attempts += 1) {
      if (transition.kind !== "refusal") break;
      const argument = transition.argument;
      refusals.push({ reason: transition.reason, token, ...(argument === undefined ? {} : { name: argument.name }) });
      if (transition.reason === "option-missing-value") {
        state = { ...state, pending: undefined };
        transition = step(state, token, slice);
        continue;
      }
      if (transition.reason === "option-repeated") {
        state = { ...state, seen: state.seen.filter((name) => name !== argument?.name) };
        transition = step(state, token, slice);
        continue;
      }
      break;
    }
    if (transition.kind === "refusal") {
      index += 1;
      continue;
    }
    switch (transition.kind) {
      case "flag":
        entries.push({ argument: transition.argument, value: true });
        given.push(transition.argument.name);
        break;
      case "option-inline":
        setOptionEntry(entries, transition.argument, transition.value);
        given.push(transition.argument.name);
        break;
      case "option-pending":
        given.push(transition.argument.name);
        break;
      case "option-value":
        setOptionEntry(entries, declared.find((argument) => argument.name === state.pending)!, transition.value);
        break;
      case "positional": case "variadic": case "tail-start":
        entries.push({ argument: transition.argument, value: token });
        break;
      case "options-end": break;
    }
    state = advance(state, transition);
    index += 1;
  }
  const pending = state.pending === undefined ? undefined : declared.find((argument) => argument.name === state.pending);
  return {
    entries, given, optionsEnded: state.optionsEnded, tail: state.tail, refusals,
    ...(pending === undefined ? {} : { pending }),
  };
}

/** The one read of a shape's default action outside the selection itself: the registry and
 *  completion read it through here (ratchet actionSelectionOutsideCore). */
export function defaultActionOf(shape: CallShape): string | undefined {
  return shape.defaultAction;
}

/** One recorded token refusal of the lenient scan. The selection record is the one producer
 *  of "unknown-action" — the tokenizer itself only ever yields a TokenRefusalReason. */
export interface ScanRefusal {
  readonly reason: ScanRefusalReason;
  readonly token: string;
  /** The argument the refusal is about (the pending option, the flag with a value, the repeat). */
  readonly name?: string;
}

/** The lenient reading of a whole call (stage 7 S2.8): the strict binder's own state machine,
 *  refusals recorded instead of thrown. Completion reads this, not a second parser. */
export interface ScannedCall {
  readonly selected: SelectedAction;
  /** The slice the tokens were read against. */
  readonly slice: readonly CommandArgument[];
  readonly entries: readonly TokenEntry[];
  readonly given: readonly string[];
  readonly optionsEnded: boolean;
  readonly pending?: CommandArgument;
  readonly tail: boolean;
  readonly refusals: readonly ScanRefusal[];
}

/** The lenient scan of a whole call: select the action, then read the rest of argv with the
 *  shared lenient driver. A refused action selection (an unknown action word, or no action
 *  and no default) is recorded too, and the tokens are read against `options.fallback` — or
 *  the default action's own slice, or nothing — with `selected.name` left undefined. */
export function scanCall(
  shape: CallShape<CommandArgument>,
  argv: readonly string[],
  command = "",
  options: { verbatimTail?: boolean; fallback?: readonly CommandArgument[] } = {},
): ScannedCall {
  let selected: SelectedAction;
  let slice: readonly CommandArgument[];
  let rest: readonly string[];
  let refuse: Readonly<Record<string, string>> | undefined;
  let selection: readonly ScanRefusal[] = [];
  try {
    const chosen = selectAction<CommandArgument>(shape, { kind: "argv", argv }, command);
    selected = chosen.selected;
    slice = chosen.slice;
    rest = chosen.rest;
    refuse = chosen.refuse;
  } catch {
    selected = { name: undefined, how: "default" };
    slice = options.fallback
      ?? (shape.defaultAction !== undefined && shape.actions !== undefined && Object.hasOwn(shape.actions, shape.defaultAction)
        ? shape.actions[shape.defaultAction].arguments ?? []
        : []);
    rest = argv;
    refuse = undefined;
    selection = [{ reason: "unknown-action", token: argv[0] ?? "" }];
  }
  // isVerbatim cannot see the spec-only `verbatim` on a public CommandArgument, hence the
  // explicit option.
  const scanned = scanLenient(slice, rest, options.verbatimTail === true, refuse);
  return {
    selected, slice,
    entries: scanned.entries, given: scanned.given, optionsEnded: scanned.optionsEnded,
    ...(scanned.pending === undefined ? {} : { pending: scanned.pending }),
    tail: scanned.tail,
    refusals: [...selection, ...scanned.refusals],
  };
}
