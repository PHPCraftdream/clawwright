// The PowerShell half of the generated completion, split so the fixed part is a constant:
// everything the declarations decide lives in the tables above, and the interpreter below
// carries not one substitution from them — the same interpreter body renders identically for
// two different command sets, so a check can diff renders and drive the two scripts against
// completionCandidates() differentially.

import { installLineParts } from "../../core/io/invocation/render.ts";
import type { CompletionData } from "./table.ts";

/** The `$clawwrightCompleter = { … }` body — the decision completionCandidates() makes, branch
 *  for branch: skip `--app <value>`, take the command from the words before the cursor, let the
 *  word after the command scope an option's values, and fall back `first` → `after` (a
 *  `"<cmd> *" entry when the word after the command is not a known action). `$clawwrightApp`,
 *  `$clawwrightTop`, `$clawwrightFirst`, `$clawwrightAfter`, `$clawwrightVerbatim`, `$clawwrightVerbatimFlags`, `$clawwrightValueOptions` and `$clawwrightValues` are the only
 *  things the data reaches the interpreter through.
 *  Plain double-quoted literals concatenated with `+`, never a template literal: one would eat
 *  `$wordToComplete`, `$commandAst`, `"$wordToComplete*"` and `$($between[0])` (design
 *  section 9, pitfall 9).
 *  Every comparison is ordinal like the parser's and bash's: `-ceq`, `-ccontains`, `-clike`,
 *  `Sort-Object -CaseSensitive`, and the tables are built with an ordinal comparer (a plain
 *  `@{}` and `-contains` fold case, so `Backup` or `--TAIL` would be read as declared).
 *  Windows PowerShell 5.1: no `??`, no `?.`, no ternary, and every `if` that can yield one
 *  element wrapped in `@(...)` — unwrapped, a single result stops being an array and the
 *  `.Count` below it becomes a String's length (verified on powershell.exe 5.1). */
export const PWSH_COMPLETER: string =
  "  param($wordToComplete, $commandAst, $cursorPosition)\n" +
  "  $tokens = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })\n" +
  "  $rest = @(if ($tokens.Count -gt 1) { @($tokens[1..($tokens.Count - 1)]) } else { @() })\n" +
  "  # Only the words BEFORE the word being completed pick the command — the partial word\n" +
  "  # itself is not a typed command (R32-02: 'clawwright sta<Tab>' saw the command \"sta\").\n" +
  "  $scan = $rest\n" +
  "  if ($wordToComplete -ne '') {\n" +
  "    $scan = @(if ($rest.Count -gt 1) { @($rest[0..($rest.Count - 2)]) } else { @() })\n" +
  "  }\n" +
  "  $prev = $null\n" +
  "  if ($scan.Count -ge 1) { $prev = $scan[$scan.Count - 1] }\n" +
  "  # --app is positional and takes a value: the pair is skipped, so it is never read as the\n" +
  "  # command (and a value that looks like a command name does not shadow the real one).\n" +
  "  # The '--app=<name>' form carries its own value in one token: it is skipped alone.\n" +
  "  $i = 0\n" +
  "  while ($clawwrightApp -and $i -lt $scan.Count -and ($scan[$i] -ceq '--app' -or $scan[$i].StartsWith('--app='))) { $i = $i + $(if ($scan[$i] -ceq '--app') { 2 } else { 1 }) }\n" +
  "  $candidates = @()\n" +
  "  if ($i -ge $scan.Count) {\n" +
  "    if ($clawwrightApp -and $prev -ceq '--app') {\n" +
  "      # --app's own value, lazily: only while no command word has been typed — --app must\n" +
  "      # come before the command, so past one the command's flags return (R33-10). Whichever\n" +
  "      # of the system-wide command or the checkout shim was typed makes the call.\n" +
  "      $names = @(try { & $tokens[0] list --json --no-status 2>$null | ConvertFrom-Json | ForEach-Object { $_.name } | Where-Object { $_ -notlike '.*' } } catch { @() })\n" +
  "      $names | Where-Object { $_ -clike \"$wordToComplete*\" } | ForEach-Object {\n" +
  "        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)\n" +
  "      }\n" +
  "      return\n" +
  "    }\n" +
  "    $candidates = @($clawwrightTop)\n" +
  "  } else {\n" +
  "    $cmd = $scan[$i]\n" +
  "    $between = @()\n" +
  "    if ($scan.Count - $i - 1 -gt 0) { $between = @($scan[($i + 1)..($scan.Count - 1)]) }\n" +
  "    # The words typed so far, read the way the parser reads them: an option takes the next\n" +
  "    # word as its value (so a `--` there is no marker), a bare `--` ends the options, and a\n" +
  "    # pass-through command's literal tail starts at its first undeclared dash word or its\n" +
  "    # first word past the declared positionals.\n" +
  "    $ended = $false\n" +
  "    $swallow = $false\n" +
  "    $tail = $false\n" +
  "    $free = 0\n" +
  "    $isVerbatim = $clawwrightVerbatim.ContainsKey($cmd)\n" +
  "    foreach ($w2 in $between) {\n" +
  "      if ($swallow) { $swallow = $false; continue }\n" +
  "      if ($w2 -ceq '--') { $ended = $true; break }\n" +
  "      $key = $w2\n" +
  "      $inline = $false\n" +
  "      if ($w2.StartsWith('--') -and $w2.Contains('=')) { $key = $w2.Substring(0, $w2.IndexOf('=')); $inline = $true }\n" +
  "      if ((-not $inline) -and ($w2 -cne '') -and ($clawwrightValueOptions[$cmd] -ccontains $w2)) { $swallow = $true; continue }\n" +
  "      if ($w2.StartsWith('-')) {\n" +
  "        if ($isVerbatim -and -not ($clawwrightVerbatimFlags[$cmd] -ccontains $key)) { $tail = $true; break }\n" +
  "        continue\n" +
  "      }\n" +
  "      $free = $free + 1\n" +
  "      if ($isVerbatim -and $free -gt $clawwrightVerbatim[$cmd]) { $tail = $true; break }\n" +
  "    }\n" +
  "    # The first word names the action; an option still waiting for its value completes that\n" +
  "    # value (keyed command + action + option), or nothing when it has no choices.\n" +
  "    $scope = ''\n" +
  "    $afterKey = \"$cmd $($between[0])\"\n" +
  "    if ($between.Count -gt 0 -and $clawwrightAfter.ContainsKey($afterKey)) { $scope = $between[0] }\n" +
  "    if ($between.Count -eq 0) {\n" +
  "      # An unknown command reaches `first` with nothing under that key: the @() keeps the\n" +
  "      # type an array and the filter below drops the $null — nothing is offered.\n" +
  "      $candidates = @($clawwrightFirst[$cmd])\n" +
  "    } elseif ($ended -or $tail) {\n" +
  "      $candidates = @()\n" +
  "    } elseif ($swallow) {\n" +
  "      $key = \"$cmd$scope$prev\"\n" +
  "      if ($clawwrightValues.ContainsKey($key)) { $candidates = @($clawwrightValues[$key]) } else { $candidates = @() }\n" +
  "    } elseif ($clawwrightAfter.ContainsKey($afterKey)) {\n" +
  "      $candidates = @($clawwrightAfter[$afterKey])\n" +
  "    } else {\n" +
  "      $candidates = @($clawwrightAfter[\"$cmd *\"])\n" +
  "    }\n" +
  "  }\n" +
  "  $candidates | Where-Object { $_ -clike \"$wordToComplete*\" } | Sort-Object -Unique -CaseSensitive | ForEach-Object {\n" +
  "    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)\n" +
  "  }\n";

