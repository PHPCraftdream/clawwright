// The shared counter behind the stage-7 S2.5 grammar ratchet (NC-S2-grammar-in-run).
//
// S2.5 moved every name's existence/grammar refusal to the declaration/prepare stage: run
// bodies receive already-minted, branded names from the plan and must NEVER re-validate
// them through the grammar mints (`readName`/`safeName`/`nameValue`/`createName`) or the
// image-reference parse (`imageRefValue.parse`) — a re-read in run would re-derive the name
// the resolve already proved, and a prepare-stage grammar regression would resurface as a
// run-stage failure instead of a refusal with zero contacts. grammar-in-run.check.ts is the
// zero-tolerance enforcer; architecture.check.ts records the same measurement as a ratchet,
// so there is ONE measurement and the table cannot drift from the check.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";

export const GRAMMAR_MINT = /\b(?:readName|safeName|nameValue|createName)\s*\(|\bimageRefValue\.parse\s*\(/;

/** Skips a balanced `(...)` group starting at `open` (the index of `(`); returns the index
 *  just past the matching `)`, or `text.length` when unbalanced. */
function skipParens(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** Body of a brace block starting at `open` (the index of `{`), matched naively (braces in
 *  string literals could over-close; the violations then only widen, never hide). */
function braceBody(text: string, open: number): { readonly body: string; readonly start: number; readonly end: number } {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return { body: text.slice(open + 1, i), start: open + 1, end: i + 1 };
    }
  }
  return { body: text.slice(open + 1), start: open + 1, end: text.length };
}

/** Expression arrow body: from just past `=>` to the newline where the parenthesis depth
 *  (carried from the parameter list) returns to zero. */
function expressionBody(text: string, start: number, depth: number): { readonly body: string; readonly start: number; readonly end: number } {
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        // The arrow expression may continue past its call's closing paren (`.then(...)`,
        // `?? x`) — run to the end of the line instead of stopping at the paren.
        const lineEnd = text.indexOf("\n", i);
        return { body: text.slice(start, lineEnd === -1 ? text.length : lineEnd), start, end: lineEnd === -1 ? text.length : lineEnd + 1 };
      }
    } else if (ch === "\n" && depth <= 0) return { body: text.slice(start, i), start, end: i + 1 };
  }
  return { body: text.slice(start), start, end: text.length };
}

/** One run body the scan saw: the body text, the line of the run site (or of the helper
 *  declaration an indirection resolved to), and — for the indirection forms — the same-file
 *  helper's name, named in the site text so a violation is attributable. */
export interface RunBody {
  readonly body: string;
  readonly line: number;
  readonly via?: string;
}

/** The declaration of a same-file helper: `function name(`, `async function name(`,
 *  `const name = (` or `const name = async (`. Returns the index of the match, or -1. */
function helperDeclaration(text: string, name: string): number {
  const identifier = name.replace(/\$/g, "\\$");
  const decl = new RegExp(
    `\\b(?:async\\s+function\\s+${identifier}\\s*\\(|function\\s+${identifier}\\s*\\(|const\\s+${identifier}\\s*=\\s*(?:async\\s*)?\\()`,
  ).exec(text);
  return decl === null ? -1 : decl.index;
}

/** The body of the arrow (or function) whose parameters start at `open` (the index of `(`):
 *  a brace block when the arrow opens with `{`, otherwise an expression body. */
function arrowBody(text: string, open: number): { readonly body: string; readonly start: number; readonly end: number } | undefined {
  const paramsEnd = skipParens(text, open);
  const arrow = /\s*=>/.exec(text.slice(paramsEnd, paramsEnd + 16));
  if (arrow === null) return undefined;
  const bodyStart = paramsEnd + arrow[0].length + (text.slice(paramsEnd + arrow[0].length).match(/^\s*/)?.[0].length ?? 0);
  if (text[bodyStart] === "{") {
    const { body, start, end } = braceBody(text, bodyStart);
    return { body, start, end };
  }
  // Parameter parens are closed; the expression starts at depth 0, but an expression that
  // continues over multiple lines through nested parens keeps consuming (expressionBody).
  const { body, start, end } = expressionBody(text, bodyStart, 0);
  return { body, start, end };
}

/** The body of a same-file helper `name`, following the run site's indirection one hop:
 *  `run: helper` and `run: (…) => helper(…)` attribute the helper's body to the run. */
function helperBody(text: string, name: string): { readonly body: string; readonly start: number; readonly end: number } | undefined {
  const at = helperDeclaration(text, name);
  if (at === -1) return undefined;
  const open = text.indexOf("(", at);
  const fn = /^async\s+function|^function/.exec(text.slice(at));
  if (fn !== null) {
    const paramsEnd = skipParens(text, open);
    // A declaration's return type annotation (`): Promise<void> {`) may sit between the
    // parameters and the block — take the next `{` before the header can have ended.
    const braceIndex = text.indexOf("{", paramsEnd);
    const header = braceIndex === -1 ? "" : text.slice(paramsEnd, braceIndex);
    if (braceIndex === -1 || header.includes(";") || header.includes("=")) return undefined;
    const { body, start, end } = braceBody(text, braceIndex);
    return { body, start, end };
  }
  // `const name = (…) => …` — the body extraction of an ordinary arrow.
  return arrowBody(text, open);
}

