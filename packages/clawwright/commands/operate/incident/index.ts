// `clawwright incident` — contain, preserve, rotate, audit, collect: the incident runbook.
//
// contain turns off only tailscale serve route(s) proxying to THIS gateway (never `serve
// reset`, which drops other services' routes). A publicly-exposed gateway refuses the run
// first, before the lock, unless --keep-exposure. Contain failures are noted, not thrown.
//
// rotate recreates the container after writing a new token — env vars are fixed at creation
// time, a restart alone would not apply it. Paired clients need `mcp-creds` after.
// collect masks and archives logs, both audit outputs and a status summary unconditionally,
// even on failure, into apps/<name>/incidents/<ts>/ (private, gitignored).
//
// Mutating: the body's effect holds the instance lock; --dry-run performs nothing, not even that.

import { resolve } from "node:path";
import { log, info, warn, die, registerSecret, maskSecrets } from "../../../core/io/log.ts";
import { commandLine, renderArguments } from "../../../core/io/invocation/render.ts";
import { emit, isCaptured } from "../../../core/io/output.ts";
import type { Context } from "../../../core/context.ts";
import { commandBody, runOnContext, type ArgumentSpec, type Values } from "../../../core/command/index.ts";
import { guardedWith } from "../../../runtime/lock/instance-lock.ts";
import { generateGatewayToken } from "../../../integration/provision.ts";
import { envFile, deploymentDir, deploymentName } from "../../../runtime/deployment.ts";
import { upsertEnvValue } from "../../../security/privacy/private-config.ts";
import { readEnvValue, readEnvFileText } from "../../../core/env.ts";
import { replacePrivateFile, createPrivateFile, protectPrivateDirectory } from "../../../security/privacy/private-file.ts";
import { probeTailscale, tailscaleGatewayRoutes, tailscaleServeOffCommand } from "../expose/tailscale.ts";
import { summarizeExposure, exposureOneLiner } from "../expose/status.ts";
import { safeConnectionFacts, requireBootstrapped } from "../../../runtime/runtime.ts";
import { runSecurityAudit, type SecurityAuditReport } from "../../../security/audit.ts";
import { blockingProblems } from "../../../service/inspection.ts";
import { BREAK_LOCK_ARGUMENT, BREAK_FOREIGN_LOCK_ARGUMENT, takeoverOf } from "../../interface/groups/shared-arguments.ts";
import * as kinds from "../../../core/values/kinds.ts";

/** Drives both incident's own declaration and its wrapper below. `--dry-run` is the read
 *  form: its effect lowers the body's destroy to read, so a dry run asks no MCP confirmation
 *  and takes no lock. */

/** Fixed phrases of the incident report, exported so the checks assert the same text the
 *  product prints instead of restating it. */
export const PUBLIC_EXPOSURE_NOTE = "reachable from every interface";
export const NOTHING_TO_TURN_OFF = "nothing to turn off";
export const NO_GATEWAY_ROUTE = "no route to this gateway";
export const WOULD_RUN = "would run";
export const RAN = "ran";
export const NOTHING_TO_ROTATE = "nothing to rotate";
export const WOULD_ROTATE = "would rotate";
export const ROTATED_TOKEN = "rotated OPENCLAW_GATEWAY_TOKEN";
export const RECREATING_GATEWAY = "recreating the gateway";
export const UNCONFIRMED_TOKEN = "could not confirm";
export const WOULD_PRESERVE = "would preserve";
export const NO_PRE_ROTATE_EVIDENCE = "no pre-rotate evidence";
export const WOULD_COLLECT = "would collect";
const CONTAIN_FAILED = "contain failed unexpectedly";
export function auditFindingsSummary(findings: number, blocking: number): string {
  return `${findings} finding(s), ${blocking} blocking`;
}

