// The bash half of the generated completion (zsh sources the same text through bashcompinit —
// see index.ts), split the way pwsh.ts is: the interpreter below is fixed text and carries not
// one substitution from the command declarations. Every candidate list lives in
// `_clawwright_lookup`'s generated case arms, built from the same table completionCandidates()
// answers and the pwsh script renders, so a script and the table it was rendered from cannot
// quietly diverge.

import { installLineParts } from "../../core/io/invocation/render.ts";
import type { CompletionData } from "./table.ts";

// Hidden directories (.r28) are not deployments.
const APP_VALUES_PIPELINE = "$(\"${COMP_WORDS[0]}\" list --json --no-status 2>/dev/null | grep -o '\"name\":\"[^\"]*\"' | cut -d'\"' -f4 | grep -v '^[.]')";

/** The `--app` pair the command scan steps over: `--app` leads the command line and takes the
 *  next word as its own value, so neither is read as the command (a value that looks like a
 *  command name does not shadow the real one); the `--app=<name>` form carries its own value
 *  in one token. Emitted only where the gate has an `--app`
 *  selector — an installed single-deployment gate must not mention it in its script either. */
export const APP_SKIP_PAIR: string =
  "if [[ $skip -eq 1 ]]; then skip=0; continue; fi\n" +
  "    if [[ \"$w\" == \"--app\" ]]; then skip=1; continue; fi\n" +
  "    if [[ \"$w\" == --app=* ]]; then continue; fi\n";
/** `--app`'s own value, offered only while no command word has been typed yet — past one it is
 *  positional and must come before the command, so the command's flags return (R33-10). The
 *  names are asked for lazily, through whichever of the system-wide command or the checkout
 *  shim was typed, and never baked into the generated text. */
export const APP_VALUES_BLOCK: string =
  "if [[ \"$prev\" == \"--app\" ]]; then\n" +
  "    COMPREPLY=( $(compgen -W \"" + APP_VALUES_PIPELINE + "\" -- \"$cur\") )\n" +
  "    return\n" +
  "  fi\n";

/** The fixed half of the bash/zsh script. `_clawwright_lookup` holds the declarations — one case
 *  arm per table row — and `_clawwright_complete` is the decision completionCandidates() makes,
 *  branch for branch, with not one substitution from them: `__CLAWWRIGHT_CASE_ARMS__` is the one
 *  data placeholder renderBash() fills with the generated arms, and the two `__CLAWWRIGHT_APP_`
 *  slots carry the `--app` handling a gate without an `--app` selector leaves empty.
 *  Plain double-quoted literals concatenated with `+`, never a template literal: one would eat
 *  `${COMP_WORDS[0]}`, `$cur` and `$prev` (design section 9, pitfall 9).
 *  bash 3.2 (`/bin/bash` on macOS) stays supported: no `declare -A`, no `mapfile`, no `${x,,}`. */
