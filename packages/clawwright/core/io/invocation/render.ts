// The one renderer for advice: a clawwright command, a shell line or a manual step becomes
// the exact text a user pastes. The `--app` rule and argument quoting live here and only
// here; advice.ts is data. The program is spelled by the frame (frame.ts): the installed
// launch spells as handed, a checkout-root row spells from the root — by the KIND of
// launch, never by "contains /".

import { isAbsolute, relative, resolve } from "node:path";
import { shellQuote } from "../shell.ts";
import { currentFrame, frameOf, invocation, type Invocation } from "./index.ts";
import {
  handoverOf,
  modeOf,
  launchFromModeBoundary,
  forShell,
  IN_BASH_NOTE,
  launchOf,
  pasteShells,
  resolvesByCwd,
  spell,
  targetFrame,
  SHIM_PROGRAM,
  toCheckoutRoot,
  WINDOWS_BIN_PROGRAM,
  type Frame,
  type Host,
  rootedLaunch,
} from "./frame.ts";
import { command, type Advice, type Shell } from "./advice.ts";

export { SHIM_PROGRAM };
export { WINDOWS_BIN_PROGRAM };

/** Gate-command names, registered by the entry before any command runs; they run before a
 *  deployment is resolved, so they never receive an `--app` (see useGateCommands). */
const gateCommands = new Set<string>();

export function useGateCommands(names: readonly string[]): void {
  for (const name of names) gateCommands.add(name);
}

function isGateCommand(word: string | undefined): boolean {
  return word !== undefined && gateCommands.has(word);
}

/** A word POSIX, cmd and pwsh leave as is without quoting (a path or an image reference included).
 *  `%` stays only because POSIX and PowerShell treat it literally; under the bare program
 *  cmd.exe expands `%VAR%` even inside double quotes and no quoting neutralises it, so no
 *  advice word may carry one — advice-matrix.check.ts refuses such a row, and deployment
 *  names cannot contain `%` anyway (safeName, core/values/names.ts). */
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
/** Characters POSIX expands inside double quotes: such a word is single-quoted (see renderArgument). */
const POSIX_ACTIVE = /[`$\\]/;

/** One word's quoting for a frame whose shells are POSIX-only. */
function posixArgument(word: string): string {
  if (/^<.*>$/.test(word)) return word;                // a placeholder <…> stays bare
  if (SAFE_WORD.test(word)) return word;
  return shellQuote(word);                             // a path spelling: POSIX rules
}

/** One word's quoting for a frame that also pastes into cmd.exe and PowerShell: double
 *  quotes are the only spelling all three parse. POSIX shells still expand `$` and
 *  backticks inside them, so a word carrying one is single-quoted instead: it pastes
 *  safely into POSIX shells and PowerShell (cmd.exe keeps single quotes literally — an
 *  accepted limit in a mixed frame for a `$`/backtick/backslash word without `'` or `"`;
 *  a word that also carries `'` or `"` splits per shell, and cmd's own line double-quotes it,
 *  see renderAdviceParts). Never throws: this
 *  runs while an error is reported. */
function shellArgument(word: string): string {
  return shellArgumentForShell(word);
}

/** One word for a line only cmd.exe pastes. cmd reads the line twice: its own tokenizer, in
 *  which EVERY `"` toggles quoting (so a `&` after an embedded quote would run a second
 *  command), then the program's MSVCRT/Node argv parser. Spelled for both: the word is
 *  wrapped in double quotes, an embedded `"` is written `""` (cmd toggles twice and stays
 *  quoted; MSVCRT reads `""` inside quotes as one literal quote), and a run of backslashes
 *  before a `"` or before the closing quote is doubled. `$` and `'` are ordinary to cmd,
 *  so they need no other spelling. `%` stays the accepted limit: cmd expands `%VAR%`
 *  inside double quotes and no spelling prevents it. */
function cmdArgument(word: string): string {
  let out = '"';
  let backslashes = 0;
  for (const char of word) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    out += char === '"' ? `${"\\".repeat(backslashes * 2)}""` : `${"\\".repeat(backslashes)}${char}`;
    backslashes = 0;
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}