export const INCIDENT_ARGUMENTS = [
  { name: "dry-run", description: "Plan only", kind: "flag", effect: "read" },
  { name: "keep-exposure", description: "Proceed with the gateway published on every interface", kind: "flag" },
  {
    name: "tail",
    summary: "Log lines to collect",
    description: "Log lines to collect (default 500)",
    kind: "option",
    valueName: "n",
    value: kinds.count("a number of lines", () => "needs a number of lines"),
  },
  { name: "json", description: "Report as JSON", kind: "flag" },
  BREAK_LOCK_ARGUMENT,
  BREAK_FOREIGN_LOCK_ARGUMENT,
] as const satisfies readonly ArgumentSpec[];

interface IncidentOptions {
  readonly dryRun: boolean;
  readonly keepExposure: boolean;
  readonly tail: string;
}

export interface IncidentPhase {
  readonly phase: "contain" | "preserve" | "rotate" | "audit" | "collect";
  readonly actions: readonly string[];
  readonly notes: readonly string[];
  readonly error?: string;
  readonly files?: readonly string[];
}

export interface IncidentReport {
  readonly deployment: string;
  readonly dryRun: boolean;
  readonly phases: readonly IncidentPhase[];
  /** Absent when audit itself threw before producing one — the report still reaches the
   *  operator, with the audit phase's own note naming why. */
  readonly security?: SecurityAuditReport;
  /** Where the evidence was written, absent in --dry-run. */
  readonly archive?: string;
}

/** Carries phase failures and the report after every remaining phase was attempted. */
export class IncidentPhaseFailure extends Error {
  readonly report: IncidentReport;
  constructor(report: IncidentReport, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "IncidentPhaseFailure";
    this.report = report;
  }
}

/** The bound values as the phases read them: --tail stays the string the runtime's log
 *  readers take, with the same default. */
function optionsOf(values: Values<typeof INCIDENT_ARGUMENTS>): IncidentOptions {
  return {
    dryRun: values["dry-run"] === true,
    keepExposure: values["keep-exposure"] === true,
    tail: values.tail === undefined ? "500" : String(values.tail),
  };
}

/** Refuses the whole run while the gateway may still be reachable from outside this host —
 *  checked before anything else, mutating or not: a plan printed for an instance still
 *  publicly bound would be worth nothing. `undefined` facts (not running, or this runtime
 *  cannot introspect it) has nothing to refuse on. */
export async function refuseIfPubliclyExposed(ctx: Context, options: IncidentOptions): Promise<void> {
  const facts = await safeConnectionFacts(ctx);
  if (facts === undefined) return;
  const summary = summarizeExposure(ctx, facts);
  if (!summary.wildcard) return;

  if (!options.keepExposure) {
    die(
      `the gateway is published on ${summary.bindAddress}:${summary.port} — ${PUBLIC_EXPOSURE_NOTE} on ` +
        "this host. Refusing to run an incident response while it may still be reachable from outside. To fix " +
        `it: set OC_BIND_ADDRESS=127.0.0.1 in ${envFile()}, then run ${commandLine("up")} to recreate the gateway on ` +
        "loopback. Or pass --keep-exposure if this exposure is already handled elsewhere (a reverse proxy, a " +
        "security group, ...).",
    );
  }
  warn(`proceeding with the gateway published on ${summary.bindAddress}:${summary.port} — --keep-exposure was given`);
}

/** Turns off only the tailscale serve route(s) that proxy to THIS gateway. Never throws: a
 *  contain failure (most commonly, this account is not the tailscale operator on the target)
 *  is reported as a note, because leaving a stale exposure noted is better than skipping
 *  rotate over it — rotate runs regardless of what happens here. */
