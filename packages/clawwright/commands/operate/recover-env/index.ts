// `clawwright recover-env` — repairs .env's CONNECTION FACTS (OC_DATA_DIR,
// OPENCLAW_GATEWAY_PORT, OC_COMPOSE_PROJECT, OPENCLAW_IMAGE) from the running container,
// which compose resolved from that same .env at creation time.
//
// Which side is authoritative when file and container disagree is undecidable here, so by
// default only the unambiguous case is written — a name the file lacks entirely. Diverged
// values are reported, never overwritten, unless --adopt-runtime takes the container as
// authoritative. The opposite direction (file is right) needs `up` to recreate.
// A wholly absent .env cannot be repaired: reaching the target requires the .env that names it.
// Declared as a body with needs: "deployment": the pipeline (core/command/execute.ts) builds
// the deployment scope — transport from .env, no Context — and refuses a missing .env in the
// prepare stage. recoverEnv(ctx, args) stays for the apply step, which already has a Context.

import { log, info, warn, die } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit } from "#src/core/io/output.ts";
import { parseEnv, readEnvFileText } from "#src/core/env.ts";
import { envFile } from "#src/runtime/deployment.ts";
import type { Context } from "#src/core/context.ts";
import { commandBody, parseDeclaredArgs } from "#src/core/command/index.ts";
import { replacePrivateFile } from "#src/security/privacy/private-file.ts";
import { upsertEnvValue } from "#src/security/privacy/private-config.ts";
import { CONNECTION_FACTS, connectionFactDiffs, unrecoverableConnectionFacts } from "./facts.ts";
import type { ConnectionFactDiff, ConnectionFacts } from "./facts.ts";
import { runningConnectionFactsWithoutContext } from "./bootstrap.ts";
import { TransportUnreachableError } from "#src/runtime/transport/transport.ts";
import { unreachableProblem } from "#src/service/inspection.ts";

export const RECOVER_ENV_ARGUMENTS = [
  { name: "dry-run", description: "Changes only", kind: "flag", effect: "read" },
  {
    name: "adopt-runtime",
    summary: "Take the running container as authoritative",
    description: "Take the running container as authoritative: merge its facts over the file's existing values too, not just fill the names it is missing",
    kind: "flag",
  },
  { name: "json", description: "Outcome as JSON", kind: "flag" },
] as const;

/** Reports the facts Docker's own answer did not carry — left as they are, never guessed.
 *  Shared by every exit path, so a dry run names exactly the gaps a real write would. */
function reportUnrecoverable(unrecoverable: { name: string }[]): void {
  if (unrecoverable.length === 0) return;
  warn(`could not recover ${unrecoverable.length} fact(s) — left as they are, never guessed:`);
  for (const fact of unrecoverable) info(fact.name);
}

/** Names the facts both sides carry with different values and the two directions out — the
 *  decision this command declines to make on the operator's behalf. Names only: the values
 *  are printed when a direction is chosen and a write reports what it wrote. */
export const NO_DIRECTION_NOTE = "authoritative is the operator's call — nothing is written over them without a direction:";

function reportDirectionChoice(diverged: ConnectionFactDiff[]): void {
  if (diverged.length === 0) return;
  log(
    `${diverged.length} connection fact(s) differ from the running container, and which side is ` +
      NO_DIRECTION_NOTE,
  );
  for (const fact of diverged) info(fact.name);
  info(`keep the container's values: ${commandLine(["recover-env", "--adopt-runtime"])}`);
  info(`keep .env's values (the edit is the intent): ${commandLine("up")} recreates the container from the file as it now reads`);
}

export const NOTHING_TO_RECOVER = "nothing to recover — every connection fact that could be recovered already matches the running instance";

export function dryRunHeader(count: number, total: number, path: string): string {
  return `dry run — ${count} of ${total} connection fact(s) would be written to ${path}`;
}

export function cannotIntrospectRefusal(description: string): string {
  return `${description} cannot introspect its running container, so the connection facts cannot be recovered here`;
}

export const NOT_RUNNING_CAUSE = "is not running, or its container could not be inspected";
export const RECOVERABLE_ONLY_FROM_RUNNING = "facts are recoverable only from a running container";

