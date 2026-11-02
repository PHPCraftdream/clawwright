// The completion decision table, and the reference interpreter for it: each generated script
// (bash, zsh sharing its body verbatim, and pwsh) is this data plus the algorithm below — one
// decision implemented more than once, with no branch on a command name in either one. The
// table is built from the one command registry help, the MCP tool list and the docs table
// read, so a command completes because it is declared, not because a case arm named it. The
// words typed so far are read by the binder's own lenient scan (scanCall) — one parser, no
// second reading.

import { defaultActionOf, scanCall } from "../../core/command/parse/scan.ts";
import type { CallShape } from "../../core/command/parse/index.ts";
import type { CommandArgument } from "../../core/app.ts";
import type { CommandRegistry } from "../gate.ts";

/** One option's `choices`, offered at the position where its own value is typed. The scripts
 *  look this up by `command + scope + option` — the three fields, in that order. */
export interface OptionValues {
  readonly command: string;
  /** The action word the value sits under: "" for a single-action command, and either the
   *  option's own `actions` or every action for a multi-action one. */
  readonly scope: string;
  readonly option: string;
  readonly values: readonly string[];
}

/** The whole completion surface as data: what to offer before a command name, at the word
 *  right after it, past its action word, and at a choice-valued option's own value. */
export interface CompletionData {
  readonly appFlag: boolean;
  /** The registry's names alphabetically, and `--app` appended at the end when the gate has
   *  one — not sorted in, so the emitted text stays `… watch --app` as it has always been. */
  readonly top: readonly string[];
  /** Command → the candidates offered at the word immediately after it. */
  readonly first: ReadonlyMap<string, readonly string[]>;
  /** `"<command> <action>"` and `"<command> *"` → candidates; `*` is the fallback for an
   *  action word that is absent or unknown, where the shell cannot tell which was meant. */
  readonly after: ReadonlyMap<string, readonly string[]>;
  /** Each command's parse-level shape (from the registry entry): the action selection and the
   *  default action the candidate code reads through scanCall/defaultActionOf. Not rendered. */
  readonly shapes: ReadonlyMap<string, CallShape<CommandArgument>>;
  /** Pass-through commands (`verbatim: true` variadic) → their declared positional count. Once
   *  more non-flag words than that are typed, the tail is the child's literal text. */
  readonly verbatim: ReadonlyMap<string, number>;
  /** Pass-through commands → their declared flags and options (`--name`): a dash word outside
   *  this list starts the child's literal tail, as in the tokenizer's verbatim mode. */
  readonly verbatimFlags: ReadonlyMap<string, readonly string[]>;
  /** Each command's declared arguments — the tokenizer's own reading of the words typed so far
   *  decides the options-end `--`, the verbatim tail and an option awaiting its value. Not rendered. */
  readonly declared: ReadonlyMap<string, readonly CommandArgument[]>;
  /** Each command's value-taking options (`--name`), for the emitted interpreters' mirrors of
   *  the tokenizer's value consumption. */
  readonly valueOptions: ReadonlyMap<string, readonly string[]>;
  readonly values: readonly OptionValues[];
}

function flagName(argument: CommandArgument): string {
  return `--${argument.name}`;
}

/** Every entry of the registry as completion rows. `name`/`arguments` come from the same
 *  declaration --help, the MCP schema and the parser read, so nothing here is restated. */
export function completionData(registry: CommandRegistry, appFlag: boolean): CompletionData {
  const top = [...registry.names].sort();
  // --app is the gate's own selector, not a registry name; appended after them (the bash
  // script has always listed it last), and only where the gate actually has one.
  // A gate command's declared first-token aliases (e.g. --version) complete at the top level.
  for (const entry of registry.entries) top.push(...(entry.gate?.aliases ?? []));
  if (appFlag) top.push("--app");
  const first = new Map<string, readonly string[]>();
  const after = new Map<string, readonly string[]>();
  const values: OptionValues[] = [];
  const verbatim = new Map<string, number>();
  const verbatimFlags = new Map<string, readonly string[]>();
  const declared = new Map<string, readonly CommandArgument[]>();
  const shapes = new Map<string, CallShape<CommandArgument>>();
  const valueOptions = new Map<string, readonly string[]>();

  for (const entry of registry.entries) {
    const name = entry.name;
    const args = entry.arguments ?? [];
    declared.set(name, args);
    if (args.some((argument) => argument.kind === "variadic" && "verbatim" in argument && argument.verbatim === true)) {
      verbatim.set(name, args.filter((argument) => argument.kind === "positional").length);
      verbatimFlags.set(name, args.filter((argument) => argument.kind === "flag" || argument.kind === "option").map(flagName));
    }
    const shape = entry.shape;
    shapes.set(name, shape);
    const defaultAction = defaultActionOf(shape as CallShape);
    const flagArgs = args.filter((argument) => argument.kind === "flag" || argument.kind === "option");
    const options = args.filter((argument) => argument.kind === "option").map(flagName);
    if (options.length > 0) valueOptions.set(name, options);
    // A shared flag — core/app.ts documents an absent `actions` as belonging to the whole
    // command — plus --help, which every command answers.
    const globalFlags = [...new Set([...flagArgs.filter((argument) => argument.actions === undefined).map(flagName), "--help"])].sort();
    // Choice values are keyed command + action + option once the command declares an action
    // positional: the action word already typed scopes the lookup, so `set try` (no --kind)
    // never sees forget's values while `set forget --kind` does (R33-10).
    for (const argument of flagArgs) {
      if (!(argument.kind === "option" && argument.choices !== undefined)) continue;
      const option = flagName(argument);
      if (shape.actions === undefined) {
        values.push({ command: name, scope: "", option, values: argument.choices });
        continue;
      }
      // The default action (no action word typed) reads its own options at scope "".
      if (argument.actions === undefined || (defaultAction !== undefined && argument.actions.includes(defaultAction))) {
        values.push({ command: name, scope: "", option, values: argument.choices });
      }
      for (const action of argument.actions ?? Object.keys(shape.actions)) {
        values.push({ command: name, scope: action, option, values: argument.choices });
      }
    }
    if (shape.actions === undefined) {
      const positional = args.find(
        (argument): argument is CommandArgument & { choices: readonly string[] } =>
          argument.kind === "positional" && argument.choices !== undefined,
      );
      // The registry kind (decision N1: `help`'s positional, never a schema enum) offers the
      // command names at the word right after the command, exactly as its `choices` list did.
      let offersRegistryNames = false;
      for (const argument of args) {
        if (argument.kind === "positional" && (argument.parse as { kind?: string } | undefined)?.kind === "commandName") offersRegistryNames = true;
      }
      const registryNames = offersRegistryNames ? registry.names : undefined;
      // A non-action positional's choices (completion's shell, host's context, help's command)
      // belong at the word right after the command, before any flag is typed.
      const words = positional?.choices ?? registryNames;
      first.set(name, words === undefined ? globalFlags : [...new Set([...words, ...globalFlags])].sort());
      after.set(`${name} *`, globalFlags);
      continue;
    }
    const actionWords = Object.keys(shape.actions).sort();
    const perAction = new Map<string, readonly string[]>();
    for (const value of Object.keys(shape.actions)) {
      const scoped = flagArgs.filter((argument) => argument.actions?.includes(value) === true).map(flagName);
      perAction.set(value, [...new Set([...globalFlags, ...scoped])].sort());
    }
    // An OPTIONAL action positional means the command has an implicit default action —
    // backup's bare create, recipe's bare list: the declared default action. Its flags are the
    // fallback for the no-action and unknown-action cases, where the shell cannot know which
    // action is meant.
    const fallback = defaultAction === undefined
      ? globalFlags
      : [...new Set([...globalFlags, ...(perAction.get(defaultAction) ?? [])])].sort();
    first.set(name, [...new Set([...actionWords, ...fallback])].sort());
    for (const [value, flags] of perAction) after.set(`${name} ${value}`, flags);
    after.set(`${name} *`, fallback);
  }

  return { appFlag, top, first, after, verbatim, verbatimFlags, declared, valueOptions, values, shapes };
}