export async function containExposure(ctx: Context, options: IncidentOptions): Promise<IncidentPhase> {
  const actions: string[] = [];
  const notes: string[] = [];

  const probe = await probeTailscale(ctx);
  if (!probe.present || !probe.loggedIn) {
    actions.push(`tailscale: ${probe.detail} — ${NOTHING_TO_TURN_OFF}`);
    return { phase: "contain", actions, notes };
  }

  const routes = await tailscaleGatewayRoutes(ctx, ctx.settings.gatewayPort);
  if (routes === undefined) {
    notes.push(
      "could not reliably parse `tailscale serve status --json` on the target — turned nothing off. If this " +
        "gateway is exposed through tailscale serve, turn it off yourself: `tailscale serve --https=443 off` " +
        "(match the port `tailscale serve status` shows; never `tailscale serve reset`, which also clears " +
        "routes that belong to other services).",
    );
    return { phase: "contain", actions, notes };
  }
  if (routes.length === 0) {
    actions.push(`tailscale serve has ${NO_GATEWAY_ROUTE} — ${NOTHING_TO_TURN_OFF}`);
    return { phase: "contain", actions, notes };
  }

  for (const route of routes) {
    const command = tailscaleServeOffCommand(route);
    const label = `${route.hostPort}${route.mountPoint}`;
    if (options.dryRun) {
      actions.push(`${WOULD_RUN}: ${renderArguments(command)} (turn off tailscale serve route ${label})`);
      continue;
    }
    const result = await ctx.transport.exec(command[0], command.slice(1), { allowFailure: true });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      const hint = /access denied|operator/i.test(detail)
        ? " — this account is likely not the tailscale operator on the target; run `sudo tailscale set " +
          "--operator=$USER` there, then re-run incident to finish containment"
        : "";
      notes.push(`could not turn off tailscale serve route ${label} (exit ${result.code}): ${detail}${hint}`);
      continue;
    }
    actions.push(`${RAN}: ${renderArguments(command)} (turned off route ${label})`);
  }

  return { phase: "contain", actions, notes };
}

export async function rotateToken(ctx: Context, options: IncidentOptions): Promise<IncidentPhase> {
  const actions: string[] = [];
  const notes: string[] = [];
  const path = envFile();
  const content = await readEnvFileText();
  const current = readEnvValue(content, "OPENCLAW_GATEWAY_TOKEN", path)?.trim();

  if (current === undefined || current === "") {
    actions.push(`no OPENCLAW_GATEWAY_TOKEN configured — ${NOTHING_TO_ROTATE}`);
    return { phase: "rotate", actions, notes };
  }

  if (options.dryRun) {
    actions.push(`${WOULD_ROTATE} OPENCLAW_GATEWAY_TOKEN and recreate the gateway to apply it`);
    return { phase: "rotate", actions, notes };
  }

  const token = generateGatewayToken();
  registerSecret(token);
  await replacePrivateFile(path, upsertEnvValue(content, "OPENCLAW_GATEWAY_TOKEN", token));
  actions.push(`${ROTATED_TOKEN} in ${path}`);

  if (!(await ctx.runtime.isRunning())) {
    notes.push(`the instance is stopped — the next ${commandLine("up")} will carry the new token`);
  } else if (typeof ctx.runtime.reconcile !== "function") {
    notes.push(`${ctx.runtime.description} cannot recreate the container — run ${commandLine("up")} to apply the new token`);
  } else {
    actions.push(`${RECREATING_GATEWAY} so the new token takes effect`);
    await ctx.runtime.reconcile();
    await ctx.runtime.waitForHealth();
    actions.push("gateway is healthy on the new token");

    if (typeof ctx.runtime.runningEnvironment === "function") {
      const running = await ctx.runtime.runningEnvironment();
      if (running?.OPENCLAW_GATEWAY_TOKEN === token) {
        actions.push("confirmed: the running container holds the new token — the old one no longer works");
      } else {
        notes.push(`${UNCONFIRMED_TOKEN} the running container holds the new token — check by hand before trusting the old one is gone`);
      }
    } else {
      notes.push(`${ctx.runtime.description} cannot read the running container's environment, so the new token is in force but unconfirmed here`);
    }
  }

  notes.push(`every MCP client paired against the old token needs new credentials: ${commandLine("mcp-creds")}`);
  return { phase: "rotate", actions, notes };
}

