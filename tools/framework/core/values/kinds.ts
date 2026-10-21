// One constructor per declared value kind. Each wraps the parser the command uses today, so
// a refusal stays byte-identical; the kind adds the declaration (`choices`, the invalid
// generator) the binder and the property sweep read. Parsers run at call time only — the
// runtime imports here (image-ref) carry no transport work into the value modules. Every
// kind refuses control characters at parse, before its own grammar runs.

import { parseInterval, sinceValue } from "#src/core/values/durations.ts";
import { nameValue, newNameValue, countValue, boundedCountValue, portValue, regexValue, ValueError, type ValueParser } from "#src/core/values/value.ts";
import type { NameKind, NameOf, RecipeName } from "#src/core/values/names.ts";
import type { LocalScope } from "#src/core/command/spec.ts";
import type { InvalidSample, KindName, ValueKind } from "#src/core/values/kind.ts";
import { checksum as checksumOf, localArtifact, localRecipeSource, missingArtifactRefusal, missingRecipeRefusal, missingRecipeSourceRefusal, operationId as operationIdOf, recipeRef as recipeRefOf, type Checksum, type LocalArtifact, type LocalRecipeSource, type OperationId, type RecipeRef } from "#src/core/values/plan.ts";
import { parse as parseImageRef, type ImageRef } from "#src/runtime/docker/image-ref.ts";
import { validatedRemoteRoot } from "#src/security/privacy/deploy-boundary.ts";
import { UserError } from "#src/core/io/log.ts";
import { stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

const takesNot = (expected: string) => (raw: string): string => `takes ${expected}, not "${raw}"`;

// oxlint-disable-next-line no-control-regex -- Control characters are exactly what these kinds refuse.
const CONTROL = /[\u0000-\u001f\u007f]/;
// Every C0 control and DEL except TAB (U+0009) and LF (U+000A).
// oxlint-disable-next-line no-control-regex -- Control characters are exactly what these kinds refuse.
const CONTROL_BUT_LINES = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** A raw value with its control characters escaped, for a refusal that must stay printable. */
// oxlint-disable-next-line no-control-regex -- Control characters are exactly what this escapes.
const shown = (raw: string): string => raw.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

function kindOf<T, R = T>(kind: KindName, parser: ValueParser<T>, invalid: readonly InvalidSample[], extra?: { choices?: readonly string[]; resolve?: (value: T, local: LocalScope) => Promise<R>; controls?: RegExp }): ValueKind<T, R> {
  const { controls = CONTROL, ...declared } = extra ?? {};
  // invalidExample restates invalid[0]: the sweep and the parser's own self-description
  // must never name different refusals.
  return {
    kind, ...parser, invalidExample: invalid[0]?.raw ?? parser.invalidExample, ...declared, invalid,
    // Control characters never reach a process argument, a path or a file line (I5, R2-B-1).
    parse(raw: string) {
      if (typeof raw === "string" && controls.test(raw)) throw new ValueError(`takes ${parser.expected}, not "${shown(raw)}"`);
      return parser.parse(raw);
    },
  } as ValueKind<T, R>;
}

/** A closed list. The binder refuses via `choices` before `parse` runs; this `parse` is
 *  the argument's real grammar — the clause the binder's choicesRefusal joins after the
 *  label, byte-identical. */
export function choice<T extends string = string>(values: readonly T[]): ValueKind<T> {
  return kindOf("choice", {
    expected: `one of ${values.join(", ")}`,
    example: values[0] ?? "",
    invalidExample: "",
    parse(raw) {
      if (!(values as readonly string[]).includes(raw)) throw new ValueError(`takes one of ${values.join(", ")}, not "${raw}"`);
      return raw as T;
    },
  } satisfies ValueParser<T>, [
    { raw: "outside-the-list", stage: "parse", why: "not a member of the list" },
    { raw: "", stage: "parse", why: "empty" },
  ], { choices: values });
}

export function count(expected = "a non-negative integer", refusal?: (raw: string) => string): ValueKind<number> {
  return kindOf("count", countValue(expected, refusal), [
    { raw: "abc", stage: "parse", why: "not digits" },
    { raw: "", stage: "parse", why: "empty" },
  ]);
}

/** A whole number the command bounds itself (`mcp-serve --wait`): the parser owns the range
 *  check, so the refusal moves from a command-side preflight into the kind's own voice. */
export function boundedCount(max: number, expected?: string): ValueKind<number> {
  return kindOf("boundedCount", boundedCountValue(max, expected), [
    { raw: String(max + 1), stage: "parse", why: "above the bound" },
    { raw: "abc", stage: "parse", why: "not digits" },
    { raw: "", stage: "parse", why: "empty" },
  ]);
}

/** `operations --limit`: a whole number above zero, one refusal sentence for both mistakes
 *  (the parser the command uses today, verbatim). */
export function positive(expected = "a positive number", refusal: (raw: string) => string = () => "needs a positive number"): ValueKind<number> {
  return kindOf("positive", {
    expected, example: "10", invalidExample: "0",
    parse(raw) {
      if (!/^\d+$/.test(raw)) throw new ValueError(refusal(raw));
      const value = Number(raw);
      if (value <= 0) throw new ValueError(refusal(raw));
      return value;
    },
  }, [
    { raw: "0", stage: "parse", why: "not above zero" },
    { raw: "abc", stage: "parse", why: "not digits" },
    { raw: "", stage: "parse", why: "empty" },
  ]);
}

export function port(): ValueKind<number> {
  return kindOf("port", portValue(), [
    { raw: "70000", stage: "parse", why: "above the port range" },
    { raw: "", stage: "parse", why: "empty" },
  ]);
}

export function pattern(): ValueKind<RegExp> {
  return kindOf("pattern", regexValue(), [
    { raw: "(", stage: "parse", why: "an unclosed group" },
    { raw: "a\u0000b", stage: "parse", why: "a control character" },
    // Not "" — the empty pattern is a valid RegExp (regexValue), so it would be a sample the
    // sweep could not refuse.
  ]);
}

/** `--interval`: the durations.ts grammar with the schedule wrapper's refusal shape — the
 *  leading "--interval" is sliced so the argument's label replaces it. The scheduler's own
 *  cron range check stays with the caller (it dies with the command's voice, it cannot be
 *  a parse refusal). `enforceRange` runs after the grammar succeeds, its exceptions pass
 *  through untouched — the backup/watch sites inject schedule.ts's cron range die there so
 *  the command's own voice stays byte-identical. */
export function interval(options: { requireUnit?: boolean; nearestUnit?: (bareMinutes: number) => string; enforceRange?: (bareMinutes: number) => void } = {}): ValueKind<number> {
  return kindOf("interval", {
    expected: "an interval such as 30m, 6h or 1d",
    example: "30m",
    invalidExample: "7x",
    parse(raw) {
      let minutes: number;
      try {
        minutes = parseInterval(raw, options).minutes;
      } catch (error) {
        const message = (error as Error).message;
        throw new ValueError(message.startsWith("--interval ") ? message.slice("--interval ".length) : `: ${message}`);
      }
      options.enforceRange?.(minutes);
      return minutes;
    },
  }, [
    { raw: "7x", stage: "parse", why: "not a duration spelling" },
    { raw: "", stage: "parse", why: "empty" },
  ]);
}

/** The cron-range refusal in the command's own voice: schedule.ts's cronSchedule error,
 *  with the parser's "--interval " prefix stripped so the argument's label re-joins it. */
export function intervalRangeRefusal(error: unknown): never {
  const message = (error as Error).message;
  const prefix = "--interval ";
  throw new ValueError(message.slice(0, prefix.length) === prefix ? message.slice(prefix.length) : `: ${message}`);
}

/** `configure-provider --provider`: the provider.ts grammar as a kind, so the refusal moves
 *  from prepare to the parse stage in the kind's own voice. */
export function providerId(): ValueKind<string> {
  return kindOf("id", {
    expected: "a provider id",
    example: "openai",
    invalidExample: "openai!",
    parse(raw) {
      if (raw === "") throw new ValueError("needs a value");
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw)) throw new ValueError(takesNot("a provider id")(raw));
      return raw;
    },
  }, [
    { raw: "openai!", stage: "parse", why: "a character outside the id grammar" },
    { raw: "-x", stage: "parse", why: "a flag look-alike" },
    { raw: "", stage: "parse", why: "empty" },
  ]);
}

