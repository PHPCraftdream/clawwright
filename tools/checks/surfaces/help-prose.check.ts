// Help-prose tokens (design 2.1–2.3): every `{…}` span in a declaration's `details` must
// read as a token, `{clawwright …}` must name a command that takes the argv it spells, and
// `{--name}` must be a flag this very command declares — so a renamed flag breaks the
// check, not the help. The declarations are read from the one command registry
// (entry/registry.ts) — the same list help, completion and the docs table read.
//
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";
import type { CommandArgument } from "#framework/core/app.ts";
import {
  ArgumentError, UnknownActionError, UnknownArgumentError, parseCall, specOf, specShape, tokenize,
} from "#framework/core/command/index.ts";
import { surfaceRegistry } from "#framework/entry/registry.ts";
import { parseProse, type ProseToken } from "#framework/core/io/invocation/prose.ts";
import { checkTrue, finish } from "#checks/kit/harness.ts";

// Every declaration any surface reads — the deployment commands, the gate's own, and the two
// dispatcher commands — straight from the one registry (entry/registry.ts). A RegistryEntry
// already carries the name/details/arguments this prose check reads.
interface ProseDeclaration {
  readonly name: string;
  readonly details?: string;
  readonly arguments?: readonly CommandArgument[];
}

const registry = surfaceRegistry();
const declarations: readonly ProseDeclaration[] = registry.entries;
const byName = new Map(declarations.map((declaration) => [declaration.name, declaration]));

/** A `<placeholder>` stands in for one plain word (design 4.2's P4); what example the
 *  declaration would offer is its business, not the token's. */
const PLACEHOLDER = /^<.*>$/;
const EXAMPLE = "x";

/** Every `{…}` span claiming to be a token: one whose content opens with neither clawwright
 *  nor -- is prose (JSON in the text) and ignored. Tokens do not nest, so a span ends at
 *  the first "}". */
function claimedSpans(details: string): readonly string[] {
  return (details.match(/\{[^{}]*\}/g) ?? []).filter((span) => {
    const content = span.slice(1, -1);
    // install too (rf6-fix33): an {install ...} span is a command line a user pastes, so it
    // answers to the same registry check — a typo in it used to read as plain text.
    return content.startsWith("clawwright") || content.startsWith("install") || content.startsWith("--");
  });
}

/** Why the parser refuses an argv, undefined when it accepts it. Strict about names, lenient
 *  about values: a placeholder filled with `x` can still violate an argument's own
 *  choices/parse, and that is the declaration's shape talking — an ArgumentError naming an
 *  argument this declaration has is left alone, one naming anything else (an unknown flag,
 *  an unknown action word) is the token's fault. */
function parseProblem(parse: () => unknown, declared: readonly CommandArgument[] | undefined): string | undefined {
  try {
    parse();
    return undefined;
  } catch (error) {
    if (error instanceof UnknownActionError || error instanceof UnknownArgumentError) return error.message;
    if (error instanceof ArgumentError) {
      const named = error.argument !== undefined && declared?.some((argument) => argument.name === error.argument) === true;
      return named ? undefined : error.message;
    }
    return String(error);
  }
}

function tokenProblem(token: ProseToken, declaration: ProseDeclaration): string | undefined {
  const declared = declaration.arguments ?? [];
  if (token.kind === "program") return undefined;
  if (token.kind === "flag") {
    return declared.some((argument) => argument.name === token.name) ? undefined : `--${token.name} is not a flag this command declares`;
  }
  const argv = token.argv.map((word) => (PLACEHOLDER.test(word) ? EXAMPLE : word));
  const [word, ...rest] = argv;
  if (word === undefined) return "no command word — a lone --app is not a command";
  const target = registry.find(word);
  if (target === undefined) return `unknown command: ${word}`;
  // A spec command parses its whole call shape (actions, per-action arguments); a gate command
  // or a dispatcher command tokenizes its declared arguments — `help`'s positional and
  // `control-mcp`'s empty list fall out of that, with no per-name branch left.
  if (target.command !== undefined) {
    const body = specOf(target.command);
    if (body === undefined) return `${word} has no declared command body`;
    return parseProblem(() => parseCall(specShape(body), rest, word), target.arguments);
  }
  return parseProblem(() => tokenize(target.arguments ?? [], rest), target.arguments);
}

function validateProse(declaration: ProseDeclaration, details: string): void {
  for (const span of claimedSpans(details)) {
    const tokens = parseProse(span);
    checkTrue(`${declaration.name}: token ${span} reads as one token`, tokens.length === 1);
    const token = tokens[0];
    if (token === undefined) continue;
    const problem = tokenProblem(token, declaration);
    checkTrue(`${declaration.name}: token ${span}${problem === undefined ? "" : ` — ${problem}`}`, problem === undefined);
  }
}

for (const declaration of declarations) {
  if (declaration.details === undefined) continue;
  validateProse(declaration, declaration.details);
}

// The synthetic table keeps the rules live against the real declarations, which now carry
// {clawwright …} tokens of their own (the advice matrix's group 5 rows). Every string parses
// and must be accepted; a rule that
// stopped rejecting a broken token fails here first.
const SYNTHETIC_TOKENS: readonly (readonly [string, string])[] = [
  ["status", "{clawwright}"],
  ["status", "{clawwright --app <name> status}"],
  ["status", "{clawwright status --json}"],
  ["status", "{--json}"],
  ["logs", "{clawwright logs --tail <n>}"],
  ["apply-config", "{clawwright apply-config --dump --force}"],
  ["apply-config", "{--dry-run}"],
  ["backup", "{clawwright backup list --json}"],
  ["set", "{clawwright set validate --json}"],
  ["check", "{clawwright help logs}"],
  ["check", "{clawwright check --list}"],
  ["list", "{--no-status}"],
  ["version", "{clawwright version --json}"],
  ["control-mcp", "{clawwright control-mcp}"],
];
for (const [name, text] of SYNTHETIC_TOKENS) {
  const declaration = byName.get(name);
  checkTrue(`synthetic token table names a real declaration: ${name}`, declaration !== undefined);
  if (declaration !== undefined) validateProse(declaration, text);
}

// Group data must not freeze an invocation into a command line: a renderer call in a group
// file or in service/inspection.ts bakes the program spelling into the declaration.
const RENDERER_CALLS = ["commandLine(", "renderAdvice("];
const groupsDir = resolve(monorepoRoot, "packages", "clawwright", "commands", "interface", "groups");
const structureFiles = [
  ...(await readdir(groupsDir)).filter((name) => name.endsWith(".ts")).map((name) => resolve(groupsDir, name)),
  resolve(monorepoRoot, "packages", "clawwright", "service", "inspection.ts"),
];
for (const file of structureFiles) {
  const text = await readFile(file, "utf8");
  const name = relative(monorepoRoot, file).split("\\").join("/");
  for (const call of RENDERER_CALLS) checkTrue(`${name} holds no ${call}`, !text.includes(call));
}

finish("help prose");
