// Orchestration command group: inspecting a deployment, planning what it implies, and
// running (or undoing) that plan. Split out of index.ts, which merges every group's
// fragment into one openclawCommands.

import type { AppCommand } from "#src/core/app.ts";
import { materializeCommands } from "#src/core/command/index.ts";

import { APPLY_CONFIG } from "#src/commands/orchestration/config.ts";
import { INSPECT, DOCTOR } from "#src/commands/orchestration/inspect/gather.ts";
import { PLAN } from "#src/commands/orchestration/plan.ts";
import { APPLY } from "#src/commands/orchestration/apply.ts";
import { OPERATIONS } from "#src/commands/orchestration/operations.ts";
import { ROLLBACK } from "#src/commands/orchestration/rollback.ts";
import { ACCEPT } from "#src/commands/orchestration/accept.ts";

export const orchestrationCommands: Record<string, AppCommand> = materializeCommands({
  inspect: {
    summary: "Declared versus running, with differences",
    group: "check",
    ...INSPECT,
    details:
      "One answer instead of the several commands whose results a coder otherwise has to " +
      "combine: gateway state and both health verdicts, the image and its digest, every " +
      "declared setting against its live value, which secrets are in place, and what each " +
      "recipe expects (its agent, MCP server, cron job and mirrored files) against what the " +
      "instance actually has.\n" +
      "Every finding carries a stable code — CONFIG_DRIFT, SECRET_MISSING, RESTART_REQUIRED " +
      "and the rest — so a caller can branch on it instead of reading prose, plus the exact " +
      "command that resolves it.\n" +
      "It also asks the running container, from inside it, whether the outbound endpoints its " +
      "live configuration names (model provider baseUrls, channel proxies) resolve and answer — " +
      "the vantage a probe from this machine lacks. Unreachable ones are reported as " +
      "EGRESS_UNREACHABLE, a warning: the instance is up and the outside world is not ours to " +
      "control.\n" +
      "The deployment folder itself is compared against the running instance too:\n" +
      ".env's four connection facts against the container's (ENV_STALE — naming the " +
      "variable, never a value; the file mixes a real secret with the plumbing),\n" +
      "the absence of config/desired-state.json while something is running " +
      "(DECLARATION_MISSING),\n" +
      "and the default local store missing a value the target still holds " +
      "(STORE_INCOMPLETE — watched only when the store file exists, since bootstrap puts " +
      "values on the target without creating one).\n" +
      "All three are warnings that name the command that repairs them: recover-env, " +
      "apply-config --dump, secrets --dump. The instance is fine; what is at risk is " +
      "reproducing it.\n" +
      "observed.connectionFacts and observed.secretStore carry the per-fact comparison " +
      "and the store's missing names; absent means not checked, never checked-and-fine.\n" +
      "Read-only: it starts, writes and registers nothing. `{clawwright plan}` turns its findings " +
      "into actions.\n" +
      "The live agent/MCP/cron lists come from OpenClaw's own CLI, a container per call — " +
      "`{clawwright cli-start}` first makes this noticeably faster.",
    structured: true,
  },
  doctor: {
    summary: "Report what is wrong and what to run",
    group: "check",
    ...DOCTOR,
    details:
      "The same inspection as `{clawwright inspect}`, read for its problems rather than its " +
      "inventory — one gatherer, so the two can never disagree.\n" +
      "Exits non-zero when a blocking problem was found, which is the part a CI step or an " +
      "agent can act on without reading the text.\n" +
      "Warnings do not fail it: an instance with no lock file still works, and an outbound " +
      "endpoint the container cannot reach this second — EGRESS_UNREACHABLE, asked of the " +
      "container itself — is the outside world's doing, not the instance's.\n" +
      "The deployment-folder findings — a stale .env fact, a missing desired-state.json, " +
      "an incomplete local store — are warnings for the same reason: the instance is doing " +
      "its job, and a folder that is merely behind must not fail a build.\n" +
      "A check that fails on everything it has an opinion about stops being consulted.\n" +
      "Also runs the security gate — `openclaw security audit` and `openclaw secrets audit` " +
      "inside the instance, plus what only the host side can see: the gateway published on " +
      "every interface (blocking unless acknowledged in config/security-suppressions.json), " +
      "a public port that Docker's DOCKER-USER chain may let bypass an active UFW, and the " +
      "deployment's own secret file permissions.\n" +
      "Never every {clawwright} inspect/plan call — each audit is a container exec — only " +
      "doctor and accept. Suppress a finding by upstream checkId in " +
      "config/security-suppressions.json; it stays visible but stops counting. OC_AUDIT_BLOCK " +
      "sets the OpenClaw audit threshold (critical by default, or warn); existing " +
      "config/security-suppressions.json exceptions continue to apply.",
    structured: true,
  },
  plan: {
    summary: "Actions the declaration implies, without running",
    group: "change",
    ...PLAN,
    details:
      "Turns what `{clawwright inspect}` found into steps, in the order the dependencies actually " +
      "require — a never-bootstrapped deployment first, secrets before anything starts, " +
      "configuration before the restart that reads it, the gateway up before provisioning " +
      "talks to it, recipes last.\n" +
      "That order is the framework's job. Before this command it lived in whoever had " +
      "learned it.\n" +
      "Each step says which finding put it there.\n" +
      "A few steps are advisory: reconnecting an MCP client is something only the client " +
      "can do, the lock file is never re-pinned automatically since doing that would " +
      "rubber-stamp whatever drifted,\n" +
      "and any other problem this framework has no specific step for yet still gets one — " +
      "named advisory rather than left out, so a problem plan cannot act on is still a " +
      "problem the reader sees, never one \"nothing to do\" quietly absorbs.\n" +
      "Recovery steps appear early too: a stale .env plans recover-env and a missing " +
      "desired-state.json plans apply-config --dump, both run " +
      "exactly as planned — the dump's --force refusal protects an existing declaration, and " +
      "this one is absent.\n" +
      "An incomplete local store plans {clawwright secrets --dump} as advisory instead: it " +
      "refuses to overwrite an existing store without --force, and whether the store's " +
      "contents matter is the reader's decision, not a step.\n" +
      "\"nothing to do\" prints only once inspect finds this deployment healthy with no " +
      "problems at all — never merely because plan has no step for what it found.\n" +
      "Changes nothing. `{clawwright apply}` runs exactly this list.",
    structured: true,
  },
  apply: {
    summary: "Apply the plan, then confirm the instance",
    group: "change",
    ...APPLY,
    details:
      "Runs exactly the steps `{clawwright plan}` lists, in that order, and stops at the first " +
      "failure — the steps depend on each other, so continuing would report success for an " +
      "instance nobody has. Every step lands in the operation journal as done, failed, " +
      "advisory (never this command's job) or blocked (an earlier step already failed) — " +
      "the words `{clawwright operations}` reads back, nothing left out.\n" +
      "Then it inspects again and reports what it found. \"Applied\" and \"working\" are " +
      "different claims and this command makes the stronger one: every step can succeed and " +
      "the instance still be broken for a reason no step was looking at.\n" +
      "{--expect} <checksum> refuses to run if the declaration changed since that plan was " +
      "computed (the plan's declarationChecksum). Checked before the first step, because " +
      "the whole value of the refusal is that it happens first.\n" +
      "Advisory steps are never performed: reconnecting an MCP client is the client's to do, " +
      "re-pinning the lock file is a decision, not a repair, and so is the store recovery a " +
      "plan lists when the local secret store is incomplete — {clawwright secrets --dump} " +
      "would overwrite it only with --force, so apply reports the step as advisory and " +
      "leaves the decision where it belongs.\n" +
      "The operator-side recovery steps that are executable — recover-env, apply-config " +
      "--dump — run under the same rules as every step: one operation id, a journal entry " +
      "each, stop at the first failure; they write to the deployment folder rather than the " +
      "instance, so their runners take no instance lock of their own.\n" +
      "{--dry-run} only lists what the plan computed — it touches nothing, so it cannot tell " +
      "you whether desired-state.json would actually validate against the target's own " +
      "schema. `{clawwright apply-config --dry-run}` does: a real (lockless) " +
      "`config patch --file <path> --dry-run` against the target, usable even before the instance is healthy.",
    structured: true,
  },
  accept: {
    summary: "Run this deployment's acceptance checks",
    group: "check",
    ...ACCEPT,
    structured: true,
    details:
      "`{clawwright smoke}` proves the instance is healthy. It cannot say whether the wiki a recipe " +
      "serves is reachable, whether the agent built from that recipe has the tools it was " +
      "given, or whether its cron job matches what the recipe declares — those are " +
      "properties of this deployment, not of the framework.\n" +
      "So a recipe declares them in recipes/<name>/acceptance.json and this runs them. The " +
      "check kinds are the framework's (mcp_responds, mcp_tool, agent_has_tools, " +
      "cron_matches, agent_answers); no code travels from a deployment into the framework.\n" +
      "Checks marked usesModel are never run without {--with-model}: they cost tokens and take " +
      "an agent turn, which writes to that agent's own workspace. They are always reported " +
      "as \"not-checked\" and counted — a suite that silently drops what it did not run reads as " +
      "coverage it does not have.\n" +
      "A check that was attempted but got no verdict — the server would not start, the " +
      "instance refused the call — is reported as \"could-not-check\" with the reason, never " +
      "as passed.\n" +
      "Also runs the security gate — see `{clawwright doctor}`'s own description — and fails on a " +
      "blocking finding the same way a failed check does. OC_AUDIT_BLOCK is critical by default " +
      "or warn; existing config/security-suppressions.json exceptions continue to apply.\n" +
      "Exits non-zero when a check fails, could not be checked, or the security gate finds a " +
      "blocking issue.",
  },
  rollback: {
    summary: "Restore the configuration an operation replaced",
    group: "change",
    ...ROLLBACK,
    structured: true,
    details:
      "`{clawwright apply}` copies the live configuration aside before its first mutating step. " +
      "This puts that copy back and restarts, because a configuration the instance has not " +
      "read is not in force.\n" +
      "Not the same operation as `{clawwright push}`, and the difference matters at exactly the " +
      "wrong moment: push replaces the whole data directory from a snapshot — every " +
      "workspace, every agent's memory, every transcript written since. This replaces one " +
      "file. Undoing a bad configuration should not cost an agent its notes.\n" +
      "Without {--operation} it undoes the most recent run that took a snapshot. A run that " +
      "changed nothing took none and is not offered.\n" +
      "The rollback is itself recorded as an operation.\n" +
      "{--previous-set} is a different path entirely: reinstalls the set that was installed " +
      "here before the one currently in force — prompts, MCP registrations, schedules and " +
      "gateway settings together, through {clawwright apply --set}, not this command's own " +
      "single-file restore.\n" +
      "Refuses if no previous set is on record, or if its artifact is no longer in sets/.\n" +
      "Neither path replaces the other: a deployment never installed from a set still has " +
      "only the config-snapshot path above.",
  },
  operations: {
    summary: "What mutating runs did and left behind",
    group: "check",
    ...OPERATIONS,
    structured: true,
    details:
      "Every run that changes the instance writes a journal entry on the target as it goes " +
      "— step by step, not at the end, because a run that dies halfway is exactly the case " +
      "the record exists for.\n" +
      "Without an id this lists the most recent ones; with one it shows that run in full: " +
      "which steps ran, which failed, which never started, and whether a configuration " +
      "snapshot was taken that `{clawwright rollback}` can put back.\n" +
      "An operation with no outcome did not reach its own end — killed, disconnected or " +
      "still running. That is reported as unfinished rather than dressed up as a result.",
  },
  "apply-config": {
    summary: "Apply the deployment's desired-state.json",
    group: "change",
    ...APPLY_CONFIG,
    details:
      "The declaration in config/desired-state.json is an ordered list of {path,value} " +
      "declarations. Paths support dot properties, numeric indexes, quoted bracket keys, " +
      "and selector segments for array objects. Field names match " +
      "[A-Za-z_$][A-Za-z0-9_$-]*. Bare selector values are nonempty, contain no whitespace, " +
      "dot, brackets, equals, quotes or backslash (surrounding spaces are trimmed); " +
      "JSON double-quoted values may be any string, including empty. Middle selectors " +
      "create when missing and refuse multiple matches. Terminal single-object selectors " +
      "append when there are no matches and replace the matching object at its existing index " +
      "when exactly one matches; multiple matches refuse. Terminal array selectors remove all " +
      "matches and append each declared object with selector fields forced. OpenClaw validates " +
      "the resulting config against its own schema; the framework does not hardcode one.\n" +
      "Apply calculates a live-config JSON Merge Patch and passes it to OpenClaw's " +
      "`config patch --file`; JSON Merge Patch null deletes a value, so a new null value " +
      "cannot be represented. Unchanged SecretRefs are preserved. Removed paths are pruned " +
      "before new declarations using the target dataDir ownership record " +
      "clawwright-declared.json; the record is updated atomically only after successful " +
      "real apply. Dry-run does not write it; a corrupt existing record refuses real apply " +
      "but is treated as empty for dry-run. Numeric-index pruning refuses; remove those " +
      "paths manually. The recipe overlap guard conservatively checks the first selector " +
      "with the list prefix before the first selector; any ancestor/descendant overlap refuses.\n" +
      "bootstrap calls this itself, so a fresh deployment and an existing one end up with " +
      "the same settings.\n" +
      "{--dump} is the reverse: reconstructs a lost desired-state.json from the live instance's " +
      "own openclaw.json. Recovery is honestly limited — the live config shows the outcome of " +
      "the declaration, not the declaration itself —\n" +
      "so only a fixed set of commonly declared paths is recovered (a value OpenClaw " +
      "defaults to cannot be told apart from a declared one), paths the live config never " +
      "set are omitted rather than guessed, and recipes are not part of this file at all.\n" +
      "Refuses to overwrite an existing declaration unless {--force} is given.\n" +
      "The flags are validated against the mode before anything is read or written: " +
      "{--dry-run} cannot be combined with {--dump} — a dump has no dry-run form, it either " +
      "writes the recovered declaration or does nothing — {--break-lock} and {--break-foreign-lock} " +
      "apply only where an instance lock is taken (the real apply), and {--force} only applies to {--dump}.\n" +
      "Kept separate from `apply`: its {--dry-run} really validates against the target (lockless, " +
      "even before the instance is healthy), and {--dump} {--force} deliberately overwrites an " +
      "existing declaration — `apply` does neither.",
  },
});
