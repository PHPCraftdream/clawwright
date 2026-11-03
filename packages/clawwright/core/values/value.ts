// Parsers for one argument's value: the text a user types becomes the typed value, or a
// ValueError that `bind` (core/command/parse.ts) turns into an ArgumentError naming the argument.

import { UserError } from "#src/core/io/log.ts";
import { readName, createName, type NameKind, type NameOf } from "#src/core/values/names.ts";

/** A refused value. `clause` is the text after the argument's label (`--tail`, `<name>`):
 *  `takes a number of lines, not "abc"`. A clause starting with ":" attaches to the label
 *  without a space (`--image: "x" is not …`). */
export class ValueError extends UserError {
  name = "ValueError";
  readonly clause: string;
  constructor(clause: string) {
    super(clause);
    this.clause = clause;
  }
}

/** `example` parses, `invalidExample` is refused: the property check (and value.check.ts)
 *  derive their argv from them instead of guessing a value per argument. */
export interface ValueParser<T> {
  readonly expected: string;
  readonly example: string;
  readonly invalidExample: string;
  parse(raw: string): T;
}

/** The refusal text for a raw value; defaults to `takes <expected>, not "<raw>"`. */
export type Refusal = (raw: string) => string;

const takesNot = (expected: string): Refusal => (raw) => `takes ${expected}, not "${raw}"`;

/** A whole number >= 0 (digits only). */
export function countValue(expected = "a non-negative integer", refusal: Refusal = takesNot(expected)): ValueParser<number> {
  return {
    expected, example: "5", invalidExample: "abc",
    parse(raw) {
      if (!/^\d+$/.test(raw)) throw new ValueError(refusal(raw));
      return Number(raw);
    },
  };
}

/** A whole number bounded above (seconds to wait, lines to keep …). */
export function boundedCountValue(max: number, expected = `a whole number from 0 to ${max}`): ValueParser<number> {
  return {
    expected, example: "30", invalidExample: String(max + 1),
    parse(raw) {
      if (!/^\d+$/.test(raw) || Number(raw) > max) throw new ValueError(takesNot(expected)(raw));
      return Number(raw);
    },
  };
}

/** A TCP port, 1-65535. Empty is its own refusal, as `--local-port` has always had. */
export const PORT_RANGE = "must be a port number between 1 and 65535";

export function portRefusal(raw: string): string {
  return raw === "" ? "needs a port number" : `${PORT_RANGE}, got: ${raw}`;
}

export function portValue(refusal: Refusal = portRefusal): ValueParser<number> {
  return {
    expected: "a port number between 1 and 65535", example: "8080", invalidExample: "70000",
    parse(raw) {
      if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > 65535) throw new ValueError(refusal(raw));
      return Number(raw);
    },
  };
}

/** A regular expression; the empty pattern is valid. */
export function regexValue(expected = "a valid regular expression"): ValueParser<RegExp> {
  return {
    expected, example: "error|warn", invalidExample: "(",
    parse(raw) {
      try {
        return new RegExp(raw);
      } catch (error) {
        throw new ValueError(`takes ${expected}: ${(error as Error).message}`);
      }
    },
  };
}

/** A name that becomes a path segment (readName): the refusal is readName's own sentence. */
export function nameValue<K extends NameKind>(kind: K): ValueParser<NameOf<K>> {
  return {
    expected: `a ${kind} name`, example: "local", invalidExample: "Bad_Name",
    parse(raw) {
      try {
        return readName(kind, raw);
      } catch (error) {
        throw new ValueError(`: ${(error as Error).message}`);
      }
    },
  };
}

/** A name about to be minted (newName): the reader grammar plus the Windows device names,
 *  refused at parse for commands that create the named thing. */
export function newNameValue<K extends NameKind>(kind: K): ValueParser<NameOf<K>> {
  return {
    expected: `a ${kind} name`, example: "local", invalidExample: "aux",
    parse(raw) {
      try {
        return createName(kind, raw);
      } catch (error) {
        throw new ValueError(`: ${(error as Error).message}`);
      }
    },
  };
}

/** A path segment under the target's data directory (`operations <id>`): one file name
 *  inside one directory — never empty, never a flag look-alike, never a separator or a
 *  dot run, so an id can only name a file where the reader looks it up. */
export function pathSegmentValue(expected: string, example: string): ValueParser<string> {
  return {
    expected, example, invalidExample: "../x",
    parse(raw) {
      // oxlint-disable-next-line no-control-regex -- Control characters cannot name a path segment.
      if (raw === "" || raw.length > 200 || raw[0] === "-" || /[\\/]/.test(raw) || raw === "." || raw === ".." || /[\u0000-\u001f]/.test(raw)) {
        throw new ValueError(`takes ${expected}, not "${raw}"`);
      }
      return raw;
    },
  };
}

export function nonEmptyValue(expected = "a value"): ValueParser<string> {
  return {
    expected, example: "x", invalidExample: "",
    parse(raw) {
      if (raw === "") throw new ValueError("needs a value");
      return raw;
    },
  };
}
