// Help-prose tokens: {clawwright} — the program; {clawwright <argv…>} — a whole command,
// `--app <name>` as its first words moving into the advice's `app` field; {--name} — this
// command's own flag; {install <argv…>} — an install line for the shell the LAST argv word
// names (bash/zsh → posix, pwsh → pwsh; the completion prose). "{" without
// clawwright/install/-- is plain text (JSON in prose).

import { command } from "./advice.ts";
import { renderAdviceParts, renderFrameAdvice, renderProgram } from "./render.ts";
import { invokedFrame } from "./index.ts";
import { handoverOf, type Frame } from "./frame.ts";

export type ProseToken =
  | { kind: "program" }
  | { kind: "command"; argv: readonly string[]; app?: string }
  | { kind: "install"; argv: readonly string[]; shell?: "posix" | "pwsh" }
  | { kind: "flag"; name: string };

/** The shell an install line is spelled for: the last argv word names it. */
function installShell(last: string | undefined): "posix" | "pwsh" {
  return last === "pwsh" ? "pwsh" : "posix";
}

/** The token a `{…}` span means, or undefined when the brace is plain text. */
function recognize(content: string): ProseToken | undefined {
  if (content === "clawwright") return { kind: "program" };
  if (content.startsWith("clawwright ")) {
    const words = content.slice("clawwright ".length).split(" ");
    if (words[0] === "--app" && words.length > 1) {
      return { kind: "command", argv: words.slice(2), app: words[1] };
    }
    return { kind: "command", argv: words };
  }
  if (content.startsWith("install ")) {
    const argv = content.slice("install ".length).split(" ");
    return { kind: "install", argv, shell: installShell(argv[argv.length - 1]) };
  }
  const flag = /^--([A-Za-z0-9][\w-]*)$/.exec(content);
  if (flag !== null) {
    const name = flag[1];
    if (name !== undefined) return { kind: "flag", name };
  }
  return undefined;
}

/** Every recognized token with the exact span it replaces; text between spans (and
 *  around an unrecognized `{`) is copied byte for byte by renderProse. */
function* scan(text: string): Generator<[token: ProseToken, start: number, end: number]> {
  let cursor = 0;
  for (;;) {
    const open = text.indexOf("{", cursor);
    if (open === -1) return;
    const close = text.indexOf("}", open + 1);
    if (close === -1) return;
    const token = recognize(text.slice(open + 1, close));
    if (token === undefined) {
      cursor = open + 1;
      continue;
    }
    yield [token, open, close + 1];
    cursor = close + 1;
  }
}

export function parseProse(text: string): ProseToken[] {
  const tokens: ProseToken[] = [];
  for (const [token] of scan(text)) tokens.push(token);
  return tokens;
}

export function renderProse(text: string, frame?: Frame): string {
  // Prose renders in this run's own frame when the caller has none: this module sits inside
  // the invocation module, so the global read is allowed here (nowhere else).
  // The installed frame carries the entry's real roots/places; a rebuilt one loses them.
  const f = frame ?? invokedFrame();
  const on = handoverOf(f);
  let rendered = "";
  let cursor = 0;
  for (const [token, start, end] of scan(text)) {
    rendered += text.slice(cursor, start);
    if (token.kind === "program") rendered += renderProgram(on);
    else if (token.kind === "flag") rendered += `--${token.name}`;
    else if (token.kind === "install") {
      // The note travels separately (renderAdviceParts) so it stays OUT of the executable
      // line; the rendered shape stays line + `  (note)`, as before.
      const part = renderAdviceParts(command(token.argv, { shell: token.shell }), f)[0]!;
      rendered += part.note === undefined ? part.line : `${part.line}  (${part.note})`;
    }
    else rendered += renderFrameAdvice(command(token.argv, token.app === undefined ? undefined : { app: token.app }), f);
    cursor = end;
  }
  return rendered + text.slice(cursor);
}
