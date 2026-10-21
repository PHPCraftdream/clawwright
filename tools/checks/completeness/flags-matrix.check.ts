// U9: `--json`/`--dry-run` coverage is a decision, not an accident.
//
// The table below is the decision, one row per command: whether it carries `--json` and/or
// `--dry-run`, and — for every "no" — the one-line reason. Checked against openclawCommands
// (the live declarations `--help`, the MCP schema and `parseDeclaredArgs` all read from), so
// a command whose `arguments` gain or lose either flag without this table changing fails
// here rather than drifting silently. A command missing from the table fails too: a new
// command must state its position before this check passes, which is the point.
//
// The gate commands (entry/checkout-gate.ts, integration/{version,completion,deployment/init}.ts
// via entry/registry.ts) are declared without import-time side effects, so the GATE_TABLE below
// cross-checks them live like any other command — none carries --json or --dry-run except
// where stated, and their full flag lists are pinned, not just the two U9 flags.

import { openclawCommands } from "#framework/commands/interface/index.ts";
import { specOf, specShape } from "#framework/core/command/index.ts";
import { checkoutGate, installedGate } from "#framework/entry/registry.ts";
import { check, finish } from "#checks/kit/harness.ts";

interface FlagPosition {
  readonly json: boolean;
  /** Required unless `json` is true. */
  readonly jsonReason?: string;
  readonly dryRun: boolean;
  /** Required unless `dryRun` is true. */
  readonly dryRunReason?: string;
}

function position(entry: FlagPosition): FlagPosition {
  if (!entry.json && entry.jsonReason === undefined) throw new Error("a 'no' position needs a reason");
  if (!entry.dryRun && entry.dryRunReason === undefined) throw new Error("a 'no' position needs a reason");
  return entry;
}

// Console/passthrough commands: their own argv belongs to another program (cli/exec/host) or
// they own stdio for a protocol (mcp-serve) or a live TTY (up/down/restart briefly stream
// compose's own output, logs follows) — a flag of ours would either be swallowed by the
// wrapped program or have nothing to structure/preview.
const CONSOLE_REASON = "passes its own argv through to another program or owns stdio — no output of ours to structure";
const NOTHING_TO_PREVIEW = "converges on a state (running/stopped) rather than replacing one — nothing a preview would show beyond running the real thing";

const TABLE: Record<string, FlagPosition> = {
  // --- lifecycle ---
  bootstrap: position({ json: true, dryRun: false, dryRunReason: "--check is bootstrap's own read-only prerequisite report; there is no in-between dry run of the real sequence" }),
  up: position({ json: false, jsonReason: CONSOLE_REASON, dryRun: false, dryRunReason: NOTHING_TO_PREVIEW }),
  restart: position({ json: false, jsonReason: CONSOLE_REASON, dryRun: false, dryRunReason: NOTHING_TO_PREVIEW }),
  down: position({ json: false, jsonReason: CONSOLE_REASON, dryRun: false, dryRunReason: NOTHING_TO_PREVIEW }),
  destroy: position({ json: false, jsonReason: "prints its plan/result as text; the plan is what a run without --yes shows", dryRun: false, dryRunReason: "a dry run is the default — only --yes performs the removal" }),
  logs: position({ json: true, dryRun: false, dryRunReason: CONSOLE_REASON }),
  backup: position({ json: true, dryRun: true }),
  restore: position({ json: true, dryRun: true }),
  pull: position({ json: true, dryRun: false, dryRunReason: "only ever adds a new snapshot file — never replaces existing state, so there is nothing destructive to preview" }),
  push: position({ json: true, dryRun: true }),
  verify: position({ json: true, dryRun: false, dryRunReason: "verify is already read-only — a dry run of a read is the read" }),
  upgrade: position({ json: true, dryRun: true }),
  smoke: position({ json: true, dryRun: false, dryRunReason: "smoke is itself a read-only acceptance run" }),

  // --- management ---
  status: position({ json: true, dryRun: false, dryRunReason: "already a read-only report" }),
  lock: position({ json: true, dryRun: false, dryRunReason: "--check already compares without writing" }),
  cli: position({ json: false, jsonReason: CONSOLE_REASON, dryRun: false, dryRunReason: CONSOLE_REASON }),
  exec: position({ json: false, jsonReason: CONSOLE_REASON, dryRun: false, dryRunReason: CONSOLE_REASON }),
  host: position({ json: false, jsonReason: CONSOLE_REASON, dryRun: false, dryRunReason: CONSOLE_REASON }),
  "cli-start": position({ json: false, jsonReason: "idempotent start of a helper container, no facts to structure", dryRun: false, dryRunReason: NOTHING_TO_PREVIEW }),
  "cli-stop": position({ json: false, jsonReason: "idempotent stop of a helper container, no facts to structure", dryRun: false, dryRunReason: NOTHING_TO_PREVIEW }),
  "configure-provider": position({ json: true, dryRun: false, dryRunReason: "not asked for by U9; every write is a single idempotent config set with its own already-configured skip" }),
  files: position({ json: true, dryRun: true }),
  secrets: position({ json: true, dryRun: false, dryRunReason: "not asked for by U9; --apply/--init-store/--dump already require MCP confirm, and status/template need no preview" }),
  "recover-env": position({ json: true, dryRun: true }),
  recipe: position({ json: true, dryRun: true }),
  memory: position({ json: true, dryRun: false, dryRunReason: "plan is the read-only preview of configure; setup/index/verify are consented, locked effects with no in-between preview" }),
  "provision-agent": position({ json: true, dryRun: false, dryRunReason: "not asked for by U9; every step is idempotent (re-runnable, rewrites declared state)" }),
  deploy: position({ json: true, dryRun: true }),
  "mcp-serve": position({ json: false, jsonReason: CONSOLE_REASON, dryRun: false, dryRunReason: CONSOLE_REASON }),
  "mcp-setup": position({ json: true, dryRun: false, dryRunReason: "not asked for by U9; an idempotent merge into local client config files" }),
  expose: position({ json: true, dryRun: false, dryRunReason: "ssh/tailscale already print the exact command instead of running it; --apply is the only mutating path and already needs confirm" }),
  watch: position({ json: true, dryRun: false, dryRunReason: "install/uninstall already preview by default; --apply is the only mutating path" }),
  incident: position({ json: true, dryRun: true }),
  "mcp-creds": position({ json: true, dryRun: false, dryRunReason: "prints a credential, already read-only" }),

  // --- orchestration ---
  inspect: position({ json: true, dryRun: false, dryRunReason: "already read-only" }),
  doctor: position({ json: true, dryRun: false, dryRunReason: "already read-only" }),
  plan: position({ json: true, dryRun: false, dryRunReason: "plan IS the dry run of apply" }),
  apply: position({ json: true, dryRun: true }),
  accept: position({ json: true, dryRun: false, dryRunReason: "runs only read checks against a live instance — nothing to preview" }),
  rollback: position({ json: true, dryRun: true }),
  operations: position({ json: true, dryRun: false, dryRunReason: "already a read-only report" }),
  "apply-config": position({ json: true, dryRun: true }),

  // --- sets ---
  set: position({ json: true, dryRun: false, dryRunReason: "not asked for by U9; validate/diff/receipts are already read-only and try/forget need a real throwaway instance a preview cannot fake" }),
};