/** The run bodies of one source file: every `run:` property arrow (block and expression),
 *  every `run(...)` method body, and the indirection forms — `run: helperName` and
 *  `run: (…) => helperName(…)` resolve to the SAME-FILE declaration of that identifier and
 *  attribute its body too. */
export function runBodies(text: string): readonly RunBody[] {
  const bodies: RunBody[] = [];
  const lineAt = (index: number): number => text.slice(0, index).split("\n").length;
  // Attributed indirection bodies are deduped by (body start in file, run-site line) so a
  // body reached twice yields ONE entry, while two distinct run sites sharing one helper
  // still each attribute it.
  const attributed = new Set<string>();
  const remember = (resolved: { readonly body: string; readonly start: number }, helper: string, siteLine: number): boolean => {
    const key = `${resolved.start}:${siteLine}:${helper}`;
    if (attributed.has(key)) return false;
    attributed.add(key);
    bodies.push({ body: resolved.body, line: siteLine, via: helper });
    return true;
  };
  const keyword = /\brun\b\s*(:|\()/g;
  for (let match = keyword.exec(text); match !== null; match = keyword.exec(text)) {
    const after = keyword.lastIndex;
    if (match[1] === ":") {
      // Comment guard: a prose line may say "…none in run:" — a real `run:` is followed by
      // a value, and the forms below each demand their own shape.
      // Indirection `run: helperName` (an identifier, no call): attribute the helper's body.
      const valueStart = after + (text.slice(after).match(/^\s*/)?.[0].length ?? 0);
      const ref = /^([A-Za-z_$][\w$]*)\s*(?=[,}])/ .exec(text.slice(valueStart, valueStart + 128));
      if (ref !== null) {
        const resolved = helperBody(text, ref[1]);
        if (resolved !== undefined) {
          remember(resolved, ref[1], lineAt(valueStart));
        }
        // Do NOT jump lastIndex past the helper body: when the helper is declared AFTER the
        // run site, that jump would skip every intervening run site. Keep scanning forward
        // from just past the current match instead.
        keyword.lastIndex = after;
        continue;
      }
      if (text[valueStart] !== "(") continue;
      const paramsEnd = skipParens(text, valueStart);
      const arrow = /\s*=>/.exec(text.slice(paramsEnd, paramsEnd + 16));
      if (arrow === null) continue;
      // Expression arrow whose body is a single call `helperName(…)`: attribute the helper's
      // same-file body — the indirection a `run: helper` site could have used.
      const bodyWhitespace = text.slice(paramsEnd + arrow[0].length).match(/^\s*/)?.[0].length ?? 0;
      const expressionStart = paramsEnd + arrow[0].length + bodyWhitespace;
      const singleCall = /^([A-Za-z_$][\w$]*)\s*\(/.exec(text.slice(expressionStart, expressionStart + 128));
      if (singleCall !== null) {
        const callOpen = expressionStart + singleCall[0].length - 1;
        const callEnd = skipParens(text, callOpen);
        const rest = text.slice(callEnd).match(/^[^\n]*/)?.[0] ?? "";
        if (/^\s*[;,}\n]?\s*$/.test(rest) || /^\s*\)\s*[,;]?\s*$/.test(rest)) {
          const resolved = helperBody(text, singleCall[1]);
          if (resolved !== undefined) {
            remember(resolved, singleCall[1], lineAt(valueStart));
            keyword.lastIndex = after;
            continue;
          }
        }
      }
      const body = arrowBody(text, after);
      if (body === undefined) continue;
      bodies.push({ body: body.body, line: lineAt(after) });
      keyword.lastIndex = body.end;
    } else {
      // `run(ctx, plan) {` method form: skip the parameters, demand a brace block.
      const paramsEnd = skipParens(text, after - 1);
      const brace = /\s*\{/.exec(text.slice(paramsEnd, paramsEnd + 16));
      if (brace === null) continue; // a plain call `run(...)` — not a body
      const bodyStart = paramsEnd + brace[0].length - 1;
      const { body, end } = braceBody(text, bodyStart);
      bodies.push({ body, line: lineAt(bodyStart) });
      keyword.lastIndex = end;
    }
  }
  return bodies;
}

export interface GrammarSite {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Every grammar-mint occurrence inside a `run` body under packages/clawwright/commands/** —
 *  argument declarations and prepare phases are outside run bodies by construction — plus
 *  the number of run bodies the scan saw, so the enforcer can prove it scanned the tree. */
export interface GrammarScan {
  readonly sites: readonly GrammarSite[];
  readonly scanned: number;
}

export async function grammarInRunScan(): Promise<GrammarScan> {
  const commandsRoot = join(monorepoRoot, "packages", "clawwright", "commands");
  const sites: GrammarSite[] = [];
  let scanned = 0;
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const text = await readFile(full, "utf8");
        for (const { body, line: firstLine, via } of runBodies(text)) {
          scanned++;
          const bodyStartIndex = text.lastIndexOf(body);
          const lines = body.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (GRAMMAR_MINT.test(lines[i])) {
              sites.push({
                file: relative(monorepoRoot, full),
                line: bodyStartIndex === -1 ? firstLine : firstLine + i,
                text: via === undefined ? lines[i].trim() : `run → ${via}: ${lines[i].trim()}`,
              });
            }
          }
        }
      }
    }
  }
  await walk(commandsRoot);
  return { sites, scanned };
}