export function notRunningRefusal(description: string): string {
  return (
    `${description} ${NOT_RUNNING_CAUSE} — the connection ` +
    `${RECOVERABLE_ONLY_FROM_RUNNING}, since that is where compose's resolved ` +
    `values live. Start it and try again: ${commandLine("up")}`
  );
}

/** The one argument grammar, parsed for the apply step's entry point (the pipeline parses
 *  the body's own declaration): a dry run names what would change and writes nothing;
 *  --adopt-runtime takes the container as the authoritative side; anything else is refused
 *  rather than guessed at. */
function parseRecoveryArgs(args: string[]): { dryRun: boolean; adoptRuntime: boolean; jsonOnly: boolean } {
  const parsed = parseDeclaredArgs(RECOVER_ENV_ARGUMENTS, args);
  return { dryRun: parsed["dry-run"] === true, adoptRuntime: parsed["adopt-runtime"] === true, jsonOnly: parsed.json === true };
}

/** A wholly absent .env is the command's one stated limit: reaching the target to inspect
 *  its container already requires the .env that says which target and transport to use.
 *  The pipeline's prepare stage refuses here, before any contact. */
export function missingEnvRefusal(path: string): string {
  return (
    `${path} does not exist, and recovery cannot create it: reaching the target to inspect ` +
    "its container already requires the .env that says which target and transport to use — " +
    `a missing .env has nothing to recover against. Run ${commandLine("bootstrap")} to create one.`
  );
}

function refuseWithoutEnvFile(raw: string | undefined, path: string): string {
  if (raw !== undefined) return raw;
  die(missingEnvRefusal(path));
}

/** The merge both entry points share: the running container's facts classified against the
 *  file as it reads now — missing names filled by default, diverged values written only
 *  under --adopt-runtime — and written in place. The file mixes these non-secret plumbing
 *  values with a real secret (OPENCLAW_GATEWAY_TOKEN), so the raw content passes through
 *  upsertEnvValue for exactly the four names and is never printed, parsed out, or reported
 *  beyond them. */
