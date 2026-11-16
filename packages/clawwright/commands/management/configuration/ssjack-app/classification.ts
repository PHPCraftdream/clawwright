// How ssjack treats each Clawwright command, reviewed by hand — never guessed from names.
// ssjack runs `observational` commands as they are, requires confirm=true for every other
// command, and refuses `refused` ones even with confirm. Every name the one command registry
// (entry/registry.ts) offers must appear exactly once; the registry check fails otherwise, so
// a new command cannot ship unclassified. An unlisted name is simply not observational, so a
// command a deployment adds on its own always needs confirm.
//
// observational: every call is read-only (declared effect `read` on every action and flag),
//   needs no interactive input, ends by itself and prints no secret. `logs` reads a bounded tail
//   off a terminal.
// refused: stdio servers that own the stream (mcp-serve, control-mcp), the command that prints
//   the gateway token (mcp-creds), and the pass-through commands that run any program with
//   the instance's environment and may read stdin or a terminal (cli, exec, host).
// confirmed: everything else — it changes or destroys state, or reads something heavy.

export type SsjackClass = "observational" | "confirmed" | "refused";

export const SSJACK_CLASSIFICATION = {
  // deployment commands
  bootstrap: "confirmed",
  up: "confirmed",
  restart: "confirmed",
  down: "confirmed",
  destroy: "confirmed",
  logs: "observational",
  backup: "confirmed",
  restore: "confirmed",
  pull: "confirmed",
  push: "confirmed",
  verify: "observational",
  upgrade: "confirmed",
  smoke: "confirmed",
  inspect: "observational",
  doctor: "observational",
  plan: "observational",
  apply: "confirmed",
  accept: "confirmed",
  rollback: "confirmed",
  operations: "confirmed",
  "apply-config": "confirmed",
  "backup-text": "confirmed",
  "deploy-text": "confirmed",
  expose: "confirmed",
  watch: "confirmed",
  incident: "confirmed",
  "recover-env": "confirmed",
  memory: "confirmed",
  status: "observational",
  lock: "confirmed",
  cli: "refused",
  exec: "refused",
  host: "refused",
  "cli-start": "confirmed",
  "cli-stop": "confirmed",
  "configure-provider": "confirmed",
  secrets: "confirmed",
  recipe: "confirmed",
  files: "confirmed",
  "provision-agent": "confirmed",
  deploy: "confirmed",
  "mcp-serve": "refused",
  "mcp-setup": "confirmed",
  "mcp-creds": "refused",
  "ssjack-descriptor": "confirmed",
  set: "confirmed",
  // gate commands
  check: "confirmed",
  "new-app": "confirmed",
  "remove-app": "confirmed",
  list: "observational",
  version: "observational",
  completion: "observational",
  init: "confirmed",
  // the dispatcher's own commands
  "control-mcp": "refused",
  help: "observational",
} as const satisfies Readonly<Record<string, SsjackClass>>;

/** The names of one class, sorted so the descriptor is byte-stable. */
export function commandsOf(kind: SsjackClass): string[] {
  const names: string[] = [];
  for (const [name, assigned] of Object.entries(SSJACK_CLASSIFICATION)) {
    if (assigned === kind) names.push(name);
  }
  return names.sort();
}
