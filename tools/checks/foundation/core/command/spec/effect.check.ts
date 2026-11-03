// State effects for representative public argv and model precedence boundaries.

import { openclawCommands } from "#framework/commands/interface/index.ts";
import { ArgumentError, callFacts, callFactsFor, shapeProfile, type EffectShape } from "#framework/core/command/index.ts";
import { check, checkTrue, finish } from "#checks/kit/harness.ts";

type Row = readonly [argv: readonly string[], effect: "read" | "change" | "destroy", changed?: boolean];

const TABLE: Readonly<Record<string, readonly Row[]>> = {
  memory: [
    [["plan", "--mode", "keyword", "--backend", "builtin"], "read", false],
    [["status"], "read", false],
    [["configure", "--mode", "keyword", "--backend", "builtin"], "destroy", true],
    [["index", "--agent", "main"], "destroy", true],
    [["verify", "--agent", "main"], "destroy", true],
    [["setup", "--model-source", "https://huggingface.co/approved/model/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/model.gguf", "--model-version", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "--model-checksum", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "--plugin-version", "2026.6.34", "--model-max-bytes", "1024", "--allow-install", "--allow-download", "--agent", "main"], "destroy", true],
    [["status", "--deep", "--allow-spend", "--allow-download"], "destroy", true],
  ],
  bootstrap: [[[], "change"], [["--check"], "read"], [["--no-pull"], "change"]],
  up: [[[], "change"], [["--break-lock"], "change"]],
  restart: [[[], "change"]],
  down: [[[], "change"]],
  // --yes carries --confirm-name: the declared rule refuses the pair-less argv at parse.
  destroy: [[[], "read", false], [["--data"], "read", false], [["--yes", "--confirm-name", "sample"], "destroy", true], [["--data", "--yes", "--confirm-name", "sample"], "destroy", true]],
  logs: [[[], "read"], [["--tail", "5"], "read"]],
  backup: [
    [[], "change", true], [["--dry-run"], "read", false], [["--hot"], "change", true], [["create"], "change", true], [["create", "--dry-run"], "read", false],
    [["list"], "read", false], [["prune-replaced"], "read", false], [["prune-replaced", "--apply"], "destroy", true],
    [["install"], "read", false], [["install", "--apply"], "destroy", true],
    [["uninstall"], "read", false], [["uninstall", "--apply"], "destroy", true],
  ],
  restore: [[[], "destroy"], [["a.tar"], "destroy"], [["--dry-run"], "read"], [["a.tar", "--dry-run"], "read"]],
  pull: [[[], "change"]],
  push: [[[], "destroy"], [["--dry-run"], "read"]],
  verify: [[[], "read"], [["a.tar"], "read"]],
  upgrade: [[[], "destroy"], [["--dry-run"], "read"]],
  smoke: [[[], "change"]],
  inspect: [[[], "read"]],
  doctor: [[[], "read"]],
  plan: [[[], "read"]],
  apply: [[[], "destroy"], [["--dry-run"], "read"]],
  accept: [[[], "change"]],
  rollback: [[[], "destroy"], [["--dry-run"], "read"]],
  operations: [[[], "read"], [["--takeover-lock", "--break-lock"], "destroy"]],
  "apply-config": [[[], "change"], [["--dry-run"], "read"], [["--dump"], "change"], [["--dump", "--force"], "destroy"]],
  expose: [
    [["ssh"], "read", false], [["status"], "read", false], [["tailscale"], "read", false], [["tailscale", "--apply"], "destroy", true],
  ],
  watch: [
    [["check"], "read", false], [["status"], "read", false], [["test"], "read", false],
    [["install"], "read", false], [["install", "--apply"], "destroy", true],
    [["uninstall"], "read", false], [["uninstall", "--apply"], "destroy", true],
  ],
  incident: [[[], "destroy"], [["--dry-run"], "read"]],
  "recover-env": [[[], "change"], [["--dry-run"], "read"]],
  status: [[[], "read"]],
  lock: [[[], "change"], [["--check"], "read"]],
  cli: [[[], "destroy"], [["agent", "list"], "destroy"]],
  exec: [[[], "destroy"], [["ls"], "destroy"]],
  host: [[[], "destroy"], [["target", "ls"], "destroy"]],
  "cli-start": [[[], "change"]],
  "cli-stop": [[[], "change"]],
  "configure-provider": [[[], "change"]],
  files: [[[], "read", false], [["--dry-run"], "read", false], [["--apply"], "destroy", true]],
  secrets: [
    [[], "read", false], [["--print-template"], "read", false], [["--template"], "change", true],
    [["--init-store"], "destroy", true],
    [["--apply"], "destroy", true], [["--dump"], "destroy", true],
    [["--template", "--print-template"], "read", false], [["--print-template", "--apply"], "read", false],
    [["--print-template", "--dump"], "read", false], [["--print-template", "--init-store"], "read", false],
  ],
  recipe: [
    [[], "read"], [["list"], "read"], [["status", "x"], "read"], [["logs", "x"], "read"],
    [["install", "x"], "destroy"], [["install", "x", "--dry-run"], "read"], [["remove", "x"], "destroy"], [["remove", "x", "--dry-run"], "read"],
    // Q1 (S2.6a): import/new only add files — `change`, like `needs: "local"`.
    [["import", "x"], "change"], [["new", "x"], "change"], [["verify", "x"], "destroy"], [["verify", "x", "--dry-run"], "destroy"],
    [["onboard", "x"], "destroy"], [["diagnose", "x"], "destroy"],
    [["inspect", "x"], "read"],
    [["recover", "x", "--service", "api"], "destroy"], [["recover", "x", "--service", "api", "--dry-run"], "read"],
    [["migrate", "x"], "destroy"], [["migrate", "x", "--dry-run"], "read"],
    // the operand is declared required per action: a bare action word is refused at parse
    [["status"], "read"], [["logs"], "read"], [["install"], "destroy"], [["remove"], "destroy"], [["import"], "destroy"],
    [["new"], "destroy"], [["verify"], "destroy"], [["onboard"], "destroy"], [["diagnose"], "destroy"],
  ],
  "provision-agent": [[[], "change"], [["x"], "change"]],
  deploy: [[[], "destroy"], [["host"], "destroy"], [["host", "--dry-run"], "read"]],
  "deploy-text": [[ ["--file", "/approved/config", "--template", "template.txt", "--profile", "approved"], "change"]],
  "backup-text": [[ ["--file", "/approved/config", "--output", "copy.txt", "--profile", "approved"], "change"]],
  "mcp-serve": [[[], "change"]],
  "mcp-setup": [[[], "change"]],
  "mcp-creds": [[[], "read"], [["--token"], "read"]],
  set: [
    [["validate"], "read", false], [["receipts"], "read", false],
    [["build"], "change", true], [["try", "--set", "x"], "destroy", true], [["forget"], "destroy", true], [[], "change", false],
  ],
};

