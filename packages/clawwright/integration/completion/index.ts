// Shell completion, generated from the live command declarations rather than hand-maintained:
// command names, each command's own flags, and — for a multi-action command's `action`
// positional (CommandArgument.choices) — its flags placed under the right action
// (CommandArgument.actions), the same field help-render.ts and the MCP schema already read.
// The declarations reach a script only as a table (table.ts); bash.ts and pwsh.ts are that
// table plus a fixed interpreter each, and this module picks between the two.
//
// Every shell calls `<invoked name> list --json --no-status` lazily, from inside the completer,
// only once a shell asks for `--app`'s value — never baked into the generated text, and via
// whichever of the system-wide command or the checkout shim was typed. Output never carries a machine path.

import { commandBody } from "../../core/command/spec.ts";
import type { ArgumentSpec } from "../../core/command/spec.ts";
import * as kinds from "../../core/values/kinds.ts";
import { installLineParts } from "../../core/io/invocation/render.ts";
import { emitRaw } from "../../core/io/output.ts";
import { openclawCommands } from "../../commands/interface/index.ts";
import { bashCompletionLines, renderBash } from "./bash.ts";
import { renderPwsh } from "./pwsh.ts";
import { completionData, type CompletionData } from "./table.ts";
import { commandRegistry, materializeGate, type GateCommand } from "../gate.ts";

export type CompletionShell = "bash" | "zsh" | "pwsh";

export const COMPLETION_SHELLS: readonly CompletionShell[] = ["bash", "zsh", "pwsh"];

export const COMPLETION_COMMAND_NAME = "completion";

export const COMPLETION_ARGUMENTS = [
  // One carrier now: the kind is the grammar, and argumentsView projects its `choices` for
  // completion/table.ts and the MCP schema exactly as the dual carrier used to.
  { name: "shell", description: "bash, zsh or pwsh", kind: "positional", required: true, value: kinds.choice(COMPLETION_SHELLS) },
] as const satisfies readonly ArgumentSpec[];

/** The zsh script is the bash script, byte for byte, behind zsh's own header: `bashcompinit`
 *  shims COMP_WORDS/COMP_CWORD for exactly this old-style `complete -F` shape, so both shells
 *  load one completion grammar rather than two that could drift. The body is sliced out of the
 *  bash render itself, which is what makes that identity hold. */
function renderZsh(data: CompletionData): string {
  const bash = renderBash(data);
  const body = bash.slice(bash.indexOf("_clawwright_lookup()"), bash.indexOf(bashCompletionLines));
  // The note (installLineParts) rides AFTER each whole composed line, never inside it.
  const install = installLineParts(["completion", "zsh"], "posix");
  const note = install.note === undefined ? "" : `  (${install.note})`;
  return (
    "#compdef clawwright ./clawwright\n" +
    "# clawwright zsh completion — generated from the live command declarations, via bash's\n" +
    "# completion protocol (bashcompinit), so this cannot drift from the bash script's own\n" +
    `# grammar. Install: ${install.line} > "\${fpath[1]}/_clawwright" (new shell), or${note}\n` +
    `# source <(${install.line}) in the current one.${note}\n` +
    "autoload -Uz bashcompinit\n" +
    "bashcompinit\n" +
    body +
    bashCompletionLines
  );
}

export function renderCompletion(shell: CompletionShell, data: CompletionData): string {
  if (shell === "bash") return renderBash(data);
  if (shell === "zsh") return renderZsh(data);
  return renderPwsh(data);
}

/** `siblings` is the SAME array the caller builds its own gate list into — this command is
 *  pushed onto it after the literal. The registry is built from it inside `run`, so it sees
 *  every entry (itself included) once the command executes. `appFlag` says whether the
 *  caller's gate has an `--app` selector (the monorepo gate does; the installed
 *  single-deployment one doesn't). */
export function makeCompletionGateCommand(siblings: readonly GateCommand[], appFlag: boolean): GateCommand {
  return materializeGate({
    name: COMPLETION_COMMAND_NAME,
    summary: "Print a shell completion script (bash, zsh or pwsh) to stdout",
    details:
      "Generated from the live command declarations — names, flags, and a multi-action " +
      "command's own flags under the right action — so it cannot drift from --help.\n" +
      'Install: eval "$({install completion bash})"; ' +
      '{install completion zsh} > "${fpath[1]}/_clawwright"; or take ' +
      "{install completion pwsh} and pipe it through Out-String and Invoke-Expression.\n" +
      (appFlag ? "--app's own value completion calls `<the name you typed> list --json --no-status` lazily, only once a shell actually asks for it — never baked into the script.\n" : "") +
      "Completes the built-in commands only: a command a deployment declares itself is not offered, " +
      "since the script is generated without loading any deployment.\n" +
      "No deployment is resolved, no .env is read, no lock is touched.",
    body: commandBody({
      needs: "nothing",
      effect: "read",
      arguments: COMPLETION_ARGUMENTS,
      run: async (_on, plan) => {
        const model = completionData(commandRegistry({ deployment: openclawCommands, gate: siblings, appName: "clawwright" }), appFlag);
        emitRaw(renderCompletion(plan.shell, model));
        return 0;
      },
    }),
  });
}