/** `shell` is set only when the frame names exactly one shell; a mixed frame (shell
 *  undefined) keeps the shared double-quote rule, with POSIX-active words single-quoted. */
function shellArgumentForShell(word: string, shell?: Shell): string {
  if (/^<.*>$/.test(word)) return word;
  if (SAFE_WORD.test(word)) return word;
  if (shell === "cmd") return cmdArgument(word);
  if (shell === "pwsh" && (POSIX_ACTIVE.test(word) || word.includes('"'))) return `'${word.replaceAll("'", "''")}'`;
  if (POSIX_ACTIVE.test(word)) return shellQuote(word);
  return `"${word.replaceAll('"', '\\"')}"`;
}

/** Boundary shim for pre-frame callers only (the advice-matrix pins hold it; it dies in
 *  S1.3/S1.4): the shells come from the program's launch kind plus this process's host
 *  facts, and the word quotes by those shells — no decision by the program's spelling. */
export function renderArgument(word: string, program: string): string {
  const launch = launchOf({ program, mode: modeOf(launchFromModeBoundary(program)), audience: "terminal" });
  const host: Host = { kind: "operator", platform: process.platform === "win32" ? "win32" : "posix" };
  const shells = pasteShells(launch, host, false);
  return shells.length === 1 && shells[0] === "posix" ? posixArgument(word) : shellArgument(word);
}

/** An argv echoed for a reader to re-assemble — the failure headlines of exec, host and cli:
 *  each element by the argument rule under a path spelling (POSIX quoting), so plain words
 *  stay bare and an element carrying a space, a quote or a newline stays one element. */
export function renderArguments(argv: readonly string[]): string {
  return argv.map((word) => renderArgument(word, SHIM_PROGRAM)).join(" ");
}

/** Programs that find their deployment from the cwd (entry/resolve.ts aliases the same
 *  list, which needs it for the cwd re-selection): the system-wide command, a deployment's
 *  own shim and npm's bin wrapper. A path spelling (the MCP launcher) never reads the cwd. */
export const CWD_RESOLVING_PROGRAMS: readonly string[] = ["clawwright", SHIM_PROGRAM, WINDOWS_BIN_PROGRAM];
/** The note a paste-conflict row carries (rf6-fix33) — exported so the matrix check strips
 *  exactly what the renderer adds. */
export const CWD_CONFLICT_NOTE = "from the checkout root";

/** SAFE_WORD plus backslash: the invocation's own program is spelled for the user's shell
 *  already (npm's bin wrapper carries `\`), so it renders bare like any safe word. */
const SAFE_PROGRAM = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

/** The program as typed: quoted by the argument rule when it carries a space or a shell word.
 *  Kept for pre-frame callers (prose.ts, the matrix check); no slash decision lives here. */
export function renderProgram(on: Invocation): string {
  return SAFE_PROGRAM.test(on.program) ? on.program : renderArgument(on.program, on.program);
}

/** The renderer proper: the FRAME is the input. Every decision — the checkout-root spelling
 *  (toCheckoutRoot, the frame's own places), the fallback shell, the quoting rule (the
 *  frame's shells) — reads the frame value, never the invocation's string spelling. */
export function renderFrameAdvice(
  advice: Advice,
  frame: Frame,
  // deploymentFree: a pointer to a command whose own usage never targets a deployment (the dispatcher's two).
  options?: { readonly deploymentFree?: boolean },
  // The spelling the caller typed, exactly as handed: a hand-over's checkout spelling (the
  // MCP launcher's two-levels-up program) is echoed as typed, but a Frame built from it
  // carries only the launch kind — the root spelling, not the hand-over — so the v1 wrapper
  // passes it through here (S1.3's Launch-carrying resolver removes the gap).
  asTyped?: string,
): string {
  return renderAdviceRows(advice, frame, options, asTyped)[0] ?? "";
}

/** The same rendering, one row per DISTINCT text (design §2.3 rule 5), with each row's note
 *  kept STRUCTURED instead of appended: callers that compose the line into a larger sentence
 *  (a completion header, help prose) place the note after the whole composed line, never
 *  inside the executable text. */