/** `configure-provider --env`: the environment-variable name grammar as a kind. */
export function envVar(): ValueKind<string> {
  return kindOf("name", {
    expected: "an environment variable name",
    example: "OPENAI_API_KEY",
    invalidExample: "1BAD",
    parse(raw) {
      if (raw === "") throw new ValueError("needs a value");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) throw new ValueError(takesNot("an environment variable name")(raw));
      return raw;
    },
  }, [
    { raw: "1BAD", stage: "parse", why: "a leading digit" },
    { raw: "OPENAI-API-KEY", stage: "parse", why: "a dash" },
    { raw: "", stage: "parse", why: "empty" },
  ]);
}

/** `logs --since`: the shared sinceValue as a kind. */
export const since: ValueKind<string> = kindOf("since", sinceValue, [
  { raw: "yesterday", stage: "parse", why: "neither a duration nor a date-time" },
  { raw: "", stage: "parse", why: "empty" },
]);

export function name<K extends NameKind>(kind: K, mode: "create" | "read"): ValueKind<NameOf<K>>;
export function name(kind: string, mode: "create" | "read"): ValueKind<string>;
export function name(kind: string, mode: "create" | "read"): ValueKind<string> {
  return kindOf("name", mode === "create" ? newNameValue(kind as NameKind) : nameValue(kind as NameKind), [
    { raw: "Bad_Name", stage: "parse", why: "upper case and underscore" },
    { raw: "../x", stage: "parse", why: "a path step" },
    { raw: "-x", stage: "parse", why: "a flag look-alike" },
    { raw: "", stage: "parse", why: "empty" },
  ]);
}

