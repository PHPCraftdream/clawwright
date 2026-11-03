// The advice a message or an error hands the user: one command to run, a line for
// another shell, or a manual step. Data only — rendering lives in render.ts.

import { shellQuote } from "../shell.ts";

export type Shell = "posix" | "cmd" | "pwsh";

export interface CommandAdvice {
  readonly kind: "clawwright";
  /** The command word and its arguments, WITHOUT the program and without `--app`; an
   *  explicit deployment is `app` instead. */
  readonly argv: readonly string[];
  readonly app?: string;
  readonly note?: string;
  /** The checkout root: the program is spelled from there — the frame a place-naming
   *  sentence directs to — not from the directory the run refused in. */
  readonly at?: "checkout-root";
  /** A line spelled for one shell (a completion script's Install: header, the --help prose
   *  that spells one): forShell re-spells the program for that shell — npm's Windows bin
   *  wrapper carries \, which bash strips and every PowerShell accepts as forward
   *  slashes. */
  readonly shell?: Shell;
}

export interface ShellAdvice {
  readonly kind: "shell";
  readonly shell: Shell;
  readonly text: string;
  readonly note?: string;
  /** The same step spelled for the shells a line may be pasted into other than `shell`;
   *  the renderer picks by the frame (render.ts), advice stays shell-agnostic. */
  readonly alternatives?: Partial<Record<Shell, string>>;
}

export interface ManualAdvice {
  readonly kind: "manual";
  readonly text: string;
}

export type Advice = CommandAdvice | ShellAdvice | ManualAdvice;

/** A command to run. A string is cut on single spaces (so a double space, an empty
 *  element, or a quote character is rejected — pass that element as an array instead);
 *  `argv[0]` may not be `--app`, whose deployment is the `app` option. */
export function command(
  argv: string | readonly string[],
  options?: { readonly app?: string; readonly note?: string; readonly at?: "checkout-root"; readonly shell?: Shell },
): CommandAdvice {
  if (typeof argv === "string" && /["']/.test(argv)) {
    throw new Error("command(): a quote character needs an array element, not a string");
  }
  const parts = typeof argv === "string" ? argv.split(" ") : argv;
  if (parts.some((part) => part === "")) {
    throw new Error("command(): an empty argument element");
  }
  if (parts[0] === "--app") {
    throw new Error("command(): the deployment is the app option, not --app");
  }
  return {
    kind: "clawwright",
    argv: parts,
    ...(options?.app === undefined ? {} : { app: options.app }),
    ...(options?.note === undefined ? {} : { note: options.note }),
    ...(options?.at === undefined ? {} : { at: options.at }),
    ...(options?.shell === undefined ? {} : { shell: options.shell }),
  };
}

export function shellLine(
  shell: Shell,
  text: string,
  options?: { readonly note?: string },
): ShellAdvice {
  return { kind: "shell", shell, text, ...(options?.note === undefined ? {} : { note: options.note }) };
}

/** `cd <path>` as one ShellAdvice, spelled for every shell a Windows checkout pastes into
 *  (D4): pushd changes drive in cmd — a bare `cd "D:\…"` does not — and is the Push-Location
 *  alias in PowerShell 5.1 and 7 alike. With none of `"`, `%`, `$`, a backtick in the path,
 *  `pushd "<p>"` pastes in all three; otherwise cmd has no safe spelling (it expands nothing
 *  inside double quotes but a `%` breaks them), so pwsh falls back to the literal
 *  Set-Location and the renderer prints the POSIX line (fallback rule 5). */
export function changeDirectory(path: string): ShellAdvice {
  const alternatives: Partial<Record<Shell, string>> = {};
  if (!/["%$`]/.test(path)) {
    alternatives.cmd = alternatives.pwsh = `pushd "${path}"`;
  } else {
    alternatives.pwsh = `Set-Location -LiteralPath '${path.replaceAll("'", "''")}'`;
  }
  return { kind: "shell", shell: "posix", text: `cd ${shellQuote(path)}`, alternatives };
}

export function manual(text: string): ManualAdvice {
  return { kind: "manual", text };
}