async function runDoctorLint(ctx: Context): Promise<{ raw: string; error?: string }> {
  try {
    const result = await ctx.runtime.runOneOff("cli", ["doctor", "--lint", "--json", "--non-interactive"], {
      profile: "cli", input: "", allowFailure: true,
    });
    return { raw: result.stdout };
  } catch (error) {
    return { raw: "", error: (error as Error).message };
  }
}

export async function runAudits(ctx: Context): Promise<{ phase: IncidentPhase; security: SecurityAuditReport; doctorLint: { raw: string; error?: string } }> {
  const security = await runSecurityAudit(ctx);
  const doctorLint = await runDoctorLint(ctx);
  const blocking = blockingProblems(security.problems).length;
  const actions = [
    `security gate: ${auditFindingsSummary(security.problems.length, blocking)}`,
    doctorLint.error === undefined ? "openclaw doctor --lint recorded" : `openclaw doctor --lint could not run: ${doctorLint.error}`,
  ];
  return { phase: { phase: "audit", actions, notes: [] }, security, doctorLint };
}

/** A short status summary, built from the runtime directly rather than the `status` command
 *  — this module stays a top-level one (like expose/), and top-level modules do not import
 *  from commands/. */
async function captureStatus(ctx: Context): Promise<string> {
  const lines: string[] = [`target: ${ctx.transport.description} / runtime: ${ctx.runtime.description}`];
  const facts = await safeConnectionFacts(ctx);
  lines.push(`exposure: ${exposureOneLiner(summarizeExposure(ctx, facts))}`);
  let running = false;
  try {
    running = await ctx.runtime.isRunning();
  } catch {
    running = false;
  }
  lines.push(`running: ${running}`);
  if (running) {
    lines.push(`health: ${await ctx.runtime.health().catch(() => "unknown")}`);
    for (const endpoint of ["healthz", "startupz", "readyz"]) {
      const code = await ctx.runtime.probe(endpoint).catch(() => 0);
      lines.push(`probe ${endpoint}: ${code}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The private, operator-side directory this run's evidence goes into — a sibling of
 *  secrets/, never inside the repository's tracked tree (apps/ is gitignored wholesale). */
function incidentDir(timestamp: string): string {
  return resolve(deploymentDir(), "incidents", timestamp);
}

interface IncidentEvidenceIO {
  readonly protectDirectory: typeof protectPrivateDirectory;
  readonly writeFile: typeof createPrivateFile;
}

const evidenceIO: IncidentEvidenceIO = { protectDirectory: protectPrivateDirectory, writeFile: createPrivateFile };

/** Preserves the old container before rotation; failures retain only confirmed files. */
export async function preserveEvidence(
  ctx: Context,
  options: IncidentOptions,
  dir: string,
  io: IncidentEvidenceIO = evidenceIO,
): Promise<IncidentPhase & { files: readonly string[]; failure?: Error }> {
  const actions: string[] = [];
  const notes: string[] = [];
  const files: string[] = [];

  if (options.dryRun) {
    actions.push(`${WOULD_PRESERVE} a log tail and \`docker inspect\` of the current container before rotate recreates it`);
    return { phase: "preserve", actions, notes, files: [] };
  }

  let step = "snapshot the running container before rotate";
  try {
    const snapshot = await ctx.runtime.captureIncidentSnapshot?.(options.tail);
    if (snapshot === undefined) {
      notes.push(`${ctx.runtime.description} has nothing running to snapshot, or cannot introspect it — ${NO_PRE_ROTATE_EVIDENCE} to preserve`);
      return { phase: "preserve", actions, notes, files };
    }
    step = `protect the pre-rotate evidence directory ${dir}`;
    await io.protectDirectory(dir);
    for (const [name, content] of [["pre-rotate-logs.txt", snapshot.logs], ["pre-rotate-inspect.json", snapshot.inspect]]) {
      const path = resolve(dir, name);
      step = `write pre-rotate evidence ${path}`;
      await io.writeFile(path, maskSecrets(content));
      files.push(name);
      actions.push(`preserved pre-rotate evidence into ${path}`);
    }
  } catch (error) {
    const detail = maskSecrets(error instanceof Error ? error.message : String(error));
    const reason = maskSecrets(`could not ${step}: ${detail} — pre-rotate evidence is incomplete; rotate proceeds regardless`);
    notes.push(reason);
    return { phase: "preserve", actions, notes, files, error: reason, failure: new Error(reason) };
  }
  return { phase: "preserve", actions, notes, files };
}

export async function collectEvidence(
  ctx: Context,
  options: IncidentOptions,
  dir: string,
  preservedFiles: readonly string[],
  security: SecurityAuditReport | undefined,
  doctorLint: { raw: string; error?: string } | undefined,
): Promise<IncidentPhase & { archive?: string }> {
  const actions: string[] = [];
  if (options.dryRun) {
    actions.push(`${WOULD_COLLECT} a bounded log tail, both audit outputs and a status summary into a private incidents/ directory`);
    return { phase: "collect", actions, notes: [] };
  }

  await protectPrivateDirectory(dir);

  const logs = await ctx.runtime.readLogs(options.tail).catch((error: unknown) => `(could not read logs: ${(error as Error).message})`);
  await createPrivateFile(resolve(dir, "logs.txt"), maskSecrets(logs));
  await createPrivateFile(resolve(dir, "security-audit.json"), maskSecrets(JSON.stringify(security ?? { findings: [], problems: [] }, null, 2)));
  await createPrivateFile(resolve(dir, "doctor-lint.json"), maskSecrets(doctorLint === undefined || doctorLint.raw === "" ? "{}" : doctorLint.raw));
  await createPrivateFile(resolve(dir, "status.txt"), maskSecrets(await captureStatus(ctx)));

  const files = [...preservedFiles, "logs.txt", "security-audit.json", "doctor-lint.json", "status.txt"];
  await createPrivateFile(
    resolve(dir, "manifest.json"),
    `${JSON.stringify({ createdAt: new Date().toISOString(), deployment: deploymentName(), files }, null, 2)}\n`,
  );

  actions.push(`collected evidence into ${dir}`);
  return { phase: "collect", actions, notes: [], archive: dir };
}

function render(report: IncidentReport): void {
  log(`incident response for ${report.deployment}${report.dryRun ? " — dry run, nothing changed" : ""}`);
  for (const phase of report.phases) {
    log(phase.phase);
    for (const action of phase.actions) info(action);
    for (const note of phase.notes) warn(note);
  }
  if (report.archive !== undefined) info(`evidence: ${report.archive}`);
}

interface IncidentOperations {
  readonly preserve: typeof preserveEvidence;
  readonly rotate: typeof rotateToken;
  readonly audit: typeof runAudits;
  readonly collect: typeof collectEvidence;
}

const incidentOperations: IncidentOperations = {
  preserve: preserveEvidence, rotate: rotateToken, audit: runAudits, collect: collectEvidence,
};

/** Attempts every phase, then reports any failure with the evidence actually saved. */
export async function runPhases(
  ctx: Context,
  options: IncidentOptions,
  operations: IncidentOperations = incidentOperations,
): Promise<IncidentReport> {
  let containError: unknown;
  const contain = await containExposure(ctx, options).catch((error: unknown): IncidentPhase => {
    containError = error;
    return {
      phase: "contain",
      actions: [],
      notes: [`${CONTAIN_FAILED}: ${(error as Error).message}${options.dryRun ? "" : " — rotate proceeds regardless"}`],
    };
  });

  const dir = incidentDir(new Date().toISOString().replaceAll(/[:.]/g, "-"));
  const preserve = await operations.preserve(ctx, options, dir).catch((error: unknown) => {
    const reason = maskSecrets(`preserve failed: ${error instanceof Error ? error.message : String(error)} — pre-rotate evidence is incomplete`);
    return { phase: "preserve" as const, actions: [], notes: [reason], files: [], error: reason, failure: new Error(reason) };
  });

  let rotate: IncidentPhase;
  let rotateError: unknown;
  try {
    rotate = await operations.rotate(ctx, options);
  } catch (error) {
    rotateError = error;
    rotate = { phase: "rotate", actions: [], notes: [`rotate failed: ${(error as Error).message}`] };
  }

  let audit: IncidentPhase;
  let security: SecurityAuditReport | undefined;
  let doctorLint: { raw: string; error?: string } | undefined;
  let auditError: unknown;
  try {
    const result = await operations.audit(ctx);
    audit = result.phase;
    security = result.security;
    doctorLint = result.doctorLint;
  } catch (error) {
    auditError = error;
    audit = { phase: "audit", actions: [], notes: [`audit failed: ${(error as Error).message}`] };
  }

  let collect: IncidentPhase & { archive?: string };
  let collectError: unknown;
  try {
    collect = await operations.collect(ctx, options, dir, preserve.files, security, doctorLint);
  } catch (error) {
    const reason = maskSecrets(`collect failed: ${error instanceof Error ? error.message : String(error)} — evidence is incomplete`);
    collectError = new Error(reason);
    collect = { phase: "collect", actions: [], notes: [reason], error: reason };
  }

  const report: IncidentReport = {
    deployment: deploymentName(),
    dryRun: options.dryRun,
    phases: [
      contain,
      { phase: preserve.phase, actions: preserve.actions, notes: preserve.notes, files: preserve.files, error: preserve.error },
      rotate,
      audit,
      { phase: collect.phase, actions: collect.actions, notes: collect.notes, error: collect.error },
    ],
    security,
    archive: collect.archive,
  };

  // A real run proceeds to rotate over a noted contain failure — leaving a stale exposure
  // noted beats skipping rotation. A dry-run has no rotate to save: a plan whose contain
  // phase could not even reach the target is not a plan worth printing, so it fails too.
  const failure = preserve.failure ?? rotateError ?? auditError ?? collectError ?? (options.dryRun ? containError : undefined);
  if (failure !== undefined) throw new IncidentPhaseFailure(report, failure);
  return report;
}

export async function incident(ctx: Context, args: string[]): Promise<void> {
  return runOnContext(INCIDENT, ctx, args, "incident");
}

/** The command body: the parser refuses bad argv before any contact, `--dry-run`'s read
 *  effect lifts the MCP confirmation and the lock; a real run holds the instance lock with
 *  the takeover the call declared. */
export const INCIDENT = commandBody({
  effect: "destroy",
  arguments: INCIDENT_ARGUMENTS,
  async run(ctx, values) {
    const options = optionsOf(values);
    const jsonOnly = values.json === true;

    // Before anything else, mutating or not: a plan for an instance that may still be publicly
    // reachable is not a plan worth printing.
    await refuseIfPubliclyExposed(ctx, options);

    let report: IncidentReport;
    try {
      if (!options.dryRun) await requireBootstrapped(ctx);
      report = options.dryRun
        ? await runPhases(ctx, options)
        : await guardedWith(ctx, "incident", takeoverOf(values), () => runPhases(ctx, options));
    } catch (error) {
      if (!(error instanceof IncidentPhaseFailure)) throw error;
      // Report completed work before propagating the phase failure.
      if (jsonOnly || isCaptured()) emit(`${JSON.stringify(error.report, null, 2)}\n`);
      else render(error.report);
      throw error.cause;
    }

    if (jsonOnly || isCaptured()) {
      emit(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    render(report);
  },
});
