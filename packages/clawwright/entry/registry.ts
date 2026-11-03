// One list for every surface a gate presents. tools/clawwright.ts and framework/entry/bin.ts
// build their own gate from here (checkoutGate / installedGate) instead of assembling it in
// place, and a name-reading surface (help, completion, documentation, the structural checks)
// reads surfaceRegistry — the one command registry — so there is no second hand list of gate
// names to keep in step. Declarations live where they always did (entry/checkout-gate.ts,
// integration/version.ts, integration/completion/, integration/deployment/init.ts); this only
// sequences them and closes completion over the finished array, itself included.

import { openclawCommands } from "../commands/interface/index.ts";
import { checkoutGateCommands } from "./checkout-gate.ts";
import { makeVersionGateCommand } from "../integration/version.ts";
import { makeCompletionGateCommand } from "../integration/completion/index.ts";
import { makeInitGateCommand, type InitPlacement } from "../integration/deployment/init.ts";
import { commandRegistry, type CommandRegistry, type GateCommand } from "../integration/gate.ts";

/** The checkout (monorepo) gate's own commands, in help order: the declared check/new-app/
 *  remove-app/list, version and completion — the array tools/clawwright.ts assembled in place
 *  until the registry commit. */
export function checkoutGate(): GateCommand[] {
  const gate: GateCommand[] = [...checkoutGateCommands, makeVersionGateCommand()];
  gate.push(makeCompletionGateCommand(gate, true));
  return gate;
}

/** The installed gate's own commands: init (carrying the placement decision this entry made),
 *  version and completion — the array framework/entry/bin.ts assembled in place. */
export function installedGate(appRoot: string, placement: InitPlacement = {}): GateCommand[] {
  const gate: GateCommand[] = [makeInitGateCommand(appRoot, placement), makeVersionGateCommand(appRoot)];
  gate.push(makeCompletionGateCommand(gate, false));
  return gate;
}

/** The one registry a name-reading surface reads: the deployment's own commands, the checkout
 *  gate's, and the installed gate's `init` — every command a terminal, a tool call, a completion
 *  script or the docs table can name, in one place, app-named for this repo. */
export function surfaceRegistry(): CommandRegistry {
  return commandRegistry({
    deployment: openclawCommands,
    gate: [...checkoutGate(), makeInitGateCommand("<app-root>")],
    appName: "clawwright",
  });
}
