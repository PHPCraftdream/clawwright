import { stripTypeScriptTypes } from "node:module";
import { tokensOf } from "../../../../architecture/prose-held.ts";

type Value = { name: string; derived?: boolean; bound?: string[]; unknown?: boolean; namespace?: boolean; promisify?: boolean };
type Binding = { name: string; from: number; to: number; at: number; scope: number; value?: Value };
const READS = new Set("readFile readFileSync readdir readdirSync stat statSync lstat lstatSync fstat fstatSync access accessSync existsSync realpath realpathSync readlink readlinkSync watch watchFile unwatchFile opendir opendirSync constants".split(" "));
const WRITES = new Set("writeFile appendFile mkdir mkdtemp rm rmdir unlink truncate createWriteStream utimes lutimes chmod lchmod chown lchown open cp copyFile symlink link rename".split(" "));

export type SyntaxDiagnostic = { call: string; target: string; at: number; classification: "UNKNOWN"; approximation: true };
export function closeCalleeSyntax(source: string, fallback = true): string {
  return analyzeCalleeSyntax(source, fallback).source;
}
export function analyzeCalleeSyntax(source: string, fallback = true): { source: string; diagnostics: SyntaxDiagnostic[] } {
  let lexicalSource = source;
  try {
    lexicalSource = stripTypeScriptTypes(source, { mode: "strip" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ERR_INVALID_TYPESCRIPT_SYNTAX" && code !== "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") throw error;
    // Incomplete snippets keep the conservative lexical analysis.
  }
  const trackEscapes = true;
  const t = tokensOf(lexicalSource);
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  const scope: number[] = [];
  const parents = new Map<number, number>();
  let current = -1;
  for (let i = 0; i < t.length; i++) {
    scope[i] = current;
    if (t[i].kind !== "p") continue;
    if ("([{<".includes(t[i].text) && t[i].text !== "<") {
      stack.push(i);
      if (t[i].text === "{") { parents.set(i, current); current = i; }
    } else if (")] }".replaceAll(" ", "").includes(t[i].text)) {
      const open = stack.at(-1);
      if (open !== undefined && "([{".indexOf(t[open].text) === ")]}".indexOf(t[i].text)) {
        stack.pop(); pairs.set(open, i);
        if (t[i].text === "}") current = parents.get(open) ?? -1;
      }
    }
  }
  const text = (a: number, b: number): string => a >= b ? "" : source.slice(t[a].at, t[b - 1].at + (t[b - 1].kind === "str" ? source[t[b - 1].at] + t[b - 1].text + source[t[b - 1].at] : t[b - 1].text).length);
  const split = (a: number, b: number): Array<[number, number]> => {
    const out: Array<[number, number]> = []; let start = a;
    for (let i = a; i < b; i++) { if (pairs.has(i)) i = pairs.get(i)!; else if (t[i].text === ",") { out.push([start, i]); start = i + 1; } }
    if (start < b) out.push([start, b]); return out;
  };
  const end = (a: number): number => {
    for (let i = a; i < t.length; i++) { if (pairs.has(i)) i = pairs.get(i)!; else if ([";", ",", "}", ")", "]"].includes(t[i].text)) return i; }
    return t.length;
  };
  const bindings: Binding[] = [];
  const moduleValue = (s: string): Value | undefined => /^(?:node:)?fs(?:\/promises)?$/.test(s) ? { name: "fs", namespace: true } : /^(?:node:)?child_process$/.test(s) ? { name: "cp", namespace: true } : /^(?:node:)?util$/.test(s) ? { name: "util", namespace: true } : undefined;
  const member = (v: Value | undefined, key: string | undefined): Value | undefined => {
    if (!v) return undefined;
    if (!v.namespace && v.name === "constants") return undefined;
    if (v.namespace && v.name === "util") return key === "promisify" ? { name: "promisify", promisify: true } : undefined;
    if (v.unknown) return { name: "writeFile", unknown: true };
    if (key === "promises" && v.namespace && v.name === "fs") return v;
    if (key === "native" && READS.has(v.name)) return v;
    if (["call", "apply", "bind"].includes(key ?? "")) return { ...v, unknown: true };
    if (!v.namespace) return READS.has(key ?? "") || /^(on|once|off|removeListener|removeAllListeners|unref|ref|kill)$/.test(key ?? "") ? undefined : { name: "writeFile", unknown: true };
    if (!key) return { name: v.name === "cp" ? "spawnSync" : "writeFile", unknown: true };
    if (v.name === "cp") return { name: key, unknown: !/^(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)$/.test(key) };
    return { name: key, unknown: !READS.has(key) && !WRITES.has(key.replace(/Sync$/, "")) };
  };
  for (let i = 0; i < t.length; i++) {
    if (t[i].text !== "import") continue;
    if (t[i + 1]?.text === "type" && t[i + 2]?.text !== "from") continue;
    let j = i + 1; while (j < t.length && !["from", ";"].includes(t[j].text)) j++;
    const v = moduleValue(t[j + 1]?.text ?? ""); if (!v) continue;
    for (let k = i + 1; k < j; k++) {
      if (t[k].text === "{") {
        for (const [a, b] of split(k + 1, pairs.get(k) ?? j)) {
          if (t[a]?.text === "type" && b > a + 1 && t[a + 1]?.text !== "as") continue;
          const local = t[a + 1]?.text === "as" ? t[a + 2]?.text : t[a]?.text;
          if (local) bindings.push({ name: local, from: 0, to: 0, at: -1, scope: -1, value: member(v, t[a]?.text) });
        }
        k = pairs.get(k) ?? j;
      } else if (t[k].kind === "id" && t[k].text !== "as") {
        bindings.push({ name: t[k].text, from: 0, to: 0, at: -1, scope: -1, value: v });
      }
    }
  }
  for (let i = 0; i < t.length; i++) {
    if (t[i].text === "=" && t[i + 1]?.text !== ">" && t[i - 1]?.kind === "id") {
      bindings.push({ name: t[i - 1].text, from: i + 1, to: end(i + 1), at: i, scope: scope[i] });
    }
    if (["const", "let", "var"].includes(t[i].text) && ["{", "["].includes(t[i + 1]?.text)) {
      const p = i + 1; const q = pairs.get(p); if (q === undefined || t[q + 1]?.text !== "=") continue;
      const items = t[q + 2]?.text === "[" ? split(q + 3, pairs.get(q + 2) ?? q + 3) : [];
      let position = 0;
      for (const [a] of split(p + 1, q)) {
        const colon = t[a + 1]?.text === ":";
        const local = t[colon ? a + 2 : a]?.text;
        if (local) bindings.push({ name: local, from: q + 2, to: end(q + 2), at: q + 1, scope: scope[i], value: { name: t[p].text === "[" && items[position] ? `#${items[position][0]}:${items[position][1]}` : `@${t[a].text}` } });
        position++;
      }
    }
  }
  const visible = (b: Binding, at: number): boolean => {
    for (let s = scope[at] ?? -1;; s = parents.get(s) ?? -1) { if (s === b.scope) return true; if (s === -1) return false; }
  };
  const resolvedBindings = new Map<Binding, Value | undefined>();
  const resolve = (name: string, at: number, seen: Set<Binding>): Value | undefined => {
    const rows = bindings.filter(b => b.name === name && b.at < at && visible(b, at));
    const b = rows.at(-1);
    if (!b) {
      const declared = t.some((token, i) => token.text === name && ["const", "let", "var", "function", "class"].includes(t[i - 1]?.text ?? ""));
      return !declared && ["fs", "fsp", "fsPromises"].includes(name) ? { name: "fs", namespace: true } : undefined;
    }
    if (seen.has(b) || seen.size > 16) return undefined;
    if (resolvedBindings.has(b)) return resolvedBindings.get(b);
    if (b.value && !b.value.name.startsWith("@") && !b.value.name.startsWith("#")) return b.value;
    const next = new Set(seen); next.add(b);
    const v = evaluate(b.from, b.to, b.at, next);
    const resolved = b.value ? b.value.name.startsWith("#") ? evaluate(Number(b.value.name.slice(1).split(":")[0]),Number(b.value.name.split(":")[1]),b.at,next) : member(v, b.value.name.slice(1)) : v;
    const result = resolved ? { ...resolved, derived: true } : resolved;
    resolvedBindings.set(b, result);
    return result;
  };
  // Unmodeled containers/operators/calls cannot discard capability provenance.
  const contained = (a: number, b: number, seen: Set<Binding>): Value | undefined => {
    if (!trackEscapes) return undefined;
    for (let k = a; k < b; k++) {
      if (t[k - 1]?.text === "typeof" || t[k - 1]?.text === "type") continue;
      if (t[k].kind !== "id" || t[k + 1]?.text === ":" || t[k - 1]?.text === "." && t[k - 2]?.text !== ".") continue;
      let v = resolve(t[k].text, k, seen);
      let stop = k + 1;
      while (t[stop]?.text === "." && t[stop + 1]?.kind === "id") { v = member(v, t[stop + 1].text); stop += 2; }
      if (READS.has(v?.name ?? "") && !v?.unknown || t[stop]?.text === "(" && !v?.bound && !v?.unknown) continue;
      if (t[k].text === "require" && t[k + 1]?.text === "(" && t[k + 2]?.kind === "str") v = moduleValue(t[k + 2].text);
      if (v) return { name: "writeFile", unknown: true, derived: true };
    }
    return undefined;
  };
  const evaluate = (a: number, b: number, at: number, seen = new Set<Binding>()): Value | undefined => {
    while (["!", "?", "."].includes(t[b - 1]?.text)) b--;
    while (t[a]?.text === "await") a++;
    const arrow = t.slice(a,b).findIndex((x,k) => x.text === "=" && t[a+k+1]?.text === ">");
    if (arrow >= 0) {
      const value = evaluate(a+arrow+2,b,at,seen);
      return value ? { name: "writeFile", unknown: true } : contained(a, b, seen);
    }
    if (a >= b) return undefined;
    let v: Value | undefined; let i = a;
    if (t[i].text === "(") { const q = pairs.get(i); if (q === undefined || q >= b) return undefined; v = evaluate(i + 1, q, at, seen); i = q + 1; }
    else if (t[i].text === "<") { while (i < b && t[i].text !== ">") i++; return evaluate(i + 1, b, at, seen); }
    else if (t[i].text === "require" && t[i + 1]?.text === "(" && t[i + 2]?.kind === "str") { v = moduleValue(t[i + 2].text); i = (pairs.get(i + 1) ?? i + 3) + 1; }
    else if (t[i].kind === "id") { v = resolve(t[i].text, at, seen); i++; }
    else return contained(a, b, seen);
    while (i < b && v) {
      if (t[i].text === "!" || t[i].text === "?") { i++; continue; }
      if (["as", "satisfies"].includes(t[i].text)) return v;
      if (t[i].text === "." && t[i + 1]?.text === "(") { i++; continue; }
      if (t[i].text === "." || t[i].text === "[") {
        let key: string | undefined;
        if (t[i].text === "[") { const q = pairs.get(i); key = q === i + 2 && t[i + 1].kind === "str" ? t[i + 1].text : undefined; i = (q ?? i) + 1; }
        else { key = t[i + 1]?.text; i += 2; }
        if (key === "bind" && t[i]?.text === "(") {
          const q = pairs.get(i); if (q === undefined) return { ...v, unknown: true };
          const args = split(i + 1, q).slice(1).map(([f, to]) => text(f, to));
          v = { ...v, bound: [...(v.bound ?? []), ...args] }; i = q + 1;
        } else v = member(v, key);
      } else if (t[i].text === "(") {
        if (v.promisify) {
          const q = pairs.get(i); const first = q === undefined ? undefined : split(i + 1, q)[0];
          const wrapped = first ? evaluate(...first, at, seen) : undefined;
          return wrapped && !wrapped.namespace ? { ...wrapped, derived: true } : contained(i + 1, b, seen);
        }
        return v.bound || v.unknown ? { name: "writeFile", unknown: true } : contained(i + 1, b, seen);
      }
      else return { name: v.name, unknown: true };
    }
    return v ?? contained(a, b, seen);
  };
  const diagnostics: SyntaxDiagnostic[] = [];
  const diagnostic = (a: number, b: number): void => {
    diagnostics.push({ call: "writeFile", target: text(a, b), at: t[a].at, classification: "UNKNOWN", approximation: true });
  };
  const edits: Array<{ a: number; b: number; value: string }> = [];
  for (let open = 0; open < t.length; open++) {
    if (t[open].text !== "(" || !pairs.has(open)) continue;
    const close = pairs.get(open)!;
    if (t[close + 1]?.text === "=" && t[close + 2]?.text === ">") continue;
    let start = open - 1;
    if (t[start]?.text === "." && t[start - 1]?.text === "?") start -= 2;
    while (start >= 0) {
      if ([")", "]"].includes(t[start].text)) {
        const p = [...pairs].find(([, q]) => q === start)?.[0]; if (p === undefined) break; start = p;
        if (t[start].text === "[") { start--; continue; }
        if (t[start].text === "(") { if (t[start - 1]?.kind === "id" || t[start - 1]?.text === ".") { start--; continue; } break; }
      }
      if (t[start - 1]?.text === "." || t[start - 1]?.text === "?" || t[start - 1]?.text === "!") { start -= 2; continue; }
      if (t[start].text === "!") { start--; continue; }
      break;
    }
    if (t.slice(start, open).some((x,k) => x.text === "=" && t[start+k+1]?.text === ">")) continue;
    if (start < 0 || ["function", "new"].includes(t[start - 1]?.text)) continue;
    let args = split(open + 1, close).map(([a, b]) => text(a, b));
    let v: Value | undefined;
    let mode = "";
    if (t[start]?.text === "Reflect" && ["apply", "construct"].includes(t[start + 2]?.text)) {
      mode = "reflect";
      const rows = split(open + 1, close); const first = rows[0];
      if (first) v = evaluate(...first, open);
      const array = rows[t[start + 2].text === "apply" ? 2 : 1];
      if (array && t[array[0]].text === "[" && pairs.get(array[0]) === array[1] - 1) args = split(array[0] + 1, array[1] - 1).map(([a,b]) => text(a,b));
      else { args = ["__r3Unresolved"]; mode = "unknown"; }
    } else {
      let stop = open;
      if (["call", "apply", "bind"].includes(t[open - 1]?.text) && t[open - 2]?.text === ".") {
        mode = t[open - 1].text; stop = open - 2;
      }
      v = evaluate(start, stop, open);
      if (mode === "bind") continue;
      if (mode === "call") args.shift();
      if (mode === "apply") {
        const row = split(open + 1, close)[1];
        if (row && t[row[0]].text === "[" && pairs.get(row[0]) === row[1] - 1) args = split(row[0] + 1, row[1] - 1).map(([a,b]) => text(a,b));
        else { args = ["__r3Unresolved"]; mode = "unknown"; }
      }
    }
    if (v && !v.unknown && !v.namespace && mode === "" && v.bound === undefined && /^(?:realpath|realpathSync)$/.test(v.name)) {
      edits.push({ a: t[start].at, b: t[open].at, value: v.name });
      continue;
    }
    if (!v || v.promisify || v.namespace && !v.unknown || READS.has(v.name) && !v.unknown) continue;
    if (v.unknown && !fallback) continue;
    if (v.unknown || mode === "unknown") {
      diagnostic(start, close + 1);
      edits.push({ a: t[start].at, b: t[close].at + 1, value: "void(0)" });
    } else {
      const canonical = `${v.name}(${[...(v.bound ?? []), ...args].join(",")})`;
      const original = source.slice(t[start].at, t[close].at + 1);
      if (canonical !== original && (mode !== "" || v.derived || v.bound !== undefined || /[[\]!?]/.test(text(start,open)) || t[start].text === "(") && (WRITES.has(v.name.replace(/Sync$/, "")) || /^(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)$/.test(v.name))) edits.push({ a: t[start].at, b: t[close].at + 1, value: canonical });
    }
  }
  // Preserve original reference offsets without rewriting capability initializers.
  if (trackEscapes && fallback) for (let a = 0; a < t.length; a++) {
    // Type-only references do not carry runtime capabilities.
    if (t[a - 1]?.text === "typeof" || t[a - 1]?.text === "type") continue;
    if (t[a].kind !== "id" || t[a + 1]?.text === ":" || t[a - 1]?.text === "." && t[a - 2]?.text !== ".") continue;
    // Import declarations introduce capabilities; exporting them escapes them.
    let statement = a;
    while (statement > 0 && ![";", "}"].includes(t[statement - 1].text)) statement--;
    if (t.slice(statement, a).some(x => x.text === "import")) continue;
    if (bindings.some(b => b.at === a + 1)) continue;
    let b = a + 1;
    while (b < t.length) {
      if (t[b].text === "." && t[b + 1]?.kind === "id") b += 2;
      else if (t[b].text === "[" && pairs.has(b)) b = pairs.get(b)! + 1;
      else break;
    }
    const v = evaluate(a, b, a);
    if (!v) continue;
    // Only a proven readonly property, not an arbitrary property on tainted data.
    if (READS.has(v.name) && !v.unknown) continue;
    if (v.promisify || v.namespace && v.name === "util") continue;
    const adapted = [...pairs].some(([open, close]) => {
      if (t[open].text !== "(" || open >= a || close < b) return false;
      const first = split(open + 1, close)[0];
      if (!first || first[0] !== a || first[1] !== b) return false;
      let start = open - 1;
      while (t[start - 1]?.text === ".") start -= 2;
      return evaluate(start, open, open)?.promisify === true;
    });
    if (adapted) continue;
    let after = b;
    while (["!", "?", "."].includes(t[after]?.text)) after++;
    if (["(", "="].includes(t[after]?.text ?? "") || edits.some(e => e.a <= t[a].at && e.b >= t[b - 1].at && source.slice(e.a, t[a].at).startsWith("Reflect."))) continue;
    // Parentheses/assertions and modeled invocation adapters are direct callees.
    let wrapped = b;
    while (t[wrapped]?.text === ")" || t[wrapped]?.text === "!") {
      if (t[wrapped].text === ")") {
        const p = [...pairs].find(([, q]) => q === wrapped)?.[0];
        if (p === undefined || t[p - 1]?.kind === "id" || [")", "]"].includes(t[p - 1]?.text ?? "")) break;
      }
      wrapped++;
    }
    if (t[wrapped]?.text === "(" || ["as", "satisfies"].includes(t[b]?.text) && edits.some(e => e.a <= t[a].at && e.b > t[a].at)) continue;
    diagnostic(a, b);
    a = b - 1;
  }
  if (trackEscapes && fallback) for (let a = 0; a < t.length; a++) {
    if (t[a].text !== "export" || t[a + 1]?.text === "type" || t[a + 1]?.text === "interface") continue;
    let b = a + 1; while (b < t.length && t[b].text !== ";") b++;
    const from = t.slice(a, b).findIndex(x => x.text === "from");
    if (from >= 0 && moduleValue(t[a + from + 1]?.text ?? "")) diagnostic(a, b);
  }
  const selected = edits.filter(e => !edits.some(other => other !== e && other.a <= e.a && other.b >= e.b && (other.a < e.a || other.b > e.b)));
  for (const e of selected.sort((a,b) => b.a - a.a)) source = source.slice(0,e.a) + e.value + source.slice(e.b);
  return { source, diagnostics };
}

export function childBodyCapable(program: string | undefined, programExpr: string, args: readonly (string | undefined)[], body: string): boolean {
  const node = /^(?:.*[\\/])?(?:node|nodejs)(?:\.exe)?$/i.test(program ?? '') || programExpr.trim() === 'process.execPath';
  const shell = /^(?:.*[\\/])?(?:bash|sh|zsh|cmd|powershell|pwsh)(?:\.exe)?$/i.test(program ?? '');
  if (node) {
    if (args.length === 1 && /^(?:--version|-v|--help|-h)$/.test(args[0] ?? "")) return false;
    return true;
  }
  if (shell && args.some(a => /^(?:-c|\/c|-command|-file|--command)$/i.test(a ?? ""))) {
    if (/^\s*(?:echo|printf|Write-Output)\s+[^;&|<>]+\s*$/i.test(body)) return false;
    return true;
  }
  return node && /\b(?:writeFile|appendFile|createWriteStream|unlink|rm|rmdir|truncate|mkdir|rename|chmod|chown|copyFile|cp|symlink|link)(?:Sync)?\b/.test(body)
    || shell && /\b(?:Set-Content|Add-Content|Out-File|Remove-Item|New-Item|rm|del|rmdir|rd|tee|touch)\b|(?:^|[^>=])>{1,2}(?!&)/i.test(body);
}

export function childBodyAnchored(text: string): boolean {
  // A literal absolute child path can escape even a temporary cwd. Do not assume
  // /tmp (or any other absolute prefix) is outside the checkout.
  return /\b(?:monorepoRoot|repoRoot|checksRoot)\b|process\.cwd\(|import\.meta|(?:[A-Za-z]:[\\/]|\/(?:home|srv|etc|workspace)\/)|["'`](?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\)/.test(text);
}