/** A recorded id that becomes a path segment. `id("host")` is deliberately not expressible
 *  this way — recorded host ids carry ":" and user-set HOSTNAMEs (the `hostId` kind). */
export function id(kind: string, example: string): ValueKind<string> {
  return kindOf("id", {
    expected: `an ${kind} id`,
    example,
    invalidExample: "../x",
    parse(raw) {
      if (raw === "" || raw.length > 200 || raw[0] === "-" || /[\\/]/.test(raw) || raw === "." || raw === "..") {
        throw new ValueError(`takes an ${kind} id, not "${raw}"`);
      }
      return raw;
    },
  }, [
    { raw: "../x", stage: "parse", why: "a path step" },
    { raw: "-x", stage: "parse", why: "a flag look-alike" },
    { raw: "a/b", stage: "parse", why: "a separator" },
    { raw: "", stage: "parse", why: "empty" },
  ]);
}

/** 64 lowercase hex characters (Q6). The caller's voice supplies `expected` and the
 *  refusal, so `apply --expect` and `set receipts --set-id` keep their own sentences. */
export function checksum(format: "hex64", options: { expected: string; invalid(raw: string): string; example: string }): ValueKind<string, Checksum> {
  if (format !== "hex64") throw new Error(`unknown checksum format: ${format}`);
  return kindOf<string, Checksum>("checksum", {
    expected: options.expected,
    example: options.example,
    invalidExample: "zz",
    parse(raw) {
      if (!/^[0-9a-f]{64}$/.test(raw)) throw new ValueError(options.invalid(raw));
      return raw;
    },
  }, [
    { raw: "zz", stage: "parse", why: "not hexadecimal" },
    { raw: "", stage: "parse", why: "empty" },
  ], {
    resolve: async (value) => checksumOf(value),
  });
}

/** `operations <id>`, `rollback --operation`: the id grammar for a recorded operation id —
 *  the plan carries it branded (OperationId), and the record's existence stays the run's
 *  target fact (design §5.2). */
export function operationId(example: string): ValueKind<string, OperationId> {
  return { ...id("operation", example), resolve: async (value) => operationIdOf(value) };
}

/** `set receipts --receipt`: receipt.ts's own grammar — lowercase first character, no more
 *  than 128 of [a-z0-9._-] — which is stricter than the path-segment `id` (it rejects upper
 *  case and a leading dash/underscore), so it is wrapped exactly rather than narrowed to
 *  `id` (I14). Inlined rather than imported: receipt.ts reaches into commands/**, and
 *  core/values must not. */
export function receiptId(): ValueKind<string> {
  return kindOf("receipt", {
    expected: "a receipt id", example: "fresh-1", invalidExample: "Bad_Id",
    parse(raw) {
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(raw) || raw === "." || raw === "..") throw new ValueError(`: invalid receipt id "${raw}"`);
      return raw;
    },
  }, [
    { raw: "Bad_Id", stage: "parse", why: "an upper-case character" },
    { raw: "", stage: "parse", why: "empty" },
  ]);
}