check("the table covers exactly the framework commands", Object.keys(TABLE).sort(), Object.keys(openclawCommands).sort());

// The argv the spec parser now refuses by design — a bare variadic/positional command, a
// flag another action owns — named EXPLICITLY, so a regression that makes any other row's
// call refuse fails loudly instead of passing as "refused". Every command keeps a
// positive row above.
const REFUSED: readonly (readonly [name: string, argv: readonly string[]])[] = [
  ["cli", []],
  ["exec", []],
  ["host", []],
  ["deploy", []],
  ["verify", []],
  ["provision-agent", []],
  ["recipe", ["verify", "x", "--dry-run"]],
  ...["status", "logs", "install", "remove", "import", "new", "verify", "onboard", "diagnose"].map((action): readonly [string, readonly string[]] => ["recipe", [action]]),
  // a read flag beside a flag of another effect is a refusal, never a lowered effect
  ["secrets", ["--template", "--print-template"]],
  ["secrets", ["--print-template", "--apply"]],
  ["secrets", ["--print-template", "--dump"]],
  ["secrets", ["--print-template", "--init-store"]],
  ["set", []],
  ["set", ["diff"]],
  ["set", ["forget"]],
];
const refusedKey = (name: string, argv: readonly string[]): string => `${name} ${argv.join(" ")}`;
const REFUSED_KEYS = new Set(REFUSED.map(([name, argv]) => refusedKey(name, argv)));

