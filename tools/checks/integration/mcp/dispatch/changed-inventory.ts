import { check, isolatedAppsRoot } from "#checks/kit/harness.ts";
import { type DeploymentFixture, type StageTally } from "#checks/kit/deployment-fixture.ts";
import { runProcess } from "#checks/kit/spawn.ts";
import { openclawCommands } from "#framework/commands/interface/index.ts";
import { specData, specOf, commandBody, materializeCommands, type ArgumentSpec, type ArgumentRule } from "#framework/core/command/index.ts";
import { defineApp } from "#framework/core/app.ts";
import { executeCommand, type CommandIo, type Execution } from "#framework/core/command/execute.ts";
import type { Transport } from "#framework/runtime/transport/transport.ts";
import { toolEnvelope } from "#framework/integration/mcp/call.ts";
import { useDeployment } from "#framework/runtime/deployment.ts";
import { withPrivateFileRenamer } from "#framework/security/privacy/private-file.ts";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { monorepoRoot } from "#framework/core/env.ts";
import { bindNamed } from "#framework/core/command/parse/index.ts";
import { specShape } from "#framework/core/command/spec.ts";
import type { Stage } from "#framework/core/command/execute.ts";

// Resolve against the monorepo root, not process.cwd(): the check is invoked from tools/,
// where cwd-relative "tools/..." paths would double the segment and the child's imports
// would fail with ERR_MODULE_NOT_FOUND before any CALL_STAGE line.
const moduleUrl = (name: string): string => pathToFileURL(join(monorepoRoot, "packages", "clawwright", name)).href;
const checkUrl = (name: string): string => pathToFileURL(join(monorepoRoot, "tools", "checks", name)).href;

export interface ChangedInventoryUnit {
  readonly label: string;
  readonly command: string;
  readonly action?: string;
  readonly effect: "change" | "destroy";
  readonly args: Readonly<Record<string, unknown>>;
  readonly sliceArguments: readonly ArgumentSpec[];
  readonly sliceRules: readonly ArgumentRule[];
  readonly baseEffect: "read" | "change" | "destroy";
  /** The unit's DECLARED needs (S2.6a): a single body's data.needs, an action slice its
   *  own ActionData.needs (default "target"); preparesEnvironment stays single-body only. */
  readonly needs: "nothing" | "local" | "deployment" | "target";
  /** The unit's DECLARED preparesEnvironment: a single body's data.preparesEnvironment;
   *  action slices always derive false (see needs). */
  readonly preparesEnvironment: boolean;
}

// Stage 7 S2.5: a resolve-bearing kind's example is not enough — the pipeline resolves it at
// prepare, so an inventory probe needs a value whose local fact HOLDS (a file that exists).
const example = (arg: ArgumentSpec, root?: string): unknown => {
  if (arg.kind === "flag") return true;
  const kind = arg.value;
  if (kind?.kind === "localFile" && root !== undefined) return join(root, "app.ts");
  if (kind?.kind === "localDirectory" && root !== undefined) return join(root, "recipes", "local");
  return kind?.example;
};