/** The candidates for one completion request — the one decision both emitted scripts
 *  implement, so a script and the table it was rendered from cannot quietly diverge. `words`
 *  is every token after the program name and `cword` the index of the word being completed.
 *  The partial word itself is deliberately not consulted: the shells filter the list
 *  (compgen -W … -- "$cur"), the reference answers with the table as it stands.
 *  `appNames` stands in for the lazy `list --json` call the scripts make for --app's value. */
export function completionCandidates(
  data: CompletionData,
  words: readonly string[],
  cword: number,
  appNames: () => readonly string[],
): readonly string[] {
  // Only the words BEFORE the cursor pick the command — the partial word itself is not a
  // typed command (R32-02: `clawwright sta<Tab>` used to see the command "sta").
  const scan = words.slice(0, cword);
  const prev = scan.at(-1);
  // --app leads the command line and takes the next word as its own value: step over both.
  // The `--app=<name>` form carries its own value in one token: step over that token alone.
  let i = 0;
  while (data.appFlag && (scan[i] === "--app" || scan[i]?.startsWith("--app=") === true)) i += scan[i] === "--app" ? 2 : 1;
  if (i >= scan.length) {
    // --app's own value, offered only while no command word has been typed yet: past one it
    // is positional and must come before the command, so the command's flags return (R33-10).
    if (prev === "--app") return appNames();
    return data.top;
  }
  const cmd = scan[i];
  const candidates = data.first.get(cmd);
  if (candidates === undefined) return [];
  const between = scan.slice(i + 1);
  // Nothing after the command means the word being completed IS its own first positional —
  // an action word, typed in full or in part.
  if (between.length === 0) return candidates;
  // The words typed so far are read by the tokenizer itself (leniently: a refusal is not an
  // answer here). One rule, shared by both shells: past a bare `--` that is no option's value
  // nothing is offered, refused or not; nor inside a pass-through command's literal tail (the
  // first dash word it does not declare, or the first word past its positionals); and a word
  // that follows an option still waiting for its value completes that value — its `choices`
  // or, with none declared, nothing. Anything else offers the command's own flags.
  const shape = data.shapes.get(cmd);
  if (shape === undefined) return [];
  const declared = data.declared.get(cmd) ?? [];
  // The shape's own per-action slices are the scan slices for a typed action; scanCall's
  // fallback (still `declared`) covers the unknown/absent-action case — the design's fallback
  // rule: a completion reads the command's ONE declaration only when no action is known.
  const scanned = scanCall(shape, between, cmd, { verbatimTail: data.verbatim.has(cmd), fallback: declared });
  if (scanned.optionsEnded) return [];
  if (data.verbatim.has(cmd) && scanned.entries.some((entry) => entry.argument.kind === "variadic")) return [];
  // The first word names the action — the core selector's own answer, taken leniently by
  // the scan itself: a refused selection is recorded, `selected.name` stays undefined, and
  // a completion asks rather than refuses, so it scopes nothing (as a table miss used to).
  const action = scanned.selected.name ?? "";
  if (scanned.pending !== undefined) {
    const option = `--${scanned.pending.name}`;
    return data.values.find((row) => row.command === cmd && row.scope === action && row.option === option)?.values ?? [];
  }
  return data.after.get(`${cmd} ${between[0]}`) ?? data.after.get(`${cmd} *`) ?? [];
}
