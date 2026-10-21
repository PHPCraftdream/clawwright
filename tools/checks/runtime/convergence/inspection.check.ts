// The vocabulary the lifecycle commands share.
//
// Little logic to test here and that is the point: what needs guarding is that the codes
// stay a usable contract. Every code carries a severity and a runnable remedy, a caller
// cannot quietly downgrade a blocking situation, and "healthy" keeps meaning what a reader
// expects — working, not merely silent.

import { command } from "#framework/core/io/invocation/advice.ts";
import { renderAdvice } from "#framework/core/io/invocation/render.ts";
import {
  PROBLEM_CODES,
  problem,
  blockingProblems,
  isHealthy,
  nextActions,
  nextAdvice,
} from "#framework/service/inspection.ts";
import type { Inspection, ProblemCode } from "#framework/service/inspection.ts";
import { check, finish } from "#checks/kit/harness.ts";

// --- the table is the contract ---------------------------------------------------------

const codes = Object.keys(PROBLEM_CODES) as ProblemCode[];

check("there are codes at all", codes.length > 0, true);

for (const code of codes) {
  const meaning = PROBLEM_CODES[code];
  check(`${code} has a severity that exists`, meaning.severity === "blocking" || meaning.severity === "warning", true);
  check(`${code} says what it means`, meaning.summary.trim() !== "", true);
  // A remedy that is a description rather than a command leaves the reader exactly where
  // they were. The two exceptions: the MCP reconnect, which nothing on this side can do,
  // and an unreachable target, whose fix is outside clawwright entirely (WSL/ssh config).
  check(
    `${code} names something the reader can act on`,
    code === "MCP_RESTART_REQUIRED" || code === "TARGET_UNREACHABLE"
      ? meaning.next.kind === "manual"
      : meaning.next.kind === "clawwright" && meaning.next.argv.length > 0,
    true,
  );
}

// Codes are matched on by other tools, so a rename is a breaking change. Naming them here
// makes that visible in a diff instead of silent.
check(
  "the code names are the ones callers branch on",
  codes.sort(),
  [
    "AGENT_MISSING",
    // Upkeep findings: whether this deployment could be recovered, not whether it serves.
    "BACKUP_MISSING",
    "BACKUP_STALE",
    "BACKUP_UNREADABLE",
    // Emitted only beside a channel finding it explains: the recipe owning the channel's
    // proxy config path, when that recipe's proxy service is not healthy.
    "CHANNEL_PROXY_DOWN",
    "CHANNEL_UNHEALTHY",
    "CHANNEL_UNKNOWN",
    "CLI_READ_FAILED",
    "CONFIG_DRIFT",
    "CRON_DRIFT",
    "DECLARATION_MISSING",
    // watch has its own, differently-scoped DISK_LOW (health.ts) — this one is inspection.ts's.
    "DISK_LOW",
    "EGRESS_UNREACHABLE",
    // A pure fact about .env itself, no instance needed — sits with the declared-state codes.
    "ENV_LINE_INVALID",
    // Operator-side findings: the deployment folder against the instance.
    "ENV_STALE",
    "GATEWAY_DOWN",
    // Host-side: what only the operator's own view of Docker/the target can see, not OpenClaw.
    "GATEWAY_EXPOSURE_ACKNOWLEDGED",
    "GATEWAY_PUBLICLY_BOUND",
    "GATEWAY_UNHEALTHY",
    // A tag that could move (IMAGE_UNPINNED) and one that already has (IMAGE_TAG_MOVED) —
    // separate, present-vs-future facts about the same OPENCLAW_IMAGE.
    "IMAGE_TAG_MOVED",
    "IMAGE_UNPINNED",
    "LOCK_DRIFT",
    "LOCK_MISSING",
    "MCP_RESTART_REQUIRED",
    "MCP_SERVER_MISSING",
    "MEMORY_NOT_READY",
    "MEMORY_UNKNOWN",
    // Reported instead of ever asking the runtime, on a deployment nobody has bootstrapped.
    "NOT_BOOTSTRAPPED",
    // Third-party plugins/skills against config/deployment.lock.json — commands/management/extensions.ts.
    "PLUGIN_DRIFT",
    "PRIVATE_FILE_INSECURE",
    "PRIVATE_FILE_UNREADABLE",
    // The gateway runs, but nothing can answer a prompt without one.
    "PROVIDER_MISSING",
    "RECIPE_MIRROR_DRIFT",
    "RESTART_REQUIRED",
    "SECRET_MISSING",
    // The security gate (doctor/accept only): OpenClaw's own audits, normalized to two codes.
    "SECURITY_AUDIT_CRITICAL",
    "SECURITY_AUDIT_WARN",
    // Set-level findings: separate mistakes with separate fixes, so separate codes.
    "SET_DECLARATION_INVALID",
    "SET_IMAGE_INVALID",
    "SET_IMAGE_UNPINNED",
    "SET_OBJECT_ORPHANED",
    "SET_RECIPE_INCOMPLETE",
    "SET_RECIPE_INVALID",
    "SET_REFERENCE_BROKEN",
    "SET_REQUIREMENT_UNMET",
    "SET_SCHEDULE_INVALID",
    "SET_SECRET_UNDECLARED",
    "SKILL_DRIFT",
    "STORE_INCOMPLETE",
    // The target IS reached and answers, but its own userland lacks a GNU tool this framework's
    // target-side commands need — checked only by bootstrap --check, never gatherInspection.
    "TARGET_NOT_GNU",
    // wsl.exe/ssh itself failing to reach the target — never a command that ran there.
    "TARGET_UNREACHABLE",
    "UFW_DOCKER_BYPASS",
  ],
);