function buildArgs(command: string, args: readonly ArgumentSpec[], rules: readonly ArgumentRule[], target: ArgumentSpec & { kind: "flag" } | undefined, sliceAction: string | undefined, root: string | undefined): Record<string, unknown> {
  const available = (arg: ArgumentSpec): boolean => {
    if (!sliceAction) return true;
    const body = specOf(openclawCommands[command]!);
    if (!body) return true;
    const data = specData(body);
    if (data.kind === "single") return true;
    const owners = Object.entries(data.actions).filter(([, action]) => (action.arguments ?? []).some((candidate) => candidate.name === arg.name)).map(([action]) => action);
    return owners.length === 0 || owners.includes(sliceAction);
  };
  const chosen = new Set<string>();
  for (const arg of args) if (available(arg) && (arg.kind === "positional" || ((arg.kind === "option" || arg.kind === "variadic") && arg.required === true))) chosen.add(arg.name);
  for (const rule of rules) if (rule.rule === "oneOf" && rule.required === true) {
    const group = rule.groups.find((items) => items.every((name) => args.some((arg) => arg.name === name && available(arg))));
    if (group) for (const name of group) chosen.add(name);
  }
  if (target && available(target)) chosen.add(target.name);
  for (let pass = 0; pass < rules.length + 1; pass++) for (const rule of rules) {
    if (rule.rule === "requires" && chosen.has(rule.name)) {
      const candidates = rule.with.filter((name) => args.some((arg) => arg.name === name && available(arg)));
      if (rule.any === true) { if (!candidates.some((name) => chosen.has(name)) && candidates[0]) chosen.add(candidates[0]); }
      else for (const name of candidates) chosen.add(name);
    }
  }
  for (const rule of rules) if (rule.rule === "conflicts" && chosen.has(rule.name)) for (const name of rule.with) chosen.delete(name);
  if (target && available(target)) chosen.add(target.name);
  const result: Record<string, unknown> = {};
  for (const arg of args) if (available(arg) && chosen.has(arg.name)) result[arg.name] = arg.kind === "flag" ? true : arg.kind === "variadic" ? Array.from({ length: arg.count ?? 1 }, () => example(arg, root)) : example(arg, root);
  return result;
}

export function buildChangedInventory(root?: string): readonly ChangedInventoryUnit[] {
  const units: ChangedInventoryUnit[] = [];
  for (const [command, declaration] of Object.entries(openclawCommands)) {
    const body = specOf(declaration);
    if (!body) throw new Error(`cannot build ${command}: missing command body`);
    const data = specData(body);
    const slices = data.kind === "single" ? [{ label: command, action: undefined as string | undefined, args: data.arguments, rules: data.rules ?? [], effect: data.effect, needs: data.needs }] : Object.entries(data.actions).map(([action, item]) => ({ label: `${command} ${action}`, action, args: item.arguments ?? [], rules: item.rules ?? [], effect: item.effect ?? data.effect, needs: item.needs }));
    for (const slice of slices) {
      const targets: Array<{ effect: "change" | "destroy"; flag?: ArgumentSpec & { kind: "flag" } }> = [];
      if (slice.effect !== "read") targets.push({ effect: slice.effect });
      for (const arg of slice.args) if (arg.kind === "flag" && arg.effect !== undefined && arg.effect !== "read") targets.push({ effect: arg.effect, flag: arg });
      for (const target of targets) {
        const args = buildArgs(command, slice.args, slice.rules, target.flag, slice.action, root);
        try { bindNamed(specShape(body), { kind: "named", ...(slice.action ? { action: slice.action } : {}), args: { ...(slice.action ? { ...args, action: slice.action } : args), ...(target.effect === "destroy" ? { confirm: true } : {}) } }, command, { confirmed: true }); }
        catch (error) { throw new Error(`cannot build ${slice.label} ${target.effect} variant`, { cause: error }); }
        units.push({ label: `${slice.label}${target.flag ? ` [--${target.flag.name}]` : " [base effect]"}`, command, ...(slice.action ? { action: slice.action } : {}), effect: target.effect, args, sliceArguments: slice.args, sliceRules: slice.rules, baseEffect: slice.effect, needs: slice.needs, preparesEnvironment: data.kind === "single" ? data.preparesEnvironment : false });
      }
    }
  }
  return units;
}

const STAGE_PATTERN = "parse|confirm|prepare|environment|context|run";

