// Section 2b of completion-behaviour.check.ts (split out at S2.8 for the 700-line layout
// limit): the lenient scan itself — the evidence the negative controls aim at. scanCall is
// what completionCandidates reads the typed words with. The refusal contracts run over EVERY
// registry entry whose arguments declare at least one option AND one flag (gate commands
// qualify: their shape is the plain `{ arguments }`), with argv holding the tokens AFTER the
// command name — scanCall's selectAction reads argv[0] as the action word, so the command
// name is never prepended. This file also hosts the PRE-fix interpreter reading the
// design-section-9 differentials are judged against.

import type { CommandArgument } from "#framework/core/app.ts";
import { scanCall } from "#framework/core/command/parse/scan.ts";
import type { CallShape } from "#framework/core/command/parse/index.ts";
import type { CompletionData } from "#framework/integration/completion/table.ts";
import type { CompletionScenario } from "./scenarios.ts";
import { check } from "#checks/kit/harness.ts";

type ScanEntry = {
  readonly name: string;
  readonly arguments?: readonly CommandArgument[];
  readonly shape: CallShape<CommandArgument>;
};

const sameCandidates = (left: readonly unknown[], right: readonly unknown[]): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** Runs the scanCall refusal contracts against the completion table's data. */
export function scanContracts(
  registry: { readonly entries: readonly ScanEntry[] },
  data: CompletionData,
  at: (shape: CompletionData, words: readonly string[], cword: number) => readonly string[],
  norm: (values: readonly string[]) => string[],
): void {
  const eligible = registry.entries.filter((entry) => {
    const args = entry.arguments ?? [];
    return args.some((argument) => argument.kind === "option") && args.some((argument) => argument.kind === "flag");
  });
  check("the declarations offer option+flag entries for the scan contracts", eligible.length > 0, true);
  for (const entry of eligible) {
    const declared = entry.arguments ?? [];
    // The contracts are about the tokenizer, not the action selector: every multi-action
    // entry is read against the merged fallback — the dashed first token refuses the action
    // selection there — exactly like the single-shape `{ arguments }` entries. The selection
    // refusal carries its own "unknown-action" reason, so it never joins the unknown count.
    const shape = entry.shape.actions === undefined ? entry.shape : { ...entry.shape, defaultAction: undefined };
    const optionName = declared.find((argument) => argument.kind === "option")!.name;
    const flagName = declared.find((argument) => argument.kind === "flag")!.name;
    const option = `--${optionName}`;
    const flagToken = `--${flagName}`;
    const scan = { fallback: declared };

    const missing = scanCall(shape, [option, flagToken], entry.name, scan);
    const missingRefusal = missing.refusals.find((refusal) => refusal.reason === "option-missing-value");
    check(`${entry.name}: the flag binds as a flag behind a pending option`,
      [missing.refusals.filter((refusal) => refusal.reason === "option-missing-value").length,
       missingRefusal !== undefined && missingRefusal.token === flagToken && missingRefusal.name === optionName,
       missing.entries.some((token) => token.argument.name === flagName && token.value === true),
       missing.entries.some((token) => token.argument.name === optionName),
       missing.pending],
      [1, true, true, false, undefined]);

    const repeated = scanCall(shape, [option, "x", option, "y"], entry.name, scan);
    const repeatedRefusal = repeated.refusals.find((refusal) => refusal.reason === "option-repeated");
    check(`${entry.name}: a repeated option overwrites its value`,
      [repeated.entries.filter((token) => token.argument.name === optionName).map((token) => token.value),
       repeated.given.filter((name) => name === optionName).length,
       repeatedRefusal !== undefined && repeatedRefusal.token === option && repeatedRefusal.name === optionName],
      [["y"], 2, true]);

    const skipped = scanCall(shape, ["--bogus", flagToken], entry.name, scan);
    const skippedRefusal = skipped.refusals.find((refusal) => refusal.reason === "unknown");
    check(`${entry.name}: an unknown token does not move the state`,
      [skipped.refusals.filter((refusal) => refusal.reason === "unknown").length,
       skippedRefusal !== undefined && skippedRefusal.token === "--bogus",
       skipped.entries.some((token) => token.argument.name === flagName && token.value === true),
       skipped.entries.some((token) => token.argument.name === optionName),
       skipped.tail],
      [1, true, true, false, false]);

    // Same candidates, different reason: where the shape is a plain `{ arguments }` (no
    // action selection) the flags behind the refusal are the command's own — the fallback
    // row. A multi-action shape reads the SELECTED action's slice, so its answer belongs to
    // the slice the action names, not to the merged fallback row.
    if (entry.shape.actions === undefined) {
      const fallbackRow = norm(data.after.get(`${entry.name} *`) ?? []);
      check(`${entry.name}: the flag row answers behind a pending option and a bound flag`,
        sameCandidates(norm(at(data, [entry.name, option, flagToken, ""], 3)), fallbackRow), true);
      // A verbatim tail (cli, exec) begins at the first unknown token: nothing behind it is a flag of ours.
      if (!declared.some((argument) => argument.kind === "variadic" && (argument as { verbatim?: boolean }).verbatim === true)) {
        check(`${entry.name}: the flag row answers behind an unknown token`,
          sameCandidates(norm(at(data, [entry.name, "--bogus", ""], 2)), fallbackRow), true);
      }
    }

    const inline = scanCall(shape, [`${option}=v`], entry.name, scan);
    const refusedInline = scanCall(shape, [`${flagToken}=v`, flagToken], entry.name, scan);
    const inlineRefusal = refusedInline.refusals.find((refusal) => refusal.reason === "flag-with-value");
    check(`${entry.name}: an inline --opt=v binds and a --flag=v is skipped`,
      [inline.entries.filter((token) => token.argument.name === optionName).map((token) => token.value),
       inline.pending,
       inlineRefusal !== undefined && inlineRefusal.token === `${flagToken}=v` && inlineRefusal.name === flagName,
       refusedInline.entries.some((token) => token.argument.name === flagName && token.value === true)],
      [["v"], undefined, true, true]);

    // FIX 1's contract: a repeated PENDING option must end PENDING (design section 9's
    // overwrite) — the bounded recovery loop clears the pending, recovers the repeat and
    // re-pends the option; skipping the repeat instead loses the second token.
    const repeatPending = scanCall(shape, [option, option], entry.name, scan);
    check(`${entry.name}: a repeated pending option ends pending`,
      [repeatPending.refusals.filter((refusal) => refusal.reason === "option-missing-value").length,
       repeatPending.refusals.filter((refusal) => refusal.reason === "option-repeated").length,
       repeatPending.entries.some((token) => token.argument.name === optionName),
       repeatPending.pending?.name,
       repeatPending.given],
      [1, 1, false, optionName, [optionName, optionName]]);
  }

  // A multi-action entry whose first option has no scope-"" values row: the refused action
  // selection scopes nothing, the option IS pending, and the value lookup lands on no row.
  // The SELECTION record (reason "unknown-action") is read here, not the tokenizer's.
  const scoped = registry.entries.filter((entry) => {
    if (entry.shape.actions === undefined) return false;
    const own = (entry.arguments ?? []).find((argument) => argument.kind === "option");
    return own !== undefined
      && !data.values.some((row) => row.command === entry.name && row.scope === "" && row.option === `--${own.name}`);
  });
  check("the declarations offer scoped multi-action entries for the scan contracts", scoped.length > 0, true);
  for (const entry of scoped) {
    const scopedOptionName = (entry.arguments ?? []).find((argument) => argument.kind === "option")!.name;
    const refused = scanCall(entry.shape, ["zz", `--${scopedOptionName}`], entry.name, { fallback: entry.arguments });
    check(`${entry.name}: a refused action selection scopes nothing`,
      [refused.selected.name,
       refused.refusals.filter((refusal) => refusal.reason === "unknown-action").map((refusal) => refusal.token),
       refused.pending?.name],
      [undefined, ["zz"], scopedOptionName]);
    check(`${entry.name}: the refused selection's value lookup finds no row`,
      at(data, [entry.name, "zz", `--${scopedOptionName}`, ""], 3), []);
  }

  // The verbatim counterpart: there the undeclared dash word legitimately STARTS the tail —
  // step() orders tail-start before the unknown refusal, and that is pinned R4-1 above.
  const passthrough = registry.entries.filter((entry) => (entry.arguments ?? []).some(
    (argument) => argument.kind === "variadic" && "verbatim" in argument && argument.verbatim === true));
  check("the declarations offer verbatim entries for the scan contracts", passthrough.length > 0, true);
  for (const entry of passthrough) {
    const tail = scanCall(entry.shape, ["--bogus", "--root", "x"], entry.name,
      { verbatimTail: true, fallback: entry.arguments });
    check(`a verbatim tail still starts at the undeclared dash word (${entry.name} --bogus)`,
      [tail.tail, tail.refusals,
       tail.entries.filter((token) => token.argument.kind === "variadic").map((token) => token.value).slice(-3)],
      [true, [], ["--bogus", "--root", "x"]]);
  }
}

