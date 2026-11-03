export interface Finding {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface Instruction { readonly command: string; readonly text: string; readonly line: number; readonly unparsed?: boolean }

export function instructions(source: string): Instruction[] {
  const lines = source.split(/\r?\n/);
  const result: Instruction[] = [];
  let escape = "\\";
  for (let i = 0; i < lines.length; i++) {
    const directive = /^\s*#\s*escape\s*=\s*([\\`])\s*$/i.exec(lines[i]);
    if (directive) escape = directive[1];
    if (/^\s*(#|$)/.test(lines[i])) continue;
    const line = i + 1;
    let text = lines[i];
    while (text.trimEnd().endsWith(escape) && i + 1 < lines.length) {
      text = text.trimEnd().slice(0, -1);
      const next = lines[++i];
      if (!/^\s*#/.test(next)) text += " " + next;
      else text += escape;
    }
    const match = /^\s*([a-z]+)\s+(.*)$/i.exec(text);
    if (!match) { result.push({ command: "", text, line, unparsed: true }); continue; }
    const delimiters = [...match[2].matchAll(/<<-?\s*['"]?([A-Za-z_][\w]*)['"]?/g)].map((entry) => entry[1]);
    if (delimiters.length > 0) {
      for (const delimiter of delimiters) {
        while (i + 1 < lines.length && lines[++i].trim() !== delimiter) { /* Skip heredoc bytes, not Docker instructions. */ }
      }
    }
    result.push({ command: match[1].toUpperCase(), text: match[2], line, unparsed: delimiters.length > 0 });
  }
  return result;
}

/** Small shell lexer: quoted operators and comment text are not commands. */
export function shellTokens(text: string): string[] {
  const tokens: string[] = [];
  let word = "";
  let started = false;
  let quote = "";
  const flush = (): void => { if (started) tokens.push(word); word = ""; started = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && quote !== "'") { started = true; word += text[++i] ?? ""; continue; }
    if (quote) { if (c === quote) quote = ""; else word += c; started = true; continue; }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === "#" && !started) break;
    if (/\s/.test(c)) { flush(); continue; }
    if (/[|;&<>]/.test(c)) {
      flush();
      if (text[i + 1] === c) { tokens.push(c + c); i++; } else tokens.push(c);
      continue;
    }
    word += c; started = true;
  }
  if (quote) throw new Error("unterminated shell quote");
  flush();
  return tokens;
}

/** The token's value after a leading flag prefix, or undefined when the token is not that flag.
 *  Structural so flag handling in lint helpers does not re-introduce raw prefix scans. */
export function hasFlag(token: string, flag: string): string | undefined {
  return token.length > flag.length && token.slice(0, flag.length) === flag ? token.slice(flag.length) : undefined;
}

export function runTokens(text: string): string[] {
  if (!text.trimStart().startsWith("[")) return shellTokens(text);
  const argumentsList: unknown = JSON.parse(text);
  if (!Array.isArray(argumentsList) || !argumentsList.every((value) => typeof value === "string")) throw new Error("invalid exec RUN");
  if (/^(?:.*\/)?(?:sh|bash)$/.test(argumentsList[0] ?? "") && argumentsList[1]?.includes("c")) return shellTokens(argumentsList[2] ?? "");
  // An exec-form argument containing a pipe is data, not a shell operator.
  return argumentsList.map((value) => /^[|;&<>]+$/.test(value) ? `quoted:${value}` : value);
}