export async function runChangedInventory(options: { fixture: DeploymentFixture; tally: StageTally }): Promise<void> {
  const { tally, fixture } = options;
  const script = `
    const { serveMcp } = await import(${JSON.stringify(moduleUrl("integration/mcp/server.ts"))});
    const { useDeployment } = await import(${JSON.stringify(moduleUrl("runtime/deployment.ts"))});
    const { commandBody, materializeCommands } = await import(${JSON.stringify(moduleUrl("core/command/spec.ts"))});
    const { UserError } = await import(${JSON.stringify(moduleUrl("core/io/log.ts"))});
    const { buildChangedInventory } = await import(${JSON.stringify(checkUrl("integration/mcp/dispatch/changed-inventory.ts"))});
    const { createDeploymentFixture } = await import(${JSON.stringify(checkUrl("kit/deployment-fixture.ts"))});
    const { useLinuxHost } = await import(${JSON.stringify(checkUrl("foundation/hygiene/linux-host.ts"))});
    await useLinuxHost();
    const fixture = await createDeploymentFixture();
    try {
      await useDeployment(fixture.root);
      const units = buildChangedInventory(process.env.FIXTURE_ROOT);
    const mode = process.env.CASE_MODE;
    const selected = mode === "confirm" ? units.filter((unit) => unit.effect === "destroy") : units;
    const commands = materializeCommands(Object.fromEntries(selected.map((unit, index) => {
      const name = "probe-" + index;
      // Declarations UNMODIFIED: the unit's original sliceArguments and sliceRules go in
      // verbatim (required/oneOf/requires/conflicts untouched), effect = unit.baseEffect.
      // Substitutions only: the run body is a safe no-op; in prepare mode prepare throws
      // (stage-forcing seam — the unit's OWN prepare, e.g. recover-env's, is replaced by the
      // throwing one so the case stays at the prepare stage); in context mode the app's
      // settings throw (context-forcing seam). preparesEnvironment is the unit's REAL
      // declaration (bootstrap, the only one: the fixture .env already carries the token
      // line, so the environment stage is a no-op pass-through).
      // Substitution exceptions (unit -> reason):
      // - recover-env (needs "deployment" -> "target"): execute gives deployment-needs
      //   commands a deploymentScope that never consults app.settings, so the context seam
      //   cannot refuse the call and the case would reach run instead of its built-for
      //   context stage. The same holds for a needs "local" unit (S2.6a). Only the
      //   context-forcing mode substitutes: there such a unit never builds the Context that
      //   mode's seam refuses, so it is probed at "target"; every other mode keeps the
      //   unit's DECLARED needs — run mode therefore exercises local units on their real
      //   scope, and deployment units on their deploymentScope.
      const body = commandBody({ effect: unit.baseEffect, arguments: [...unit.sliceArguments], rules: [...unit.sliceRules], needs: mode === "context" && unit.needs !== "target" ? "target" : unit.needs, ...(unit.preparesEnvironment ? { preparesEnvironment: true } : {}), ...(mode === "prepare" ? { prepare: async () => { throw new UserError("prepare refusal"); } } : {}), run: async () => {}, structured: true });
      return [name, { summary: unit.command, group: "change", structured: true, ...body }];
    })));
    const app = { name: "fixture", description: "changed inventory", commands, ...(mode === "context" ? { settings: () => { throw new UserError("context refusal"); } } : {}) };
    let calls = 0;
    await serveMcp(app, [], [], {
      observe: (stage) => {
        // One CALL_STAGE line PER PIPELINE CALL: calls are numbered 0-based at the call's
        // own parse observation (every call emits parse exactly once), so n is the number
        // of prior parse emissions and request id = n + 1 (serial callQueue order).
        if (stage === "parse") { process.stderr.write("CALL_STAGE " + calls + " " + stage + "\\n"); calls += 1; }
        else process.stderr.write("CALL_STAGE " + (calls - 1) + " " + stage + "\\n");
      },
      transport: fixture.transport(),
    });
    process.stderr.write("FIXTURE_CONTACTS " + JSON.stringify(fixture.contacts()) + "\\n");
    } finally { await fixture.dispose(); }
  `;
  const units = buildChangedInventory(options.fixture.root);
  const rows: Array<{ mode: string; expected: number; stages: Map<number, Stage>; responses: Array<{ id: number; result?: Record<string, unknown> }>; stderr: string }> = [];
  let failures = 0;
  const childApps = await isolatedAppsRoot("changed-inventory-child");
  try {
  for (const mode of ["parse", "confirm", "prepare", "context", "run"]) {
    const selected = mode === "confirm" ? units.filter((unit) => unit.effect === "destroy") : units;
    const requests = selected.map((unit, index) => ({ jsonrpc: "2.0", id: index + 1, method: "tools/call", params: { name: `probe-${index}`, arguments: { ...unit.args, confirm: mode !== "confirm", ...(mode === "parse" ? { __unknown: true } : {}) } } }));
    const result = await runProcess(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      cwd: childApps.root, env: { ...process.env, CASE_MODE: mode, FIXTURE_ROOT: options.fixture.root },
      input: requests.map((request) => JSON.stringify(request) + "\n").join(""), timeoutMs: 60_000,
    });
    if (result.code !== 0 || result.timedOut) failures++;
    // PER-CASE stage map: request id -> last CALL_STAGE line observed for that call.
    const stages = new Map<number, Stage>();
    for (const match of result.stderr.matchAll(new RegExp(`CALL_STAGE (\\d+) (${STAGE_PATTERN})`, "g"))) stages.set(Number(match[1]) + 1, match[2] as Stage);
    const responses = result.stdout.trim().split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line) as { jsonrpc?: string; id?: unknown; result?: Record<string, unknown> })
      .filter((message) => message.jsonrpc === "2.0" && typeof message.id === "number")
      .map((message) => ({ id: message.id as number, result: message.result }));
    rows.push({ mode, expected: requests.length, responses, stages, stderr: result.stderr });
  }
  } finally { await childApps.dispose(); }
  const contactsLine = new RegExp("FIXTURE_CONTACTS (\\[[^\\n]*\\])");
  const rowContacts = (stderr: string): string => stderr.match(contactsLine)?.[1] ?? "absent";
  check("changed inventory child exits", failures, 0);
  check("changed inventory modes", rows.map((row) => row.mode), ["parse", "confirm", "prepare", "context", "run"]);
  for (const row of rows) {
    const selected = row.mode === "confirm" ? units.filter((unit) => unit.effect === "destroy") : units;
    check(`${row.mode}: response count`, row.responses.length, selected.length);
    check(`${row.mode}: request count`, row.expected, selected.length);
    // PER ROW: zero contacts for the WHOLE batch — the child prints one FIXTURE_CONTACTS line
    // per run, so this covers every probe of this mode at once.
    check(`${row.mode}: zero fixture host contacts`, rowContacts(row.stderr), "[]");
    for (const response of row.responses) {
      const envelope = response.result;
      const payload = envelope !== undefined && envelope.structuredContent !== null && typeof envelope.structuredContent === "object" ? envelope.structuredContent as Record<string, unknown> : undefined;
      const expectedStage: Stage = row.mode === "parse" ? "parse" : row.mode === "confirm" ? "confirm" : (row.mode as Stage);
      const stage = row.stages.get(response.id);
      // PER RESPONSE: this call's own observed stage must be the case's built-for stage.
      check(`${row.mode}: per-call stage ${response.id}`, stage, expectedStage);
      if (row.mode === "parse" || row.mode === "confirm") check(`${row.mode}: bare response ${response.id}`, envelope !== undefined && typeof envelope.isError === "boolean" && !("structuredContent" in envelope), true);
      else check(`${row.mode}: changed ${response.id}`, payload?.changed, row.mode === "run");
      tally.case(`${row.mode} ${response.id}`, stage ?? "parse", failures === 0 ? undefined : new Error(row.stderr));
    }
  }
  const counts = units.reduce((acc, unit) => (acc[unit.effect] = (acc[unit.effect] ?? 0) + 1, acc), {} as Record<string, number>);
  process.stdout.write(`changed inventory: ${units.length} (${JSON.stringify(counts)}); responses ${rows.reduce((sum, row) => sum + row.responses.length, 0)}\n`);
  await runEnvironmentCases(tally, fixture);
}