/** A host id as recorded by the lock (`DESKTOP-1:win32`, `srv:linux-4026531836`, and
 *  suffix-less entries from before the platform suffix): only empty and control characters
 *  are refused — any stricter grammar would make someone else's lock unsolvable (I14). */
export function hostId(): ValueKind<string> {
  return kindOf("hostId", {
    expected: "a recorded host id",
    example: "DESKTOP-1:win32",
    invalidExample: "",
    parse(raw) {
      if (raw === "") throw new ValueError("needs a value");
      return raw;
    },
  }, [
    { raw: "", stage: "parse", why: "empty" },
    { raw: "a\u0007b", stage: "parse", why: "a control character" },
  ]);
}

/** An ssh destination, passed positionally to ssh/rsync without `--` (Q4): a leading dash
 *  would reach ssh as an option, so it is refused at parse. */
export function sshDestination(): ValueKind<string> {
  return kindOf("sshDestination", {
    expected: "an ssh destination (user@host)",
    example: "root@example.com",
    invalidExample: "-oProxyCommand=x",
    parse(raw) {
      if (raw === "") throw new ValueError("needs a value");
      if (raw[0] === "-" || /\s/.test(raw)) {
        throw new ValueError(takesNot("an ssh destination (user@host)")(raw));
      }
      return raw;
    },
  }, [
    { raw: "-oProxyCommand=x", stage: "parse", why: "a leading dash reaches ssh as an option" },
    { raw: "a b", stage: "parse", why: "whitespace" },
    { raw: "", stage: "parse", why: "empty" },
  ]);
}

/** A command name from the registry (N1): checked at parse with a did-you-mean guess, but
 *  never projected as a schema enum. `suggest` is injected to keep core/values out of
 *  core/command; the suffix matches the dispatcher's own did-you-mean wording. */
export function commandName(names: readonly string[], suggest: (input: string, candidates: readonly string[]) => string | undefined): ValueKind<string> {
  return kindOf("commandName", {
    expected: "a command name",
    example: names[0] ?? "",
    invalidExample: "no-such-command",
    parse(raw) {
      if (names.includes(raw)) return raw;
      const suggestion = suggest(raw, names);
      throw new ValueError(`unknown command: ${raw}${suggestion === undefined ? "" : ` (did you mean: ${suggestion}?)`}`);
    },
  }, [
    { raw: "no-such-command", stage: "parse", why: "not in the registry" },
    { raw: "", stage: "parse", why: "empty" },
  ]);
}

/** An absolute path, wrapped around the deploy boundary itself: validatedRemoteRoot's
 *  own multi-line refusal is kept verbatim, joined after the argument's label. Deploy's
 *  prepare-stage call stays — it normalizes the path for the plan. */
export function absolutePath(): ValueKind<string> {
  return kindOf("absolutePath", {
    expected: "an absolute path",
    example: "/opt/openclaw",
    invalidExample: "relative/x",
    parse(raw) {
      try {
        return validatedRemoteRoot(raw);
      } catch (error) {
        if (error instanceof UserError) throw new ValueError(`: ${(error as Error).message}`);
        throw error;
      }
    },
  }, [
    { raw: "relative/x", stage: "parse", why: "not an absolute POSIX path" },
    { raw: "", stage: "parse", why: "empty" },
    { raw: "a\u0000b", stage: "parse", why: "a control character" },
  ]);
}

/** A local file, named now and proven to exist as a regular file at the prepare stage
 *  (S2.5): the refusal is the artifact fact's own text, byte-identical. */
export function localFile(reason: string, example = "x"): ValueKind<string, LocalArtifact> {
  return kindOf<string, LocalArtifact>("localFile", nonEmptyGrammar(reason, example), [
    { raw: "", stage: "parse", why: "empty" },
    { raw: "absent.tar", stage: "prepare", why: "missing file" },
    { raw: "a\u0000b", stage: "parse", why: "a control character" },
  ], {
    resolve: async (value, local) => {
      if (!(await local.exists(value)) || !(await stat(value)).isFile()) throw new UserError(missingArtifactRefusal(value));
      return localArtifact(value);
    },
  });
}

function nonEmptyGrammar(expected: string, example = "x"): ValueParser<string> {
  return {
    expected,
    example,
    invalidExample: "",
    parse(raw) {
      if (raw === "") throw new ValueError("needs a value");
      return raw;
    },
  };
}