for (const [name, rows] of Object.entries(TABLE)) {
  for (const [argv, effect, changed] of rows) {
    const label = `${name} ${argv.join(" ")}`.trim();
    if (REFUSED_KEYS.has(refusedKey(name, argv))) {
      let error: unknown;
      try {
        callFactsFor(openclawCommands[name], argv);
      } catch (caught) {
        error = caught;
      }
      checkTrue(`${label}: refused as an argument error before any effect`, error instanceof ArgumentError);
      continue;
    }
    const facts = callFactsFor(openclawCommands[name], argv);
    check(`${label}: effect`, facts.effect, effect);
    // For a spec command `changed` is the model's, not a predicate's: read → false,
    // otherwise true — the same rule the MCP envelope applies. A legacy command reports
    // its own changedWhen, which is what the row pinned.
    check(`${label}: changed`, changed === undefined ? facts.changed : facts.changed ?? (facts.effect === "read" ? false : true), changed);
  }
}

// --- the model's own rules, on synthetic specs ---------------------------------------------------

const SHAPE: EffectShape = {
  effect: "change",
  actions: {
    list: { effect: "read", arguments: [] },
    install: { effect: "read", arguments: [{ name: "apply", kind: "flag", description: "x", effect: "destroy" }] },
    create: {
      arguments: [
        { name: "dry-run", kind: "flag", description: "x", effect: "read" },
        { name: "wipe", kind: "flag", description: "x", effect: "destroy" },
        { name: "plain", kind: "flag", description: "x" },
      ],
    },
  },
};
check("an action's own effect is its base", callFacts(SHAPE, { action: "list", given: [] }).effect, "read");
check("an action without one takes the body's", callFacts(SHAPE, { action: "create", given: [] }).effect, "change");
check("a flag raises the base", callFacts(SHAPE, { action: "install", given: ["apply"] }).effect, "destroy");
check("a flag without an effect leaves it", callFacts(SHAPE, { action: "create", given: ["plain"] }).effect, "change");
check("a read flag wins over a destroy flag", callFacts(SHAPE, { action: "create", given: ["wipe", "dry-run"] }).effect, "read");
check("the strongest given flag wins", callFacts(SHAPE, { action: "create", given: ["plain", "wipe"] }).effect, "destroy");
check("a flag of another action does not count", callFacts(SHAPE, { action: "list", given: ["apply"] }).effect, "read");
check("a single body is its own base", callFacts({ effect: "destroy", arguments: [{ name: "dry-run", kind: "flag", description: "x", effect: "read" }] }, { given: ["dry-run"] }).effect, "read");
check("spec profile: destructive through a flag, by action", shapeProfile(SHAPE), { destructive: true, alwaysDestroys: false, byAction: true });
check("spec profile: every base destroy, no read flag", shapeProfile({ effect: "destroy", arguments: [] }), { destructive: true, alwaysDestroys: true, byAction: false });
check("spec profile: a read flag lifts alwaysDestroys", shapeProfile({ effect: "destroy", arguments: [{ name: "dry-run", kind: "flag", description: "x", effect: "read" }] }).alwaysDestroys, false);
check("spec profile: reads only", shapeProfile({ effect: "read", arguments: [] }), { destructive: false, alwaysDestroys: false, byAction: false });

finish("effect parity");