export const BASH_COMPLETER: string =
  "_clawwright_lookup() {\n" +
  "  case \"$1\" in\n" +
  "    __CLAWWRIGHT_CASE_ARMS__" +
  "    *) return 1 ;;\n" +
  "  esac\n" +
  "}\n" +
  "\n" +
  "_clawwright_complete() {\n" +
  "  local cur=\"${COMP_WORDS[COMP_CWORD]}\"\n" +
  "  local prev=\"${COMP_WORDS[COMP_CWORD-1]}\"\n" +
  "  local words=(\"${COMP_WORDS[@]}\")\n" +
  "  local cword=$COMP_CWORD\n" +
  "  local cmd=\"\" idx=0 skip=0\n" +
  "  local between=() scope=\"\" reply=\"\"\n" +
  "  for ((i = 1; i < cword; i++)); do\n" +
  "    local w=\"${words[i]}\"\n" +
  "    __CLAWWRIGHT_APP_SKIP__" +
  "    cmd=\"$w\"; idx=$i; break\n" +
  "  done\n" +
  "  if [[ -z \"$cmd\" ]]; then\n" +
  "    __CLAWWRIGHT_APP_VALUES__" +
  "    if _clawwright_lookup \"top\"; then COMPREPLY=( $(compgen -W \"$_clawwright_reply\" -- \"$cur\") ); else COMPREPLY=(); fi\n" +
  "    return\n" +
  "  fi\n" +
  "  if (( cword - idx - 1 > 0 )); then between=(\"${words[@]:$((idx + 1)):$((cword - idx - 1))}\"); fi\n" +
  "  # The command's own first candidates; a command the table does not carry completes to\n" +
  "  # nothing at all.\n" +
  "  if _clawwright_lookup \"first $cmd\"; then COMPREPLY=( $(compgen -W \"$_clawwright_reply\" -- \"$cur\") ); else COMPREPLY=(); return; fi\n" +
  "  # Nothing after the command: the word being completed IS its own first position, which\n" +
  "  # the lookup above already answered.\n" +
  "  if (( ${#between[@]} == 0 )); then return; fi\n" +
  "  # The words typed so far, read the way the parser reads them: an option takes the next word\n" +
  "  # as its value (so a `--` there is no marker), a bare `--` ends the options, and a\n" +
  "  # pass-through command's literal tail starts at its first undeclared dash word or its first\n" +
  "  # word past the declared positionals. Missing arms answer empty.\n" +
  "  local opts=\"\" flags=\"\" verb=\"\" isverb=0 ended=0 swallow=0 tail=0 free=0 token key inline\n" +
  "  if _clawwright_lookup \"valueOptions $cmd\"; then opts=\"$_clawwright_reply\"; fi\n" +
  "  if _clawwright_lookup \"verbatim $cmd\"; then isverb=1; verb=\"$_clawwright_reply\"; fi\n" +
  "  if _clawwright_lookup \"verbatimFlags $cmd\"; then flags=\"$_clawwright_reply\"; fi\n" +
  "  for token in \"${between[@]}\"; do\n" +
  "    if (( swallow )); then swallow=0; continue; fi\n" +
  "    if [[ \"$token\" == \"--\" ]]; then ended=1; break; fi\n" +
  "    key=\"$token\"; inline=0\n" +
  "    if [[ \"$token\" == --*=* ]]; then key=\"${token%%=*}\"; inline=1; fi\n" +
  "    if (( ! inline )) && [[ -n \"$token\" && \" $opts \" == *\" $token \"* ]]; then swallow=1; continue; fi\n" +
  "    if [[ \"$token\" == -* ]]; then\n" +
  "      if (( isverb )) && [[ \" $flags \" != *\" $key \"* ]]; then tail=1; break; fi\n" +
  "      continue\n" +
  "    fi\n" +
  "    free=$((free + 1))\n" +
  "    if (( isverb && free > verb )); then tail=1; break; fi\n" +
  "  done\n" +
  "  if (( ended || tail )); then COMPREPLY=(); return; fi\n" +
  "  # The first word names the action; an option still waiting for its value completes that\n" +
  "  # value (keyed command + action + option), or nothing when it has no choices.\n" +
  "  if [[ \"${between[0]}\" != -* ]] && _clawwright_lookup \"after $cmd ${between[0]}\"; then scope=\"${between[0]}\"; fi\n" +
  "  if (( swallow )); then\n" +
  "    if _clawwright_lookup \"values ${cmd}${scope}${prev}\"; then COMPREPLY=( $(compgen -W \"$_clawwright_reply\" -- \"$cur\") ); else COMPREPLY=(); fi\n" +
  "    return\n" +
  "  fi\n" +
  "  # Past a word after the command: that word's own list, else the command's fallback.\n" +
  "  if _clawwright_lookup \"after $cmd ${between[0]}\"; then\n" +
  "    COMPREPLY=( $(compgen -W \"$_clawwright_reply\" -- \"$cur\") )\n" +
  "  elif _clawwright_lookup \"after $cmd *\"; then\n" +
  "    COMPREPLY=( $(compgen -W \"$_clawwright_reply\" -- \"$cur\") )\n" +
  "  else\n" +
  "    COMPREPLY=()\n" +
  "  fi\n" +
  "}\n";

/** One arm: the key the interpreter looks up, and the space-joined candidates it answers with.
 *  `top` sits at the `case`'s own indent, the rows keyed under a command inside it. */
function caseArm(indent: string, key: string, words: readonly string[]): string {
  return `${indent}"${key}") _clawwright_reply="${words.join(" ")}" ;;\n`;
}

/** The declarations as case arms, in the table's own order: what to offer before a command
 *  name, at the word right after it, past its action word, and at a choice-valued option's own
 *  value. table.ts sorts as it builds, so a second sort here would be a second, divergent rule. */
function caseArms(data: CompletionData): string {
  return [
    caseArm("  ", "top", data.top),
    ...[...data.first].map(([command, words]) => caseArm("    ", `first ${command}`, words)),
    ...[...data.after].map(([key, words]) => caseArm("    ", `after ${key}`, words)),
    ...[...data.verbatim].map(([command, positionals]) => caseArm("    ", `verbatim ${command}`, [String(positionals)])),
    ...[...data.verbatimFlags].map(([command, flags]) => caseArm("    ", `verbatimFlags ${command}`, flags)),
    ...[...data.valueOptions].map(([command, options]) => caseArm("    ", `valueOptions ${command}`, options)),
    ...data.values.map((row) => caseArm("    ", `values ${row.command}${row.scope}${row.option}`, row.values)),
  ].join("");
}

/** The two registrations: the same completer under the system-wide command and the checkout
 *  shim. Shared with zsh (index.ts), which loads this body through bashcompinit. */
export const bashCompletionLines: string =
  "complete -F _clawwright_complete clawwright\n" +
  "complete -F _clawwright_complete ./clawwright\n";

/** The bash script: the two header lines, the interpreter with the generated arms in place of
 *  `__CLAWWRIGHT_CASE_ARMS__` (and the `--app` slots filled only where the gate has one), then
 *  the registrations. Nothing else — no command name is written anywhere in this file. */
export function renderBash(data: CompletionData): string {
  // The note rides AFTER the whole composed line (installLineParts), never inside it.
  const install = installLineParts(["completion", "bash"], "posix");
  return (
    "# clawwright bash completion — generated from the command declarations.\n" +
    `# Install: eval "$(${install.line})"${install.note === undefined ? "" : `  (${install.note})`}\n` +
    BASH_COMPLETER.replaceAll("__CLAWWRIGHT_CASE_ARMS__", caseArms(data))
      .replaceAll("__CLAWWRIGHT_APP_SKIP__", data.appFlag ? APP_SKIP_PAIR : "")
      .replaceAll("__CLAWWRIGHT_APP_VALUES__", data.appFlag ? APP_VALUES_BLOCK : "") +
    bashCompletionLines
  );
}