/** The old scanShape construction: every action's arguments widened to the command's merged
 *  declared list — the slice the frozen interpreters read before the slice fix. */
function widenedShape(data: CompletionData, cmd: string): CallShape<CommandArgument> | undefined {
  const shape = data.shapes.get(cmd);
  const declared = data.declared.get(cmd) ?? [];
  if (shape === undefined) return undefined;
  if (shape.actions === undefined) return shape;
  return {
    ...shape,
    actions: Object.fromEntries(
      Object.keys(shape.actions).map((word) => [word, { ...shape.actions![word], arguments: declared }])),
  };
}

/** The FROZEN interpreter reading (design section 9): an independent tiny model of the rule
 *  the emitted bash/pwsh scripts implement — branch for branch from the interpreter, over the
 *  merged/widened table data only (no scanCall, no step). An option in `valueOptions` swallows
 *  the NEXT token whatever it is; a bare `--` ends the options; a pass-through command's
 *  literal tail starts at its first undeclared dash word or its first word past the declared
 *  positional count; otherwise a pending swallow reads its values row at the scope, else the
 *  after row for the first word typed or the `*` fallback. It documents the interpreter; it is
 *  not the oracle. */
export function mergedReadingFor(
  data: CompletionData,
  appNames: () => readonly string[],
): (scenario: CompletionScenario) => string[] {
  return (scenario) => {
    const words = scenario.words.slice(0, scenario.cword);
    let i = 0;
    while (data.appFlag && (words[i] === "--app" || words[i]?.startsWith("--app=") === true)) i += words[i] === "--app" ? 2 : 1;
    if (i >= words.length) {
      if (words.at(-1) === "--app") return [...appNames()];
      return [...data.top];
    }
    const cmd = words[i]!;
    const candidates = data.first.get(cmd);
    if (candidates === undefined) return [];
    const between = words.slice(i + 1);
    if (between.length === 0) return [...candidates];
    const opts = data.valueOptions.get(cmd) ?? [];
    const positionals = data.verbatim.get(cmd);
    const isVerb = positionals !== undefined;
    const flags = isVerb ? data.verbatimFlags.get(cmd) ?? [] : [];
    let ended = false;
    let tail = false;
    let swallow = false;
    let free = 0;
    for (const token of between) {
      if (swallow) { swallow = false; continue; }
      if (token === "--") { ended = true; break; }
      let key = token;
      let inline = false;
      if (token.startsWith("--") && token.includes("=")) { key = token.slice(0, token.indexOf("=")); inline = true; }
      if (!inline && token !== "" && opts.includes(token)) { swallow = true; continue; }
      if (token.startsWith("-")) {
        if (isVerb && !flags.includes(key)) { tail = true; break; }
        continue;
      }
      free += 1;
      if (isVerb && free > positionals) { tail = true; break; }
    }
    if (ended || tail) return [];
    const firstRow = `${cmd} ${between[0]}`;
    const scope = between[0] !== undefined && !between[0].startsWith("-") && data.after.has(firstRow) ? between[0] : "";
    if (swallow) {
      const lastWord = between.at(-1) ?? "";
      const row = data.values.find((candidate) => candidate.command === cmd
        && candidate.scope === scope && candidate.option === lastWord);
      return [...(row?.values ?? [])];
    }
    return [...(data.after.get(firstRow) ?? data.after.get(`${cmd} *`) ?? [])];
  };
}

