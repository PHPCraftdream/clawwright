// Advice and program-named lines are rendered when they are shown, never at import. The entry
// sets the invocation AFTER the modules load, so a module-level `commandLine("apply")` (or any
// renderer) bakes the default checkout spelling into the text for every other invocation, and a
// module-level `invocation()` even fixes the default in place. Zero such calls are allowed in
// product code; an exemption names the exact line and a reason.

import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { monorepoRoot } from "#framework/core/env.ts";
import { check, finish } from "#checks/kit/harness.ts";

const RENDERERS = ["commandLine", "renderAdvice", "renderProse", "shellLine", "invocation", "defaultInvocation"];
const CALL = new RegExp(`^(${RENDERERS.join("|")})\\s*\\(`);

/** Line-exact exemptions: file -> trimmed line -> reason. */
const EXEMPT: Record<string, Record<string, string>> = {
};

type Kind = "lazy" | "eager" | "class";
interface Group {
  kind: Kind;
  /** An expression-bodied arrow was opened in this group: lazy until the next `,` or the close. */
  arrow: boolean;
  /** Text of the current member/statement in this group, to read `static` and method heads. */
  head: string;
}

/** Lines (1-based) of a renderer call evaluated while the module loads: not inside a function,
 *  arrow, method or accessor body. A lexical scan: strings, comments and regex literals are
 *  skipped, template `${}` parts are code. */
export function importTimeCalls(source: string): number[] {
  const found: number[] = [];
  const stack: Group[] = [{ kind: "eager", arrow: false, head: "" }];
  const templates: number[] = []; // stack depths at which a `${` opened inside a template
  let line = 1;
  let prev = ""; // last significant character
  let word = ""; // trailing identifier text before the current position
  const top = (): Group => stack[stack.length - 1]!;
  const lazy = (): boolean => stack.some((group) => group.kind === "lazy" || group.arrow);
  const push = (kind: Kind): void => {
    stack.push({ kind, arrow: false, head: "" });
  };
  let i = 0;
  const scanTemplate = (): void => {
    // inside a template literal, after the opening backtick or a closing `}` of `${}`
    while (i < source.length) {
      const c = source[i]!;
      if (c === "\n") line++;
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { i++; prev = "`"; return; }
      if (c === "$" && source[i + 1] === "{") {
        i += 2;
        templates.push(stack.length);
        push("eager");
        return;
      }
      i++;
    }
  };
  while (i < source.length) {
    const c = source[i]!;
    if (c === "\n") { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (const ch of source.slice(i, stop)) if (ch === "\n") line++;
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < source.length && source[i] !== c && source[i] !== "\n") i += source[i] === "\\" ? 2 : 1;
      i++;
      prev = c;
      word = "";
      continue;
    }
    if (c === "`") { i++; scanTemplate(); word = ""; continue; }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};>".includes(prev))) {
      // a regex literal
      i++;
      let inClass = false;
      while (i < source.length && source[i] !== "\n") {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        else if (source[i] === "/" && !inClass) break;
        i++;
      }
      i++;
      prev = "/";
      word = "";
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < source.length && /[\w$]/.test(source[j]!)) j++;
      const id = source.slice(i, j);
      const before = source.slice(Math.max(0, i - 12), i);
      const declared = /\bfunction\s*\*?\s*$/.test(before);
      if (CALL.test(source.slice(i, i + id.length + 20)) && prev !== "." && !declared && !lazy()) {
        const group = top();
        // inside a class body only a `static` member initialiser runs at import
        if (group.kind !== "class" || /\bstatic\b/.test(group.head)) found.push(line);
      }
      top().head += `${id} `;
      word = id;
      prev = "a";
      i = j;
      continue;
    }
    if (c === "=" && source[i + 1] === ">") {
      i += 2;
      let j = i;
      while (j < source.length && /\s/.test(source[j]!)) j++;
      if (source[j] !== "{") top().arrow = true;
      else { for (const ch of source.slice(i, j)) if (ch === "\n") line++; i = j; push("lazy"); i++; prev = "{"; }
      prev = prev === "{" ? "{" : ">";
      continue;
    }
    if (c === "{") {
      const group = top();
      const head = group.head;
      const methodBody = prev === ")" || /\b(function|get|set|static)\b\s*[\w$]*\s*$/.test(head) && prev === ")";
      const typed = /\)\s*:\s*[^{};=]*$/.test(head);
      const kind: Kind = /\bclass\b/.test(head) && !head.includes("(") ? "class" : methodBody || typed || /\bfunction\b/.test(head) ? "lazy" : "eager";
      push(kind);
      prev = "{";
      i++;
      continue;
    }
    if (c === "(" || c === "[") {
      // a function's parameter defaults run per call
      push(c === "(" && /\bfunction\b\s*\*?\s*[\w$]*\s*$/.test(top().head) ? "lazy" : "eager");
      prev = c;
      i++;
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      if (c === "}" && templates.length > 0 && templates[templates.length - 1] === stack.length - 1) {
        templates.pop();
        stack.pop();
        i++;
        scanTemplate();
        continue;
      }
      if (stack.length > 1) stack.pop();
      top().head = c === ")" ? `${top().head}) ` : "";
      if (c === "}") top().arrow = false;
      prev = c;
      i++;
      continue;
    }
    if (c === "," ) top().arrow = false;
    if (c === ";") { top().arrow = false; top().head = ""; }
    prev = c;
    top().head += c;
    i++;
  }
  void word;
  return found;
}