const liveCommands = Object.keys(openclawCommands).sort();
const tableCommands = Object.keys(TABLE).sort();

check("every openclawCommands entry has a table position", liveCommands.filter((name) => !(name in TABLE)), []);
check("every table position names a real command", tableCommands.filter((name) => !(name in openclawCommands)), []);

for (const name of liveCommands) {
  const position = TABLE[name];
  if (position === undefined) continue;
  const declared = openclawCommands[name].arguments ?? [];
  const hasJson = declared.some((argument) => argument.name === "json");
  const hasDryRun = declared.some((argument) => argument.name === "dry-run");
  check(`${name} --json matches its table position`, hasJson, position.json);
  check(`${name} --dry-run matches its table position`, hasDryRun, position.dryRun);
}

// --- the gate commands, cross-checked live -----------------------------------------------
//
// The full declared flag list per gate command, both gates (the union across them, since
// completion/version appear in each). A flag gained or lost without this table changing
// fails here.
interface GateCommandLike {
  readonly arguments?: readonly { readonly name: string }[];
}

const GATE_TABLE: Record<string, { readonly flags: readonly string[]; readonly json: boolean }> = {
  check: { flags: ["base", "filter", "list", "jobs", "related", "require", "timings", "top"], json: false },
  "new-app": { flags: ["name"], json: false },
  "remove-app": { flags: ["name", "yes"], json: false },
  list: { flags: ["json", "no-status"], json: true },
  init: { flags: ["local"], json: false },
  version: { flags: ["verbose", "json"], json: true },
  completion: { flags: ["shell"], json: false },
};

const gateCommands = new Map<string, GateCommandLike>();
for (const gate of [checkoutGate(), installedGate("<app-root>")]) {
  for (const command of gate) if (!gateCommands.has(command.name)) gateCommands.set(command.name, command);
}
check("the gate table names exactly the gate commands", [...gateCommands.keys()].sort(), Object.keys(GATE_TABLE).sort());
for (const [name, command] of gateCommands) {
  const declared = command.arguments ?? [];
  const row = GATE_TABLE[name] ?? { flags: [], json: false };
  check(`${name} flags match its gate-table row`, declared.map((argument) => argument.name).sort(), [...row.flags].sort());
  check(`${name} --json matches its gate-table row`, declared.some((argument) => argument.name === "json"), row.json);
  check(`${name} declares no --dry-run (a gate command has nothing to preview)`, declared.some((argument) => argument.name === "dry-run"), false);
}

// --- every declared --dry-run flag carries effect "read" (I4) ------------------------------
for (const [name, declaration] of Object.entries(openclawCommands)) {
  if (!(declaration.arguments ?? []).some((argument) => argument.name === "dry-run")) continue;
  const spec = specOf(declaration);
  const shape = spec === undefined ? undefined : specShape(spec);
  const declared = shape === undefined
    ? undefined
    : [...(shape.arguments ?? []), ...Object.values(shape.actions ?? {}).flatMap((action) => action.arguments ?? [])]
      .find((argument) => argument.name === "dry-run");
  check(`${name} --dry-run declares effect read`, declared !== undefined && declared.kind === "flag" ? declared.effect : undefined, "read");
}

finish("flags-matrix");
