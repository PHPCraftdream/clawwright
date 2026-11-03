// `clawwright smoke` — acceptance run for an instance. Checks the properties that actually
// cost debugging time:
//   - the gateway is healthy by BOTH criteria (HTTP probe and the runtime's own verdict)
//   - the agent answers end to end, i.e. the provider key really resolved
//   - the declaration in the repository wins over manual drift
//   - a full backup restores byte-for-byte (into an isolated root, never over live data)
//   - the verifier accepts a shareable archive AND rejects one with secrets
//   - the MCP bridge speaks JSON-RPC on a clean stdout
// The two negative checks matter most: a suite that only confirms success degrades silently.
//
// This file: health-probe checks and orchestration. round-trip.ts: the backup/restore round
// trip and archive/privacy checks. verdict.ts: the shared four-outcome vocabulary.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import JSON5 from "json5";
import { log, info, warn } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit, withOutputSink } from "#src/core/io/output.ts";
import type { Context } from "#src/core/context.ts";
import { CouldNotCheck, NotChecked } from "#src/commands/check-outcome.ts";
import { requireBootstrapped } from "#src/runtime/runtime.ts";
import { applyConfig } from "#src/commands/orchestration/config.ts";
import { desiredStateFile } from "#src/runtime/deployment.ts";
import { noProviderConfigured } from "#src/service/secrets.ts";
import { configPathParts, mergePatchDiff, readConfigPath, setConfigPath } from "#src/core/values/config/config-selectors.ts";
import { commandBody, type ArgumentSpec } from "#src/core/command/spec.ts";
import { reach, expect, describeError, evaluate, type Check, type SmokeResult } from "./verdict.ts";
import { REJECTS_SECRETS_ENTRY, ACCEPTS_SHARE_ENTRY, ROUND_TRIP_ENTRY, ROUND_TRIP_CHECK, ARCHIVE_CHECK_NAMES, runArchiveChecks } from "./round-trip.ts";

export { reach, expect, describeError, evaluate, toResult } from "./verdict.ts";
export type { Check, SmokeResult } from "./verdict.ts";