// --- the scanner itself: each shape the product could take --------------------------------------

const lines = (source: string): number[] => importTimeCalls(source);
check("a top-level const initialiser is import time", lines('const A = commandLine("apply");\n'), [1]);
check("a template placeholder at top level is import time", lines("const A = `x ${commandLine(\"a\")}`;\n"), [1]);
check("an object field at top level is import time", lines('export const X = {\n  reason: commandLine("a"),\n};\n'), [2]);
check("a function body is lazy", lines('function f() {\n  return commandLine("a");\n}\n'), []);
check("an exported function body is lazy", lines('export async function f(): Promise<void> {\n  invocation();\n}\n'), []);
check("a parameter default is lazy", lines("export function f(on = invocation()): string {\n  return on;\n}\n"), []);
check("a block arrow body is lazy", lines('const f = () => {\n  return commandLine("a");\n};\n'), []);
check("an expression arrow body is lazy", lines('const f = () => commandLine("a");\nconst g = (x: string) => `${commandLine(x)}`;\n'), []);
check("an arrow passed as an argument stays lazy to its end only", lines('run(() => commandLine("a"), commandLine("b"));\n'), [1]);
check("a getter body is lazy", lines('const o = {\n  get reason(): string {\n    return commandLine("a");\n  },\n};\n'), []);
check("a method body is lazy", lines('const o = {\n  run(x: string) {\n    return commandLine(x);\n  },\n};\n'), []);
check("a class method is lazy", lines('class A {\n  run() {\n    return commandLine("a");\n  }\n}\n'), []);
check("a static class field is import time", lines('class A {\n  static X = commandLine("a");\n}\n'), [2]);
check("an instance class field is not", lines('class A {\n  x = commandLine("a");\n}\n'), []);
check("a comment, a string and a regex are not code", lines('// commandLine("a")\nconst s = "commandLine(1)";\nconst r = /commandLine\\(/;\n'), []);
check("a method call of the name is another symbol", lines('const A = other.commandLine("a");\n'), []);
check("the declaration itself is not a call", lines("export function commandLine(argv: string): string {\n  return argv;\n}\n"), []);

// --- the product ---------------------------------------------------------------------------------

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") found.push(...(await walk(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

const exemptLeft = new Map(Object.entries(EXEMPT).map(([file, entries]) => [file, new Set(Object.keys(entries))]));
const offenders: string[] = [];
for (const full of await walk(resolve(monorepoRoot, "packages", "clawwright"))) {
  const file = relative(monorepoRoot, full).split("\\").join("/");
  const source = await readFile(full, "utf8");
  const sourceLines = source.split("\n");
  for (const line of importTimeCalls(source)) {
    const text = sourceLines[line - 1]!.trim();
    if (exemptLeft.get(file)?.delete(text) === true) continue;
    offenders.push(`${file}:${line}: ${text}`);
  }
}
check("no advice or program-named line is rendered at module import (render lazily, or exempt the line with a reason)", offenders, []);
for (const [file, unused] of exemptLeft) {
  for (const text of unused) check(`exemption in ${file} still matches a line: ${text}`, false, true);
}

finish("top-level advice render");