export interface AdviceRowPart {
  readonly line: string;
  readonly note?: string;
  /** The ONE shell this row is spelled for — set on a per-shell variant (the quoting split
   *  and an alternatives row one shell covers); absent when the row pastes in every shell the
   *  frame names. An alternatives row covering several, not all, shells names them only in
   *  its note. Callers route by this field, never by the note's prose. */
  readonly shell?: Shell;
  /** The row is the POSIX line standing in where the frame's shells have no spelling: it
   *  pastes in bash whatever `shell` says (the note names that shell, IN_BASH_NOTE). */
  readonly inBash?: true;
}

export function renderAdviceParts(
  advice: Advice,
  frame: Frame,
  options?: { readonly deploymentFree?: boolean },
  asTyped?: string,
): readonly AdviceRowPart[] {
  if (advice.kind === "shell") {
    if (advice.alternatives !== undefined && !frame.shells.includes(advice.shell)) {
      // The advice's own shell does not paste here: the frame's shells decide, in order.
      // One row per DISTINCT text; every frame shell spelling that text is collected, so a
      // row is shell-specific exactly when its shells do not cover the whole frame.
      const texts: string[] = [];
      const covered: Shell[][] = [];
      for (const s of frame.shells) {
        const text = s === advice.shell ? advice.text : advice.alternatives[s];
        if (text === undefined) continue;
        const seen = texts.indexOf(text);
        if (seen === -1) {
          texts.push(text);
          covered.push([s]);
        } else covered[seen]!.push(s);
      }
      if (texts.length === 0) {
        // No shell of the frame spells a line (cmd with a $-path cd): the POSIX text
        // stands in — bash, the documented checkout path on Windows — and the note names it.
        return [{ line: advice.text, note: IN_BASH_NOTE, inBash: true }];
      }
      // A row whose spelling shells are not the frame's FULL shell set is shell-specific:
      // it names the shells it is for, in frame order (the primary included — a line only
      // cmd pastes names cmd as much as one only pwsh pastes names pwsh).
      const parts: AdviceRowPart[] = texts.map((line, i) => {
        const shells = covered[i]!;
        // Full coverage stays unlabelled; partial coverage names its shells. An advice
        // note COMBINES with the shell label (label first) — never replaces it.
        const shellNote = shells.length === frame.shells.length ? undefined : `for ${shells.join(", ")}`;
        const only = shells.length === 1 && shellNote !== undefined ? { shell: shells[0]! } : {};
        if (i === 0 && advice.note !== undefined) {
          return { line, note: shellNote === undefined ? advice.note : `${shellNote}; ${advice.note}`, ...only };
        }
        return shellNote === undefined ? { line } : { line, note: shellNote, ...only };
      });
      return parts;
    }
    return [advice.note === undefined ? { line: advice.text } : { line: advice.text, note: advice.note }];
  }
  if (advice.kind === "manual") {
    return [{ line: advice.text }];
  }
  const on = handoverOf(frame);
  const handed = asTyped ?? on.program;
  // A shell-named advice (a completion Install: header) spells for that shell alone —
  // transition order (§2.3 rule 1): at → shell → app selection.
  const f = advice.shell === undefined ? frame : forShell(frame, advice.shell);
  const host = f.host.kind === "operator" ? f.host.platform : "posix";
  // A checkout-root advice spells the program from the checkout root — the frame the
  // place-naming sentences direct to — not from the directory this run refused in. The
  // same frame for a row that names a deployment the cwd's own selection does not, under
  // a cwd-resolving program: pasted where this run stands it is refused as an app
  // conflict (rf6-fix33), and the conflict refusal's own remedy is the checkout root —
  // so the row is spelled from there, with the note saying where it pastes.
  // A fresh paste re-selects from its directory, not from the preceding call's app.by:
  // --project-root may have selected aux by flag while the operator still stands in demo.
  // Include the inherited selector used by commandLine (for example the set-build remedy).
  const targetApp = advice.app ?? (!isGateCommand(advice.argv[0]) && options?.deploymentFree !== true
    && frame.app.state === "selected" && ["flag", "env", "sole"].includes(frame.app.by)
    ? frame.app.name : undefined);
  let cwdApp = frame.app.state === "selected" && frame.app.by === "cwd" ? frame.app.name : undefined;
  if (frame.cwd.kind === "dir" && frame.places.checkoutRoot !== undefined) {
    const underApps = relative(resolve(frame.places.checkoutRoot, "apps"), resolve(frame.cwd.path));
    const segments = underApps.split(/[\\/]+/);
    if (!isAbsolute(underApps) && segments[0] !== ".." && segments[0] !== "") cwdApp = segments[0];
  }
  const cwdConflict = targetApp !== undefined && cwdApp !== undefined && cwdApp !== targetApp
    && resolvesByCwd(frame.launch, on.program);
  // Decision O2: with the checkout root KNOWN the named deployment runs where the reader
  // stands — the --project-root selector points the cwd-resolving program at it, so the
  // row neither re-roots nor carries the paste-conflict note. Unknown root keeps the old
  // re-rooted row byte for byte.
  // O2 is an installed-entry selector; checkout keeps its available rooted shim (§2.3).
  const projectRoot = cwdConflict && frame.places.checkoutRoot !== undefined && modeOf(frame.launch) !== "checkout"
    ? `${frame.places.checkoutRoot}/apps/${targetApp}`
    : undefined;
  const rooted = advice.at === "checkout-root" || (cwdConflict && projectRoot === undefined);
  let note = advice.note ?? (cwdConflict && projectRoot === undefined ? CWD_CONFLICT_NOTE : undefined);
  let program = handed;
  let inBash = false;
  if (rooted) {
    // The re-rooted frame spells in the frame's primary shell, or — a bash shim under
    // [cmd, pwsh] — in none: there the POSIX spelling stands in (Git Bash, the documented
    // checkout path on Windows; decision O1). The note naming that shell is the S1.4
    // renderer's: this check set reads the note suffix as command words (design S1.6).
    // Without a known checkout root the transition is a no-op, so the spelling falls
    // back to the launch's own re-rooting (the pre-frame behavior, kept byte-identical).
    const reRooted = toCheckoutRoot(f);
    const root = reRooted.places.checkoutRoot;
    const launch = root === undefined ? rootedLaunch(f.launch) : reRooted.launch;
    // The spelling is relative to where the frame stands: the frame's places decide the
    // program (a wrong recorded root spells a wrong line), and the transition's paste
    // directory is the checkout root itself. Without a known root the transition is a
    // no-op and the launch's own re-rooting stands (the pre-frame behavior, kept
    // byte-identical).
    // The paste directory of the transition is the checkout root, so the row spells
    // from there (design §2.3/§3): the re-rooted frame's own cwd, not the directory
    // this run refused in. Without a known root it stays the frame's own cwd.
    const from = root === undefined
      ? (f.cwd.kind === "dir" ? f.cwd.path : undefined)
      : (reRooted.cwd.kind === "dir" ? reRooted.cwd.path : undefined);
    const primary = spell(launch, f.shells[0], host, from);
    program = primary ?? spell(launch, "posix", host, from) ?? handed;
    // The fallback case (O1, S1.2a): the frame's own shells have no spelling for the
    // re-rooted launch — npm's bin wrapper on win32 re-roots to the bash-only shim under
    // [cmd, pwsh] — so the POSIX spelling stands in (Git Bash, the documented checkout
    // path) and the note names that shell. A frame whose shells are [posix] spells the
    // shim itself and carries no note.
    if (primary === undefined) {
      note = note === undefined ? IN_BASH_NOTE : `${note}, ${IN_BASH_NOTE}`;
      inBash = true;
    }
  } else {
    // O4: a hint printed from a subdirectory of its launch root spells the entry relative
    // to the frame's paste directory, one climb per level; at the root the root spelling
    // stands byte-identical. Only a frame that knows BOTH its launch root and its paste
    // directory re-spells — a launch read back from a hand-over (root "") or a frame
    // without a paste directory keeps the handed spelling (the pre-frame behavior).
    const from = f.cwd.kind === "dir" ? f.cwd.path : undefined;
    const launchRoot = f.launch.kind === "checkout-shim" || f.launch.kind === "deployment-shim" || f.launch.kind === "npm-bin" ? f.launch.root : undefined;
    // A line that leaves the terminal for a NAMED shell — a completion Install: header —
    // spells for that shell whatever the launch root: a frame whose launch read back from a
    // hand-over carries root "" and must still re-spell (binSpelling's root "" case is
    // already the portable spelling).
    if (advice.shell !== undefined && from !== undefined) {
      const primary = spell(f.launch, f.shells[0], host, from);
      program = primary ?? spell(f.launch, "posix", host, from)
        ?? handed;
      // The shell the advice names may have no spelling (a pwsh install header under a
      // bash shim): the POSIX line pastes there only in Git Bash (design D6/O1) — the
      // note names that shell, like the rooted branch.
      if (primary === undefined) {
        note = note === undefined ? IN_BASH_NOTE : `${note}, ${IN_BASH_NOTE}`;
        inBash = true;
      }
    }
    if (launchRoot !== undefined && launchRoot !== "" && from !== undefined) {
      program = spell(f.launch, f.shells[0], host, from)
        ?? spell(f.launch, "posix", host, from)
        ?? handed;
    }
  }
  // Arguments quote by the frame's shells, not by the program's spelling: a frame that
  // also pastes into cmd.exe and PowerShell takes the double-quote rule, a POSIX-only
  // frame the POSIX one.
  const words = [program, ...advice.argv, ...(projectRoot === undefined ? [] : [projectRoot])];
  // A word that ends in a backslash splits too: cmd's program-side parser needs the run
  // doubled before the closing quote, which PowerShell and POSIX would read literally.
  if (!inBash && f.shells.length > 1 && words.some((word) => word.includes('"') || word.endsWith("\\") || (POSIX_ACTIVE.test(word) && word.includes("'")))) {
    // One variant per shell: no spelling of such a word pastes in all of them. Each part
    // names its shell structurally (AdviceRowPart.shell), the note keeps its prose.
    return f.shells.flatMap((shell) => renderAdviceParts(advice, { ...f, shells: [shell] }, options, asTyped).map((part): AdviceRowPart => ({
      ...part, note: part.note === undefined ? `for ${shell}` : `for ${shell}; ${part.note}`, shell,
    })));
  }
  // A bash fallback names the actual paste shell, regardless of advice.shell (D6/O1).
  const posixOnly = inBash || (f.shells.length === 1 && f.shells[0] === "posix");
  // A word quotes for ONE shell only when the frame names one; a mixed frame keeps the
  // shared double-quote rule.
  const only = f.shells.length === 1 ? f.shells[0] : undefined;
  const needsLegacy = (word: string): boolean => word.includes('"') || (/\s/.test(word) && word.endsWith("\\"));
  let protectedNativeWord = false;
  const shellArgument = (word: string): string => {
    // Legacy native handoff needs cmd's protected word inside a PowerShell literal.
    if (only === "pwsh" && needsLegacy(word)) {
      protectedNativeWord = true;
      return `'${cmdArgument(word).replaceAll("'", "''")}'`;
    }
    return shellArgumentForShell(word, only);
  };
  const quote = (word: string): string => (posixOnly ? posixArgument(word) : shellArgument(word));
  // The program quotes by the same rule as an argument (review R9-A R9-4): a hand-set
  // CLAWWRIGHT_INVOCATION whose program carries a space must still render a pasteable line.
  const parts = [SAFE_PROGRAM.test(program) ? program : quote(program)];
  if (projectRoot !== undefined) {
    // Decision O2: the selector reads --project-root as the first token; the path it names
    // implies the app, so no --app rides along. Quoted by the frame's shells rule, like
    // any argument — never by the program's spelling.
    parts.push("--project-root", quote(projectRoot));
  } else if (advice.app !== undefined) {
    parts.push("--app", quote(advice.app));
  } else if (
    !isGateCommand(advice.argv[0]) &&
    options?.deploymentFree !== true &&
    on.app !== undefined &&
    (on.app.selectedBy === "flag" || on.app.selectedBy === "env" || on.app.selectedBy === "sole")
  ) {
    // A flagged `openclaw` is named too: it is the default only while OC_APP is unset,
    // and the pasting shell may export it.
    parts.push("--app", quote(on.app.name));
  }
  for (const argument of advice.argv) parts.push(quote(argument));
  const text = parts.join(" ");
  const line = protectedNativeWord
    ? `& { $PSNativeCommandArgumentPassing = 'Legacy'; ${text} }` : text;
  const row: AdviceRowPart = note === undefined ? { line } : { line, note };
  return [inBash ? { ...row, inBash: true } : row];
}