export const SMOKE_ARGUMENTS = [
  { name: "quick", description: "Skip the slow check", kind: "flag" },
  { name: "json", description: "Outcome as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

// Hard ceiling on smoke's agent round-trip, enforced inside the container.
const AGENT_DEADLINE_S = 120;

/** A probe answered with a status a healthy gateway never gives. */
export function probeRefusal(endpoint: string, code: number): string {
  return `${endpoint} returned ${code}`;
}

/** The provider-missing hint the agent check adds when the live config really has none. */
export function providerMissingDetail(error: unknown): string {
  return `no model provider is configured — run ${commandLine("configure-provider")} (${describeError(error)})`;
}

export const checks: Check[] = [
  {
    name: "gateway answers all HTTP probes",
    run: async (ctx) => {
      for (const endpoint of ["healthz", "startupz", "readyz"]) {
        const code = await reach(`probe ${endpoint}`, () => ctx.runtime.probe(endpoint));
        expect(code === 200, probeRefusal(endpoint, code));
      }
    },
  },
  {
    name: "runtime reports the container healthy",
    run: async (ctx) => {
      const health = await reach("ask the runtime for container health", () => ctx.runtime.health());
      expect(health === "healthy", `container health is "${health}"`);
    },
  },
  {
    name: "agent answers end to end",
    run: async (ctx) => {
      try {
        // Bounded inside the container: without a provider the CLI was seen hanging for 10+
        // minutes, and killing wsl.exe/ssh on this side leaves the target's compose running.
        const result = await reach("ask the agent", () =>
          ctx.runtime.runOneOff("cli", [
            "-k", "10", String(AGENT_DEADLINE_S), "node", "dist/index.js",
            "agent", "--agent", "main", "--timeout", String(AGENT_DEADLINE_S - 30), "-m", "Reply with exactly: SMOKE-OK",
          ], {
            profile: "cli",
            entrypoint: "timeout",
            input: "",
          }),
        );
        if (result.stdout.includes("SMOKE-OK")) return;
        expect(false, `agent replied: ${result.stdout.trim().slice(0, 120)}`);
      } catch (error) {
        // A silent OR unreachable agent is most often PROVIDER_MISSING, whichever way
        // this check failed — named instead of just the symptom, when the live config really
        // configures none (best effort: noProviderConfigured() never replaces a real failure
        // with an unrelated guess).
        if (!(await noProviderConfigured(ctx))) throw error;
        const message = providerMissingDetail(error);
        throw error instanceof CouldNotCheck ? new CouldNotCheck(message) : new Error(message);
      }
    },
  },
  {
    name: "desired state overrides manual drift",
    run: async (ctx) => {
      const declared = JSON.parse(await readFile(desiredStateFile(), "utf8")) as {
        path: string;
        value?: unknown;
      }[];

      // Any declared string setting will do, and which one is the deployment's business —
      // insisting on a specific path like agents.defaults.model.primary would break on a
      // template that does not declare it. gateway.* is left alone: drifting it takes the
      // service down for as long as the check runs.
      const subject = declared.find(
        (entry) => typeof entry.value === "string" && !entry.path.startsWith("gateway."),
      );
      if (subject === undefined) {
        throw new NotChecked("desired-state.json declares no drift-safe string setting");
      }

      const wanted = subject.value as string;
      const configPath = `${ctx.settings.dataDir}/config/openclaw.json`;
      const parts = configPathParts(subject.path);
      const selectorPath = parts.some((part) => part.kind === "selector");
      const stage = selectorPath ? `${ctx.settings.dataDir}/config/clawwright-smoke-${randomBytes(6).toString("hex")}.json` : undefined;

      try {
        if (selectorPath) {
          const live = JSON5.parse(await reach("read the live configuration", () => ctx.transport.readFile(configPath))) as Record<string, unknown>;
          const changed = structuredClone(live);
          setConfigPath(changed, subject.path, `${wanted}-drifted`);
          const patch = mergePatchDiff(live, changed);
          if (patch === undefined) throw new Error(`${subject.path} could not be drifted`);
          const staged = stage!;
          await reach("stage selector drift patch", () => ctx.transport.writeFile(staged, JSON.stringify(patch)));
          try {
            await reach("drift the setting on the instance", () => ctx.runtime.runOneOff(
              "gateway", ["dist/index.js", "config", "patch", "--file", ctx.paths.toContainer(staged)],
              { noDeps: true, entrypoint: "node", input: "" },
            ));
          } finally {
            await ctx.transport.remove(staged).catch(() => {});
          }
        } else {
          await reach("drift the setting on the instance", () =>
            ctx.runtime.runOneOff(
              "gateway",
              ["dist/index.js", "config", "set", subject.path, JSON.stringify(`${wanted}-drifted`), "--strict-json"],
              { noDeps: true, entrypoint: "node", input: "" },
            ),
          );
        }
        await reach("apply the declaration", () => applyConfig(ctx, []));

        // JSON5, not JSON: the live config is OpenClaw's own JSON5 gateway format.
        const config = JSON5.parse(await reach("read the live configuration", () => ctx.transport.readFile(configPath))) as Record<string, unknown>;
        const actual = readConfigPath(config, subject.path);
        expect(actual === wanted, `${subject.path} is ${String(actual)}, expected ${wanted}`);
      } finally {
        // Whatever happened, the declaration is what the instance should be left with. The
        // verdict is already in by the time this runs, so a failure here stays a plain
        // failure — reach() must not re-label it as a verdict the check never got. But it
        // must say more than the raw error: this call is what un-drifts the setting, so
        // when it fails the reader needs what the instance may still hold and the repair,
        // not just the symptom.
        await applyConfig(ctx, []).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`restoring the declaration failed — ${subject.path} may still hold the drifted value; repair with ${commandLine("apply-config")}: ${message}`);
        });
      }
    },
  },
  REJECTS_SECRETS_ENTRY,
  ACCEPTS_SHARE_ENTRY,
  {
    name: "MCP bridge speaks JSON-RPC",
    run: async (ctx) => {
      const request = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
      });
      const result = await reach("speak JSON-RPC to the bridge", () =>
        ctx.runtime.runOneOff("cli", ["mcp", "serve"], {
          profile: "cli",
          input: `${request}\n`,
        }),
      );
      expect(result.stdout.includes('"serverInfo"'), `bridge replied: ${result.stdout.trim().slice(0, 120)}`);
    },
  },
  ROUND_TRIP_ENTRY,
];

export interface SmokeSummary {
  readonly results: SmokeResult[];
  readonly passed: number;
  readonly failed: number;
  readonly notChecked: number;
  readonly couldNotCheck: number;
}

function printResult(result: SmokeResult): void {
  const line = `${result.status.toUpperCase().padEnd(7)} ${result.name}${result.detail === undefined ? "" : `  ${result.detail}`}`;
  if (result.status === "failed") warn(line);
  else info(line);
}

function tally(counts: { passed: number; failed: number; notChecked: number; couldNotCheck: number }, result: SmokeResult): void {
  if (result.status === "passed") counts.passed += 1;
  else if (result.status === "failed") counts.failed += 1;
  else if (result.status === "not-checked") counts.notChecked += 1;
  else counts.couldNotCheck += 1;
}