/** Environment-stage cases. These two run in the PARENT process (withPrivateFileRenamer is
 *  only importable in-process), driven through executeCommand with surface "mcp" against the
 *  fixture deployment, asserting the envelope via toolEnvelope.
 *  Substitutions: the probe's run body is a safe no-op (never reached), and in
 *  environment-partial the private-file renamer is a test double that performs the REAL
 *  rename (the token content has landed) and then throws a non-transient EACCES. */
async function runEnvironmentCases(tally: StageTally, fixture: DeploymentFixture): Promise<void> {
  await useDeployment(fixture.root);
  const probe = { summary: "environment probe", group: "change" as const, structured: true, ...commandBody({ effect: "change", arguments: [], needs: "target", preparesEnvironment: true, run: async () => {} }) };
  const app = defineApp({ name: "fixture", description: "environment probes", commands: materializeCommands({ probe }) });
  const envPath = join(fixture.root, ".env");
  const original = await readFile(envPath, "utf8");
  let _observed: Stage | undefined;
  // The fixture's recording transport goes to the call's io, so any target contact the
  // pipeline attempted is logged; transport() clears the log, called once per case BEFORE
  // the call so the log covers just that case.
  const io = (transport: Transport): CommandIo => ({ surface: "mcp" as const, confirmed: true, transport, observe: (stage: Stage) => { _observed = stage; } });
  // (a) environment-fail: the fixture .env is replaced by a DIRECTORY of the same name, so
  // createPrivateFile/protect fail and the pipeline refuses at the environment stage.
  const failTransport = fixture.transport();
  await rm(envPath);
  await mkdir(envPath);
  const failRun = await executeCommand(app, "probe", { kind: "named", args: {} }, io(failTransport));
  await rm(envPath, { recursive: true });
  await writeFile(envPath, original, "utf8");
  const failEnvelope = toolEnvelope(probe, "", undefined, "probe-env-fail", [], failRun, undefined, failRun.error);
  check("environment-fail: stage", failRun.stage, "environment");
  check("environment-fail: changed envelope", failEnvelope.changed, false);
  check("environment-fail: zero fixture host contacts", fixture.contacts().length, 0);
  tally.case("environment-fail", failRun.stage, failRun.stage === "environment" && failEnvelope.changed === false ? undefined : new Error(`stage ${failRun.stage} changed ${failEnvelope.changed}`));
  // (b) environment-partial: the token line is removed (env stays a file), the renamer double
  // lands the new token content then throws EACCES, so provisioningWrites marks the error and
  // execute's failed() carries environmentWrote -> the envelope reports changed: true.
  const withoutToken = original.replace(/^OPENCLAW_GATEWAY_TOKEN=.*\n/m, "");
  await writeFile(envPath, withoutToken, "utf8");
  const partialTransport = fixture.transport();
  let partialRun: Execution | undefined;
  await withPrivateFileRenamer(async (from, to) => {
    await rename(from, to);
    const failure: NodeJS.ErrnoException = new Error("simulated rename contention");
    failure.code = "EACCES";
    throw failure;
  }, async () => { partialRun = await executeCommand(app, "probe", { kind: "named", args: {} }, io(partialTransport)); });
  await writeFile(envPath, original, "utf8");
  const partialEnvelope = toolEnvelope(probe, "", undefined, "probe-env-partial", [], partialRun, undefined, partialRun?.error);
  check("environment-partial: stage", partialRun?.stage, "environment");
  check("environment-partial: changed envelope after landed write", partialEnvelope.changed, true);
  check("environment-partial: zero fixture host contacts", fixture.contacts().length, 0);
  tally.case("environment-partial", partialRun?.stage ?? "parse", partialRun?.stage === "environment" && partialEnvelope.changed === true ? undefined : new Error(`stage ${partialRun?.stage} changed ${partialEnvelope.changed}`));
}