export function localDirectory(reason: string, example = "recipes/local"): ValueKind<string, LocalRecipeSource> {
  return kindOf<string, LocalRecipeSource>("localDirectory", nonEmptyGrammar(reason, example), [
    { raw: "", stage: "parse", why: "empty" },
    { raw: "absent-source", stage: "prepare", why: "missing directory" },
    { raw: "a\u0000b", stage: "parse", why: "a control character" },
  ], {
    resolve: async (value, local) => {
      if (!(await local.exists(resolvePath(value, "recipe.json")))) throw new UserError(missingRecipeSourceRefusal(value));
      return localRecipeSource(value);
    },
  });
}

/** A recipe name on the reader grammar; existence in the current source is the prepare-stage
 *  resolve (S2.5) — the recipe fact's own text, byte-identical. The recipes directory is
 *  dynamically imported: service/recipe reaches wide, and kinds.ts loads at declaration time. */
export function recipeRef(): ValueKind<RecipeName, RecipeRef> {
  return kindOf<RecipeName, RecipeRef>("recipeRef", nameValue("recipe"), [
    { raw: "Bad_Name", stage: "parse", why: "upper case and underscore" },
    { raw: "", stage: "parse", why: "empty" },
    { raw: "absent-recipe", stage: "prepare", why: "missing recipe" },
  ], {
    resolve: async (value, local) => {
      const { recipesDirectory } = await import("#src/service/recipe.ts");
      if (!(await local.exists(resolvePath(recipesDirectory(), value, "recipe.json")))) throw new UserError(missingRecipeRefusal(value));
      return recipeRefOf(value);
    },
  });
}

/** An image reference (`upgrade --image`): the image-ref grammar, whose split already
 *  refuses leading dashes and whitespace; control characters are refused by the kind's
 *  parse wrapper before the image-ref parser runs. */
export function image(): ValueKind<ImageRef> {
  return kindOf("image", {
    expected: "an image reference",
    example: "ghcr.io/openclaw/openclaw:latest",
    invalidExample: "not an image",
    parse(raw) {
      try {
        return parseImageRef(raw);
      } catch (error) {
        throw new ValueError(`: ${(error as Error).message}`);
      }
    },
  }, [
    { raw: "not an image", stage: "parse", why: "whitespace" },
    { raw: "", stage: "parse", why: "empty" },
    { raw: "a\u0000b", stage: "parse", why: "a control character" },
  ]);
}

// "multi" is for argv passed through to a remote command (exec/cli/host), where a `sh -c`
// script may span lines; TAB and LF stay accepted there, every other control character is refused.
export function text(reason: string, options: { leadingDash: "refuse" | "allow"; lines?: "single" | "multi"; example?: string } = { leadingDash: "refuse" }): ValueKind<string> {
  const refuseDash = options.leadingDash !== "allow";
  const refused = options.lines === "multi" ? CONTROL_BUT_LINES : CONTROL;
  const invalid: InvalidSample[] = [{ raw: "", stage: "parse", why: "empty" }];
  if (refuseDash) invalid.push({ raw: "-x", stage: "parse", why: "a flag look-alike" });
  invalid.push({ raw: "a\u0000b", stage: "parse", why: "a control character" });
  return kindOf("text", {
    expected: reason,
    example: options.example ?? "x",
    invalidExample: "",
    parse(raw) {
      if (raw === "") throw new ValueError("needs a value");
      if (refuseDash && raw[0] === "-") throw new ValueError(takesNot(reason)(raw));
      return raw;
    },
  }, invalid, { controls: refused });
}

/** A single-line value with its own grammar: `matches` decides; the caller supplies the voice
 *  (`expected`), a valid `example` and the parse-stage samples the sweep must see refused. */
export function grammar(options: { expected: string; example: string; invalid: readonly string[]; matches(raw: string): boolean }): ValueKind<string> {
  return kindOf("text", {
    expected: options.expected,
    example: options.example,
    invalidExample: options.invalid[0] ?? "",
    parse(raw) {
      if (!options.matches(raw)) throw new ValueError(takesNot(options.expected)(shown(raw)));
      return raw;
    },
  }, [
    ...options.invalid.map((raw): InvalidSample => ({ raw, stage: "parse", why: "outside the grammar" })),
    { raw: "", stage: "parse", why: "empty" },
    { raw: "a\u0000b", stage: "parse", why: "a control character" },
  ]);
}
