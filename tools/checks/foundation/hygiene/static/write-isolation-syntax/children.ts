import { inspectBody, writerRoots, readScript, sourcePath, type SourceContext } from "./body.ts";
import { childBodyCapable, childBodyAnchored } from "./index.ts";
import { extractArgRange, anchoredFloor, isAnchoredSignal, type Classify, type Classification, type Hit } from "./write-isolation-rules.ts";

const reHits = (pattern: RegExp, text: string): boolean => pattern.exec(text) !== null;

const DESTRUCTIVE = /\bgit\b.*\bclean\b|\bgit\b.*\bcheckout\b.*\s--(?:\s|$)|\bgit\b.*\breset\b.*--hard\b|(?:^|[\s;&|])(?:rm|del|rmdir|rd|Remove-Item)(?:\s|$)/i;
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** Ordinary strings and interpolation-free templates are fixed child-process words. */
function childWord(origin: string): string | undefined {
  const text = origin.trim();
  if (!['"', "'", "`"].includes(text[0]) || text.at(-1) !== text[0]) return undefined;
  if (text[0] === "`" && text.includes("${")) return undefined;
  const quote = text[0];
  for (let i = 1; i < text.length - 1; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === quote) return undefined;
  }
  return text.slice(1, -1).replace(/\\([\\'"`])/g, "$1").replace(/\\n/g, "\n").replace(/\\r/g, "\r");
}

/** End offset of the depth-0 expression starting at from (stops at , ; ) ] }). */
function expressionEnd(masked: string, from: number): number {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { if (depth === 0) return i; depth--; }
    else if (depth === 0 && (c === "," || c === ";")) return i;
  }
  return masked.length;
}

/** Non-empty top-level items of the call or array opening at open. */
function listItems(masked: string, open: number): Array<[number, number]> {
  const items: Array<[number, number]> = [];
  for (let index = 0; index < 64; index++) {
    const range = extractArgRange(masked, open, index);
    if (range === undefined) break;
    if (masked.slice(range[0], range[1]).trim() !== "") items.push(range);
  }
  return items;
}

/** Extract path operands, not executables, subcommands or flags. Shell parsing is a
 * bounded approximation; provenance of nonliteral operands is checked separately. */
function destructiveOperands(command: string): string[] {
  const words = [...command.matchAll(/"([^"]*)"|'([^']*)'|([^\s;&|]+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  const git = words.findIndex((word) => /^(?:.*[\\/])?git(?:\.exe)?$/i.test(word));
  let operands: string[];
  if (git >= 0) {
    const subcommand = words[git + 1];
    if (subcommand === "checkout") {
      const separator = words.indexOf("--", git + 2);
      operands = separator < 0 ? [] : words.slice(separator + 1);
    } else operands = subcommand === "clean" ? words.slice(git + 2) : [];
  } else {
    const destroy = words.findIndex((word) => /^(?:rm|del|rmdir|rd|Remove-Item)$/i.test(word));
    operands = destroy < 0 ? [] : words.slice(destroy + 1);
  }
  return operands.filter((word) => word !== "" && !word.startsWith("-") && !/^\/(?:s|q|f)$/i.test(word));
}

/** Child processes running a destructive command (git clean/checkout --/reset --hard,
 * rm/del/rmdir/Remove-Item) with a checkout-anchored cwd or path argument. An absent cwd
 * inherits the checkout; an unresolved cwd is enforced, not disclosed. */
function expandSourcePath(expr: string, origin: string, at: number, classify: Classify, depth = 0): string {
  if (depth > 12) return origin;
  const value = classify.resolveValue(expr, origin, at);
  if (value.origin !== origin) return expandSourcePath(value.expr, value.origin, value.at, classify, depth + 1);
  const call = /^(?:(?:path|nodePath)\.)?(?:resolve|join|dirname|fileURLToPath)\s*\(/.exec(expr.trim());
  if (call === null) return origin;
  const lead = expr.length - expr.trimStart().length;
  const ranges = listItems(expr, lead + call[0].length - 1);
  let out = origin;
  for (const [f,t] of ranges.reverse()) out = out.slice(0,f) + expandSourcePath(expr.slice(f,t),origin.slice(f,t),at,classify,depth+1) + out.slice(t);
  return out;
}

export function childProcessHits(source: string, masked: string, classify: Classify, calls: ReadonlyArray<{ name: string; at: number; open: number }>, context?: SourceContext): Hit[] {
  const hits: Hit[] = [];
  for (const { name, at, open } of calls) {
    const items = listItems(masked, open);
    const text = source.slice(open + 1, items.at(-1)?.[1] ?? open + 1);
    const values = items.map(([f, t]) => classify.resolveValue?.(masked.slice(f, t), source.slice(f, t), at) ?? { expr: masked.slice(f, t), origin: source.slice(f, t), at });
    const program = childWord(values[0]?.origin ?? "");
    const argv = values[1];
    const argvItems = argv?.expr.trim().startsWith("[") ? listItems(argv.expr, argv.expr.indexOf("[")) : [];
    const resolvedArgs = argvItems.map(([f, t]) => classify.resolveValue(argv!.expr.slice(f, t), argv!.origin.slice(f, t), argv!.at));
    const args = resolvedArgs.map(v => childWord(v.origin));
    const readOnlyGit = (expr: string, origin: string): boolean => {
      if (!expr.trim().startsWith("[")) return false;
      const rows = listItems(expr, expr.indexOf("["));
      const first = rows[0];
      if (first === undefined) return false;
      if (expr.slice(...first).trim().startsWith("[")) return rows.every((r) => readOnlyGit(expr.slice(...r), origin.slice(...r)));
      const subcommand = childWord(origin.slice(...first));
      return subcommand !== undefined && /^(?:status|ls-files|ls-tree|diff|log|show|rev-parse|rev-list|cat-file|blame)$/.test(subcommand);
    };
    if (/^(?:.*[\\/])?git(?:\.exe)?$/i.test(program ?? "") && argv !== undefined && readOnlyGit(argv.expr, argv.origin)) continue;
    const unresolved = argv !== undefined && (argvItems.length > 0 ? args.some((v) => v === undefined) : !argv.expr.trim().startsWith("{"));
    const capable = /^(?:.*[\\/])?(?:git|rm|del|rmdir|rd|Remove-Item)(?:\.exe)?$/i.test(program ?? "")
      || (/^(?:.*[\\/])?sh(?:\.exe)?$/i.test(program ?? "") && args.includes("-c"))
      || (/^(?:.*[\\/])?cmd(?:\.exe)?$/i.test(program ?? "") && args.some((v) => v?.toLowerCase() === "/c"));
    const destructive = DESTRUCTIVE.test(values.map((v) => [...v.origin.matchAll(LITERAL)].map((l) => l[2]).join(" ")).join(" "));
    const bodies = argvItems.map(([f, t]) => classify.resolveValue(argv!.expr.slice(f, t), argv!.origin.slice(f, t), argv!.at).origin).join(" ");
    const bodyCapable = name === "fork" || childBodyCapable(program, values[0]?.expr ?? "", args, bodies || values.slice(1).map((v) => v.origin).join(" "));
    let bodyVerdict: "readonly" | "writer" | "unknown" | undefined;
    let writerRoot: "relative" | "anchored" | "unknown" = "unknown";
    let writerBodyAnchored = false;
    const node = /^(?:.*[\\/])?(?:node|nodejs)(?:\.exe)?$/i.test(program ?? "") || values[0]?.expr.trim() === "process.execPath" || name === "fork";
    const shell = /^(?:.*[\\/])?(?:bash|sh|zsh|cmd|powershell|pwsh)(?:\.exe)?$/i.test(program ?? "") || /^(?:exec|execSync)$/.test(name);
    if (shell && /^(?:exec|execSync)$/.test(name)) {
      const words = program?.trim().split(/\s+/) ?? [];
      const readOnly = ["echo", "printf"].includes(words[0]) && words.length > 1 && !/[;&|<>]/.test(program ?? "");
      bodyVerdict = program === undefined ? "unknown" : /\b(?:Set-Content|Add-Content|Out-File|Remove-Item|New-Item|rm|del|rmdir|rd|tee|touch|mv|cp)\b|(?:^|[^>=])>{1,2}(?!&)/i.test(program) ? "writer" : readOnly ? "readonly" : "unknown";
    }
    if (bodyVerdict === "readonly") continue;
    if (node && bodyCapable) {
      const optionsUnknown = args.some(a => /^(?:-r|--require|--import|--input-type)(?:=|$)/.test(a ?? ""));
      const evalAt = args.findIndex(a => /^(?:-e|-p|--eval|--print)(?:=|$)/.test(a ?? ""));
      const inline = evalAt < 0 ? undefined : args[evalAt]?.includes("=") ? args[evalAt]!.slice(args[evalAt]!.indexOf("=") + 1) : args[evalAt + 1];
      if (optionsUnknown) bodyVerdict = "unknown";
      else if (evalAt >= 0) {
        bodyVerdict = inline === undefined ? "unknown" : inspectBody(inline);
        if (inline !== undefined && bodyVerdict === "writer") { writerRoot = writerRoots(inline); writerBodyAnchored = childBodyAnchored(inline); }
      }
      else {
        const scriptAt = resolvedArgs.findIndex((v, i) => !(args[i]?.startsWith("-") ?? false));
        const value = name === "fork" ? values[0] : resolvedArgs[scriptAt];
        let script: string | undefined;
        if (value !== undefined && context !== undefined) {
          const expanded = expandSourcePath(value.expr, value.origin, value.at, classify);
          const path = sourcePath(expanded, context);
          script = context.readSource === undefined ? readScript(path) : path === undefined ? undefined : context.readSource(path);
        }
        if (script === undefined && value !== undefined) {
          for (const write of masked.slice(0, at).matchAll(/\bwriteFile(?:Sync)?\s*\(/g)) {
            const writeOpen = write.index + write[0].length - 1;
            const path = extractArgRange(masked, writeOpen, 0);
            const body = extractArgRange(masked, writeOpen, 1);
            if (!path || !body) continue;
            const pathValue = classify.resolveValue(masked.slice(...path), source.slice(...path), write.index);
            if (pathValue.origin.trim() !== value.origin.trim()) continue;
            const bodyValue = classify.resolveValue(masked.slice(...body), source.slice(...body), write.index);
            script = childWord(bodyValue.origin);
          }
        }
        bodyVerdict = script === undefined ? "unknown" : inspectBody(script);
        if (script !== undefined && bodyVerdict === "writer") { writerRoot = writerRoots(script); writerBodyAnchored = childBodyAnchored(script); }
      }
      if (bodyVerdict === "readonly") continue;
    }
    if (shell && bodyCapable && !/^(?:exec|execSync)$/.test(name)) {
      const commandAt = args.findIndex(a => /^(?:-c|\/c|-command|--command)$/i.test(a ?? ""));
      const body = args[commandAt + 1];
      bodyVerdict = body === undefined ? "unknown" : /\b(?:Set-Content|Add-Content|Out-File|Remove-Item|New-Item|rm|del|rmdir|rd|tee|touch|mv|cp)\b|(?:^|[^>=])>{1,2}(?!&)/i.test(body) ? "writer" : "unknown";
    }
    if (!destructive && !bodyCapable && bodyVerdict === undefined && !(unresolved && capable)) continue;
    let cwd: Classification | "UNBOUND" = "ANCHORED";
    let anchored = false;
    for (const value of values) {
      const item = value.expr.trim();
      const start = value.expr.indexOf(item);
      const localVerdict = (f: number, t: number): Classification | "UNBOUND" => anchoredFloor(classify(value.expr.slice(f, t), value.origin.slice(f, t), value.at), value.expr.slice(f, t));
      if (item.startsWith("{")) {
        const key = /\bcwd\b\s*(:)?/.exec(item);
        if (key === null) continue;
        const valueFrom = start + key.index + (key[1] === undefined ? 0 : key[0].length);
        cwd = localVerdict(valueFrom, key[1] === undefined ? valueFrom + 3 : expressionEnd(value.expr, valueFrom));
        const cwdExpr = value.expr.slice(valueFrom, key[1] === undefined ? valueFrom + 3 : expressionEnd(value.expr, valueFrom)).trim();
        if (/\?\?/.test(cwdExpr)) {
          const alternatives = cwdExpr.split("??");
          if (alternatives.every(e => classify(e, e, at) === "CLEAN")) cwd = "CLEAN";
        }
        continue;
      }
      const parts: Array<[number, number]> = item.startsWith("[") ? listItems(value.expr, start) : [[0, value.expr.length]];
      const literals = parts.map(([f, t]) => childWord(value.origin.slice(f, t)));
      const command = item.startsWith("[")
        ? [program ?? "", ...literals.map((v) => v ?? "")].join(" ")
        : literals[0] ?? "";
      if (destructiveOperands(command).some((path) => isAnchoredSignal("", JSON.stringify(path)))) anchored = true;
      if (bodyVerdict === undefined || !node) for (const [f, t] of parts) if (!reHits(/^(["'`])\s*\1$/, value.expr.slice(f, t).trim()) && localVerdict(f, t) === "ANCHORED") anchored = true;
    }
    if (bodyVerdict === "unknown" && !destructive) {
      if (cwd !== "CLEAN") hits.push({ call: name, target: text.replace(/\s+/g, " ").trim(), classification: "UNKNOWN", approximation: true });
      continue;
    }
    if (node && bodyVerdict === "writer" && (writerRoot === "anchored" || writerBodyAnchored || childBodyAnchored(bodies))) anchored = true;
    if (node && bodyVerdict === "writer" && writerRoot === "unknown" && !anchored && cwd === "CLEAN") {
      hits.push({ call: name, target: text.replace(/\s+/g, " ").trim(), classification: "UNKNOWN", approximation: true });
      continue;
    }
    if (bodyVerdict === "writer" && cwd === "CLEAN" && !anchored && (node ? writerRoot === "relative" : !childBodyAnchored(bodies))) continue;
    if (!destructive && !bodyCapable && cwd !== "ANCHORED") continue;
    if (bodyCapable && childBodyAnchored(text)) anchored = true;
    const classification = anchored || cwd === "ANCHORED" ? "ANCHORED" : cwd === "CLEAN" ? undefined : "UNKNOWN";
    if (classification !== undefined) hits.push({ call: name, target: text.replace(/\s+/g, " ").trim(), classification, approximation: false });
  }
  return hits;
}