/** The rows as text: each part's note appended in the `  (note)` suffix style. The rendered
 *  text is byte-identical to the pre-parts renderer — the frame law and the advice matrix
 *  read these strings. */
export function renderAdviceRows(
  advice: Advice,
  frame: Frame,
  options?: { readonly deploymentFree?: boolean },
  asTyped?: string,
): readonly string[] {
  return renderAdviceParts(advice, frame, options, asTyped).map((part) =>
    part.note === undefined ? part.line : `${part.line}  (${part.note})`
  );
}

/** Compatibility wrapper: the remaining Invocation-passing callers (commands/**,
 *  integration/**, the checks) convert to renderFrameAdvice in S1.3/S1.4. When `on` is
 *  omitted the installed frame (currentFrame) drives rendering; an explicit Invocation
 *  derives its frame without installing. */
export function renderAdvice(
  advice: Advice,
  on?: Invocation | Frame,
  options?: { readonly deploymentFree?: boolean },
): string {
  // The CURRENT invocation (the entry installed its frame, S1.3) renders against that
  // installed frame: a frame derived back from the hand-over spelling carries a rootless
  // launch, which would hide the known launch root the O4 rule below needs. An explicit
  // Invocation the caller holds separately keeps its derived frame (rootless frames render
  // exactly as before). A caller that holds the run's FRAME passes it whole — never a
  // projected Invocation, whose frameOf rebuild loses the roots and the cwd.
  const frame = on === undefined ? currentFrame()
    : "launch" in on ? on
    : on === invocation() ? currentFrame()
    : frameOf(on);
  // The spelling as handed: the stored Invocation's own program (a hand-over's checkout
  // spelling survives the frame round-trip only through this pass-through); a Frame spells
  // its own hand-over.
  const asTyped = on === undefined ? invocation().program : "launch" in on ? handoverOf(on).program : on.program;
  return renderFrameAdvice(advice, frame, options, asTyped);
}