// --- problem() takes severity and remedy from the table, not from the caller ------------

{
  const unknown = problem("CHANNEL_UNKNOWN", "requested channel telemetry was not confirmed");
  check("unknown channel telemetry is advisory, never proven down", unknown.severity, "warning");
  check("channel telemetry has a CLI diagnostic remedy", unknown.nextAction, "./clawwright cli channels status --json");
}

for (const code of ["CHANNEL_UNHEALTHY", "MEMORY_UNKNOWN", "MEMORY_NOT_READY"] as const) {
  const finding = problem(code, "fixture diagnostic fact");
  check(`${code} remains advisory`, finding.severity, "warning");
  check(`${code} supplies structured diagnostic command advice`, finding.next.kind, "clawwright");
  check(`${code} requests only normal status, never repair or deep probing`, finding.next.kind === "clawwright" ? finding.next.argv : undefined, ["cli", code === "CHANNEL_UNHEALTHY" ? "channels" : "memory", "status", "--json"]);
}

{
  const drift = problem("CONFIG_DRIFT", "gateway.mode is \"local\", declared \"remote\"");
  check("severity comes from the code", drift.severity, "blocking");
  check("the remedy comes from the code", drift.nextAction, "./clawwright apply");
  check("the detail is the caller's, verbatim", drift.detail, "gateway.mode is \"local\", declared \"remote\"");
}

{
  // A more specific remedy is allowed — one named recipe rather than the whole declaration.
  const specific = problem("CRON_DRIFT", "example-refresh runs at 0 4 * * *, declared 17 3 * * *", command(["provision-agent", "example-recipe"]));
  check("a call site may narrow the remedy", specific.nextAction, "./clawwright provision-agent example-recipe");
  check("but not the severity", specific.severity, PROBLEM_CODES.CRON_DRIFT.severity);
}

// --- reading a set of problems ----------------------------------------------------------

const problems = [
  problem("CONFIG_DRIFT", "one setting differs"),
  problem("LOCK_MISSING", "no config/deployment.lock.json"),
  problem("SECRET_MISSING", "ZAI_API_KEY is not set in <data>/config/.env"),
  // A second finding with a remedy already named above: nextAdvice must deduplicate
  // under the same key (the rendered nextAction) as nextActions, or the two lists drift.
  problem("LOCK_MISSING", "still no config/deployment.lock.json next to the deployment"),
];

check("blocking problems are separated from warnings", blockingProblems(problems).map((entry) => entry.code), ["CONFIG_DRIFT", "SECRET_MISSING"]);
check("next actions are deduplicated and ordered as found", nextActions(problems), ["./clawwright apply", "./clawwright lock", "./clawwright secrets --apply"]);
check(
  "next advice is index-aligned with next actions",
  nextAdvice(problems).map((advice) => renderAdvice(advice)),
  nextActions(problems),
);

// --- healthy means working, not silent ---------------------------------------------------

function inspectionWith(overrides: {
  running?: boolean;
  health?: string;
  problems?: Inspection["problems"];
}): Inspection {
  return {
    declared: { deployment: "example", config: [], image: "example/image:tag", recipes: [] },
    observed: {
      running: overrides.running ?? true,
      health: overrides.health ?? "healthy",
      probes: { healthz: 200 },
      config: {},
      secrets: [],
      agents: [],
      mcpServers: [],
      cronJobs: [],
      foreignObjects: [],
    },
    problems: overrides.problems ?? [],
  };
}

check("a running, healthy instance with nothing found is healthy", isHealthy(inspectionWith({})), true);
check("a warning does not make a working instance unhealthy", isHealthy(inspectionWith({ problems: [problem("LOCK_MISSING", "none")] })), true);
check("a blocking problem does", isHealthy(inspectionWith({ problems: [problem("CONFIG_DRIFT", "differs")] })), false);
check("nor is a stopped instance healthy, whatever else was found", isHealthy(inspectionWith({ running: false, health: undefined })), false);
// The case that motivated checking both: a container the runtime calls unhealthy while the
// HTTP probes answer. The runtime has decided, so it overrules them.
check("nor one the runtime calls unhealthy, even while it answers", isHealthy(inspectionWith({ health: "unhealthy" })), false);

// "starting" is not a verdict, it is the grace period every container passes through on the
// way up — and an instance inspected right after a restart is always in it. Reported as a
// fault it is a false alarm on a working instance, and a report that cries wolf stops being
// read. This was found by running ./clawwright apply against the live deployment, not by reasoning.
check("a container still starting but answering every probe is serving", isHealthy(inspectionWith({ health: "starting" })), true);
check(
  "one still starting and not answering is not",
  isHealthy({
    ...inspectionWith({ health: "starting" }),
    observed: { ...inspectionWith({ health: "starting" }).observed, probes: { healthz: 503 } },
  }),
  false,
);

finish("inspection model");