/** The data tables, emitted in `data`'s own order: the table module sorts as it builds, so a
 *  second sort here would be a second, divergent rule. */
export function renderPwsh(data: CompletionData): string {
  const quoted = (values: readonly string[]): string => values.map((value) => `"${value}"`).join(", ");
  const entries = (source: ReadonlyMap<string, readonly string[]>): string[] =>
    [...source].map(([key, values]) => `  "${key}" = @(${quoted(values)})`);
  const block = (name: string, lines: readonly string[]): string =>
    `$${name} = [hashtable]::new(@{\n${lines.length === 0 ? "" : `${lines.join("\n")}\n`}}, [System.StringComparer]::Ordinal)`;
  const values = data.values.map((entry) => `  "${entry.command}${entry.scope}${entry.option}" = @(${quoted(entry.values)})`);
  const install = installLineParts(["completion", "pwsh"], "pwsh");
  // A bash-only fallback must not read as a PowerShell pipeline: the header names the
  // condition instead (the shim runs in Git Bash; PowerShell consumes its saved output).
  const installText = install.note?.includes("in bash") === true
    ? `run ${install.line} in Git Bash, save the output to a file, and dot-source it from PowerShell`
    : `${install.line} | Out-String | Invoke-Expression${install.note === undefined ? "" : `  (${install.note})`}`;
  return (
    "# clawwright PowerShell completion — generated from the command declarations.\n" +
    `# Install: ${installText}\n` +
    (data.appFlag ? "$clawwrightApp = $true\n" : "$clawwrightApp = $false\n") +
    `$clawwrightTop = @(${quoted(data.top)})\n` +
    block("clawwrightFirst", entries(data.first)) +
    "\n" +
    block("clawwrightAfter", entries(data.after)) +
    "\n" +
    block("clawwrightVerbatim", [...data.verbatim].map(([command, positionals]) => `  "${command}" = ${positionals}`)) +
    "\n" +
    block("clawwrightVerbatimFlags", [...data.verbatimFlags].map(([command, flags]) => `  "${command}" = @(${quoted(flags)})`)) +
    "\n" +
    block("clawwrightValueOptions", [...data.valueOptions].map(([command, options]) => `  "${command}" = @(${quoted(options)})`)) +
    "\n" +
    block("clawwrightValues", values) +
    "\n" +
    "$clawwrightCompleter = {\n" +
    PWSH_COMPLETER +
    "}\n" +
    "Register-ArgumentCompleter -Native -CommandName clawwright, ./clawwright -ScriptBlock $clawwrightCompleter\n"
  );
}