async function mergeRecoveredFacts(
  facts: ConnectionFacts,
  path: string,
  raw: string,
  dryRun: boolean,
  adoptRuntime: boolean,
  jsonOnly = false,
): Promise<void> {
  const current = parseEnv(raw, path);

  const diffs = connectionFactDiffs(facts, current);
  const diverged = diffs.filter((entry) => entry.kind === "diverged");
  // Missing names are the unambiguous case — filling them cannot overwrite anything the
  // operator typed. Values both sides carry differently are written only when the operator
  // chose the container as the authoritative side.
  const writable = adoptRuntime ? diffs : diffs.filter((entry) => entry.kind === "missing");
  const unrecoverable = unrecoverableConnectionFacts(facts);

  if (diffs.length === 0) {
    if (jsonOnly) {
      emit(`${JSON.stringify({ ok: true, changed: false, path, written: [], diverged: [], unrecoverable: unrecoverable.map((fact) => fact.name) }, null, 2)}\n`);
      return;
    }
    log(NOTHING_TO_RECOVER);
    reportUnrecoverable(unrecoverable);
    return;
  }

  if (dryRun) {
    if (jsonOnly) {
      emit(
        `${JSON.stringify(
          {
            ok: true,
            changed: false,
            dryRun: true,
            path,
            wouldWrite: writable.map((fact) => ({ name: fact.name, value: fact.value })),
            diverged: diverged.map((fact) => fact.name),
            unrecoverable: unrecoverable.map((fact) => fact.name),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    log(dryRunHeader(writable.length, CONNECTION_FACTS.length, path));
    for (const fact of writable) info(`${fact.name}=${fact.value}`);
    if (!adoptRuntime) reportDirectionChoice(diverged);
    reportUnrecoverable(unrecoverable);
    return;
  }

  if (writable.length > 0) {
    let content = raw;
    for (const fact of writable) content = upsertEnvValue(content, fact.name, fact.value);
    // replacePrivateFile even though these four values are not secrets: the file mixes them
    // with a real secret (OPENCLAW_GATEWAY_TOKEN) in the same file, so protection is per-file,
    // not per-line. Unrelated lines — the token's included — pass through upsertEnvValue
    // untouched and are never read beyond that.
    await replacePrivateFile(path, content);

    if (!jsonOnly) {
      log(`recovered ${writable.length} of ${CONNECTION_FACTS.length} connection fact(s) into ${path}`);
      for (const fact of writable) info(`${fact.name}=${fact.value}`);
      // The facts just written were read FROM the running container, so it already operates
      // them — and a restart keeps the container with its once-interpolated environment, so
      // it could not deliver them even if it had to. What reads this file fresh is the next
      // recreation (compose interpolates .env at container creation) and this tooling's own
      // context, which re-derives from it.
      info("the running container already operates these facts — nothing needs restarting");
    }
  }
  if (jsonOnly) {
    emit(
      `${JSON.stringify(
        {
          ok: true,
          changed: writable.length > 0,
          path,
          written: writable.map((fact) => fact.name),
          diverged: diverged.map((fact) => fact.name),
          unrecoverable: unrecoverable.map((fact) => fact.name),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (!adoptRuntime) reportDirectionChoice(diverged);
  reportUnrecoverable(unrecoverable);
}

/** The full-context entry point, for the apply step (orchestration/apply.ts), which already
 *  holds a Context. Refusals are the established ones — a runtime that cannot introspect,
 *  and a container that is not running. */
export async function recoverEnv(ctx: Context, args: string[]): Promise<void> {
  const { dryRun, adoptRuntime, jsonOnly } = parseRecoveryArgs(args);

  const path = envFile();
  let raw: string | undefined;
  try {
    raw = await readEnvFileText();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  refuseWithoutEnvFile(raw, path);

  if (typeof ctx.runtime.runningConnectionFacts !== "function") {
    die(cannotIntrospectRefusal(ctx.runtime.description));
  }

  const facts = await ctx.runtime.runningConnectionFacts();
  if (facts === undefined) {
    die(notRunningRefusal(ctx.runtime.description));
  }

  await mergeRecoveredFacts(facts, path, raw as string, dryRun, adoptRuntime, jsonOnly);
}

interface RecoveryPlan {
  readonly dryRun: boolean;
  readonly adoptRuntime: boolean;
  readonly jsonOnly: boolean;
}

/** The command body. The run needs only a DeploymentScope: the transport selected from the
 *  .env location settings, the service name, and the file itself — never a Context (with
 *  OC_DATA_DIR missing, the Context the dispatcher would demand cannot be built at all). */
export const RECOVER_ENV = commandBody({
  effect: "change",
  needs: "deployment",
  arguments: RECOVER_ENV_ARGUMENTS,
  async prepare(call, local) {
    const path = envFile();
    refuseWithoutEnvFile(await local.readText(path), path);
    const values = call.values as { "dry-run"?: boolean; "adopt-runtime"?: boolean; json?: boolean };
    return {
      dryRun: values["dry-run"] === true,
      adoptRuntime: values["adopt-runtime"] === true,
      jsonOnly: values.json === true,
    } satisfies RecoveryPlan;
  },
  async run(scope, plan) {
    const { dryRun, adoptRuntime, jsonOnly } = plan as RecoveryPlan;
    const path = envFile();
    const raw = await readEnvFileText();
    const env = parseEnv(raw, path);

    let facts: ConnectionFacts | undefined;
    try {
      facts = await runningConnectionFactsWithoutContext({
        env,
        transport: await scope.transport(),
        service: scope.service,
      });
    } catch (error) {
      if (!(error instanceof TransportUnreachableError)) throw error;
      // The standard unreachable refusal, in status's words: the target was never
      // reached, which is not a docker-not-running answer (rf6-fix30). The remedy
      // rides as advice, so formatError and the failure documents render it (rf6-fix33).
      const problem = unreachableProblem(error);
      die(`${problem.code}  ${problem.detail}`, problem.next);
    }
    if (facts === undefined) {
      die(
        "docker is not running, or its container could not be inspected — the connection " +
          "facts are recoverable only from a running container, since that is where compose's resolved " +
          `values live. Start it and try again: ${commandLine("up")}`,
      );
    }

    await mergeRecoveredFacts(facts, path, raw, dryRun, adoptRuntime, jsonOnly);
  },
});