/** Runs the checks, classifying every outcome into the shared vocabulary. Never throws:
 *  the counts are the answer. A throw a check did not classify itself stays a failure. */
export async function runChecks(ctx: Context, selected: Check[], onResult: (result: SmokeResult) => void = printResult): Promise<SmokeSummary> {
  const results: SmokeResult[] = [];
  const counts = { passed: 0, failed: 0, notChecked: 0, couldNotCheck: 0 };

  for (const check of selected) {
    const result = await evaluate(check.name, () => check.run(ctx));
    results.push(result);
    tally(counts, result);
    onResult(result);
  }

  return { results, ...counts };
}

/** The whole selected run: ordinary checks one at a time, exactly as runChecks() does; the
 *  three archive-based checks, wherever they appear in `selected`, consolidated into one
 *  stop/start cycle via round-trip.ts's runArchiveChecks() — their results are emitted
 *  together at the position the first of them holds. This is what smoke() below runs. */
export async function runSmokeSuite(ctx: Context, selected: Check[], onResult: (result: SmokeResult) => void = printResult): Promise<SmokeSummary> {
  const results: SmokeResult[] = [];
  const counts = { passed: 0, failed: 0, notChecked: 0, couldNotCheck: 0 };
  const record = (result: SmokeResult): void => {
    results.push(result);
    tally(counts, result);
    onResult(result);
  };

  const wanted = new Set(selected.filter((check) => ARCHIVE_CHECK_NAMES.has(check.name)).map((check) => check.name));
  let archiveGroupDone = false;

  for (const check of selected) {
    if (ARCHIVE_CHECK_NAMES.has(check.name)) {
      if (archiveGroupDone) continue;
      archiveGroupDone = true;
      for (const result of await runArchiveChecks(ctx, wanted)) record(result);
      continue;
    }
    record(await evaluate(check.name, () => check.run(ctx)));
  }

  return { results, ...counts };
}

/** The run's refusal when any check went unanswered: could-not-check fails exactly as a
 *  failure does. Shared with the checks that prove the wording. */
export function smokeDidNotPassMessage(unanswered: number, failed: number, couldNotCheck: number, names: readonly string[]): string {
  return `${unanswered} smoke check(s) did not pass (${failed} failed, ${couldNotCheck} could not be checked): ${names.join(", ")}`;
}

export function smokePassedMessage(passed: number, notChecked: number): string {
  return `all ${passed} checks passed${notChecked > 0 ? `, ${notChecked} not checked` : ""}`;
}

/** Prints what the run concluded, and refuses to call a run with an unanswered check
 *  successful: could-not-check fails the run exactly as a failed check does. */
export function report(summary: SmokeSummary, quick: boolean): void {
  if (quick) info("skipping the round-trip (--quick)");

  const unanswered = summary.results.filter((result) => result.status === "failed" || result.status === "could-not-check");
  if (unanswered.length > 0) {
    throw new Error(smokeDidNotPassMessage(unanswered.length, summary.failed, summary.couldNotCheck, unanswered.map((result) => result.name)));
  }
  log(smokePassedMessage(summary.passed, summary.notChecked));
}

export const SMOKE = commandBody({
  effect: "change",
  arguments: SMOKE_ARGUMENTS,
  async run(ctx, values) {
    // Arguments first: a typo is refused before the target is contacted at all.
    await requireBootstrapped(ctx);
    const quick = values.quick === true;
    const jsonOnly = values.json === true;
  const selected = quick ? checks.filter((check) => check.name !== ROUND_TRIP_CHECK) : checks;

  if (jsonOnly) {
    let summary: SmokeSummary | undefined;
    await withOutputSink(() => {}, async () => {
      summary = await runSmokeSuite(ctx, selected, () => {});
    });
    const found = summary!;
    const ok = found.failed === 0 && found.couldNotCheck === 0;
    emit(
      `${JSON.stringify(
        {
          ok,
          changed: false,
          quick,
          passed: found.passed,
          failed: found.failed,
          notChecked: found.notChecked,
          couldNotCheck: found.couldNotCheck,
          results: found.results,
          problems: found.results.filter((result) => result.status === "failed" || result.status === "could-not-check")
            .map((result) => `${result.name}: ${result.detail ?? ""}`),
        },
        null,
        2,
      )}\n`,
    );
    if (!ok) throw new Error(`${found.failed} smoke check(s) failed, ${found.couldNotCheck} could not be checked`);
    return;
  }

  log(`smoke run against ${ctx.settings.serviceUrl}`);

  report(await runSmokeSuite(ctx, selected), quick);
  },
});