export function commandLine(argv: string | readonly string[], options?: { readonly app?: string; readonly note?: string; readonly deploymentFree?: boolean; readonly at?: "checkout-root" }): string {
  return renderAdvice(command(argv, options), invocation(), { deploymentFree: options?.deploymentFree });
}

/** The install line a generated completion script spells in its header, and the --help
 *  prose sentences echo: this invocation's program and argv, spelled for the shell that
 *  pastes the line (CommandAdvice.shell), not for wherever the run stood. */
export function installLine(argv: readonly string[], shell: Shell): string {
  const part = installLineParts(argv, shell);
  return part.note === undefined ? part.line : `${part.line}  (${part.note})`;
}

/** installLine with the note STRUCTURED: the completion composers place the note after the
 *  whole composed header line, never inside the executable pipeline. The TARGET frame
 *  (frame.ts) drives the spelling: a stored line spells from its launch's own root for the
 *  shell that pastes it, never from wherever the run stood. */
export function installLineParts(argv: readonly string[], shell: Shell): AdviceRowPart {
  return renderAdviceParts(command(argv, { shell }), targetFrame(currentFrame(), shell), undefined, invocation().program)[0]!;
}

/** The caller-less reads that remain (all inside core/io/invocation/**, frameReads = 0
 *  elsewhere): (1) this accessor — formatError's and nextActions' slots, whose callers
 *  hold no frame; (2) renderAdvice's currentFrame() fallback when no Invocation is
 *  passed — the commands/** call sites (S1.5 scope); (3) commandLine/installLine('s and
 *  installLineParts') invocation() — the same S1.5 scope; (4) prose.ts's default
 *  invokedFrame() — inside the invocation module itself. */
export function renderCurrentAdviceRows(advice: Advice): readonly string[] {
  return renderAdviceRows(advice, currentFrame());
}