/** The divergences the design documents (section 9), recomputed on the model scan: a pending
 *  option followed by a declared long token (the frozen interpreter swallows it, the binder
 *  refuses it — option-missing-value), a pending option the SELECTED slice does not hold, or
 *  an action selection refused outright ("unknown-action" — a pending found through the
 *  fallback scan) — the interpreter mirrors valueOptions per command, never per action slice. */
export function checkDivergences(
  shell: string,
  scenarios: readonly CompletionScenario[],
  divergent: readonly string[],
  data: CompletionData,
): void {
  const unexplained: string[] = [];
  for (const name of divergent) {
    const scenario = scenarios.find((candidate) => candidate.name === name);
    if (scenario === undefined) { unexplained.push(name); continue; }
    const words = scenario.words.slice(0, scenario.cword);
    let i = 0;
    while (data.appFlag && (words[i] === "--app" || words[i]?.startsWith("--app=") === true)) i += words[i] === "--app" ? 2 : 1;
    if (i >= words.length) continue;
    const cmd = words[i]!;
    const shape = data.shapes.get(cmd);
    if (shape === undefined) { unexplained.push(name); continue; }
    const between = words.slice(i + 1);
    const options = { verbatimTail: data.verbatim.has(cmd), fallback: data.declared.get(cmd) ?? [] };
    const scanned = scanCall(shape, between, cmd, options);
    const merged = scanCall(widenedShape(data, cmd)!, between, cmd, options);
    // Family (a): a pending option followed by a declared long token — the frozen
    // interpreter swallows it, the binder refuses it (option-missing-value, whichever scan
    // records it: the model's slice and the merged reading part ways exactly there).
    const pendingThenDeclaredToken = [scanned.refusals, merged.refusals].some((refusals) =>
      refusals.some((refusal) => refusal.reason === "option-missing-value"));
    // Family (b): the interpreter's merged reading binds (or leaves pending) an option the
    // SELECTED slice does not hold — a slice miss, or a pending found through the fallback
    // after a refused action selection: it mirrors valueOptions per command, never per slice.
    const pendingOutsideSlice = merged.pending !== undefined
      && !scanned.slice.some((argument) => argument.name === merged.pending!.name);
    const boundOutsideSlice = merged.entries.some((token) =>
      (token.argument.kind === "flag" || token.argument.kind === "option")
      && !scanned.slice.some((argument) => argument.name === token.argument.name));
    const selectionRefused = scanned.refusals.some((refusal) =>
      refusal.reason === "unknown-action" && refusal.token === between[0]);
    if (!(pendingThenDeclaredToken || pendingOutsideSlice || boundOutsideSlice || selectionRefused)) unexplained.push(name);
  }
  check(`${shell}: every divergence is one of design section 9's two families`, unexplained, []);
}
