// Declared value kinds: one grammar, one example and one invalid generator per argument
// kind, so the property sweep derives its cases from the declaration instead of guessing a
// value per argument. `parse` keeps today's byte-identical refusal text (each constructor
// wraps the parser the command uses now); read grammars never reject values the framework
// already wrote (I14 — see the `hostId` decision).

import type { ValueParser } from "./value.ts";
import type { LocalScope } from "#src/core/command/spec.ts";

export type KindName = "choice" | "count" | "boundedCount" | "port" | "pattern" | "duration" | "interval" | "since" | "name" | "id" | "positive" | "receipt" | "checksum" | "hostId" | "sshDestination" | "commandName" | "absolutePath" | "localFile" | "localDirectory" | "recipeRef" | "image" | "text";

/** One refused value the sweep turns into a case: refused where (`parse` now, `prepare`
 *  once the later stage owns it) and why. */
export interface InvalidSample {
  readonly raw: string;
  readonly stage: "parse" | "prepare";
  readonly why: string;
}

export interface ValueKind<T, R = T> extends ValueParser<T> {
  readonly kind: KindName;
  /** "choice" only: the closed list the binder refuses against before `parse` is reached. */
  readonly choices?: readonly string[];
  /** The generator of refused values; every `parse`-stage entry must be refused by `parse`. */
  readonly invalid: readonly InvalidSample[];
  /** The local fact the pipeline settles at the prepare stage (S2.5): a refusal becomes an
   *  ArgumentError naming the argument, and the resolved value is the branded R. Method
   *  syntax keeps the kind covariant in T (a ValueKind<string> stays a ValueKind<unknown>). */
  resolve?(value: T, local: LocalScope): Promise<R>;
}
