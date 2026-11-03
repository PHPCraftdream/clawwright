// `operations [<id>]` — what mutating runs did to this instance.
//
// The journal is written by the commands that change things; this is how anyone reads it.
// Without it the record would be a file on the target that only someone who already knew
// where to look could find, which is not much better than no record at all.

import { log, info, warn, die } from "#src/core/io/log.ts";
import { commandLine } from "#src/core/io/invocation/render.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { listOperations, readOperation, operationsDir } from "#src/service/operations.ts";
import type { Context } from "#src/core/context.ts";
import type { ArgumentSpec } from "#src/core/command/spec.ts";
import { commandBody, runOnContext } from "#src/core/command/index.ts";
import * as kinds from "#src/core/values/kinds.ts";
import { createInterface } from "node:readline/promises";
import { LOCK_TAKEOVER_ARGUMENTS, takeoverOf } from "#src/commands/interface/groups/shared-arguments.ts";
import { withInstanceLock, observeInstanceLockSnapshot, readLockHolder, lockPath, lockHome, type InstanceLockObservation, type InstanceLockSnapshot } from "#src/runtime/lock/instance-lock.ts";
import { newOperationId } from "#src/service/operations.ts";
import { readLockOwnerIdentity, isLocalLockOwner } from "#src/runtime/lock/lock-claim.ts";
import { probeEntryExists } from "#src/runtime/transport/transport.ts";
import type { OperationId } from "#src/core/values/plan.ts";

// The same kind object prepare derives through, so the plan carries the branded OperationId;
// the record's existence is the run's target fact, refused where it is judged (design §5.2).
const OPERATION_ID = kinds.operationId("20260101000000000-apply-ab12cd");

export const OPERATIONS_ARGUMENTS = [
  { name: "id", description: "Operation id to show", kind: "positional", value: OPERATION_ID },
  {
    name: "limit",
    summary: "Operations to list",
    description: "How many recent operations to list (default 10)",
    kind: "option",
    valueName: "n",
    value: kinds.positive(),
  },
  { name: "takeover-lock", description: "Release lock metadata only", kind: "flag", effect: "destroy" },
  ...LOCK_TAKEOVER_ARGUMENTS,
  { name: "confirmed", description: "MCP confirmation consent", kind: "flag", setByConfirm: true },
  { name: "json", description: "Record or list as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

/** What the run needs, decided from the arguments alone in the prepare stage. */
interface OperationsPlan {
  readonly id?: OperationId;
  readonly limit?: number;
  readonly json: boolean;
  readonly takeoverLock: boolean;
  readonly breakLock: boolean;
  readonly breakForeignLockHost?: string;
}

/** Unknown target answers throw; only the transport contract proves absence. */
async function metadataPresent(ctx: Context, path: string): Promise<boolean> {
  return probeEntryExists(ctx.transport, path);
}

async function metadataSnapshot(ctx: Context): Promise<InstanceLockSnapshot> {
  if (!(await metadataPresent(ctx, lockPath(ctx)))) return { observation: { state: "absent", takeover: "none" } };
  const snapshot = await observeInstanceLockSnapshot(ctx);
  if (snapshot.observation.state === "absent") throw new Error("lock metadata observation changed or is unreadable");
  return snapshot;
}

async function metadataObservation(ctx: Context): Promise<InstanceLockObservation> {
  return (await metadataSnapshot(ctx)).observation;
}

async function verifyQuiescence(ctx: Context): Promise<void> {
  if (await metadataPresent(ctx, lockPath(ctx)) ||
      await metadataPresent(ctx, `${lockHome(ctx)}/operation.mutation`)) {
    throw new Error("lock metadata release/quiescence was not verified");
  }
}

/** Observed facts only: null means not verified, never absent by inference. */
export interface MetadataTakeoverReport {
  mode: "takeover-lock";
  changed: boolean | null;
  before: InstanceLockObservation | null;
  claimed: InstanceLockObservation | null;
  after: InstanceLockObservation | null;
  acquisitionVerified: boolean;
  releaseVerified: boolean;
  quiescent: boolean;
  problem?: { code: "LOCK_METADATA_TAKEOVER_UNCONFIRMED"; detail: string };
}

async function takeoverMetadata(ctx: Context, plan: OperationsPlan, report: MetadataTakeoverReport): Promise<void> {
  const { observation: before, holder: expectedOwner } = await metadataSnapshot(ctx);
  report.before = before;
  report.changed = false;
  if (before.state === "absent") {
    await verifyQuiescence(ctx);
    report.after = before;
    report.quiescent = true;
    return;
  }
  if (before.state === "live" || before.state === "unknown") die("lock owner is live or unknown; metadata takeover refused");
  const expectedIdentity = readLockOwnerIdentity(expectedOwner);
  if (expectedOwner === undefined || expectedIdentity === undefined) {
    die("lock owner identity is unknown or malformed; metadata takeover refused");
  }
  report.changed = null;
  await withInstanceLock(ctx, "operations", newOperationId("operations"), {
    breakLock: plan.breakLock, breakForeignLockHost: plan.breakForeignLockHost,
    expectedOwner, strictVerification: true,
  }, async (held) => {
    const observation = await metadataObservation(ctx);
    report.claimed = observation;
    const published = await readLockHolder(ctx);
    const identity = readLockOwnerIdentity(published);
    if (published === undefined || published.generation !== held.holder.generation ||
        published.operationId !== held.holder.operationId || published.takenAt !== held.holder.takenAt ||
        identity === undefined || !isLocalLockOwner(identity) || identity.pid !== process.pid ||
        identity.startedAt !== held.holder.startedAt ||
        (await ctx.transport.exec("test", ["-d", `${held.path}/gen-${held.holder.generation}`], { allowFailure: true })).code !== 0) {
      throw new Error("published owned instance lock acquisition was not verified");
    }
    if (observation.state !== "live") throw new Error("owned instance lock liveness was not verified");
    report.acquisitionVerified = true;
    report.changed = true;
  });
  await verifyQuiescence(ctx);
  const after = await metadataObservation(ctx);
  report.after = after;
  if (after.state !== "absent") throw new Error("lock metadata changed after release");
  report.changed = true;
  report.releaseVerified = true;
  report.quiescent = true;
}

export const OPERATIONS = commandBody({
  effect: "read",
  arguments: OPERATIONS_ARGUMENTS,
  // Only the named MCP binder supplies this flag; argv callers always type consent.
  refuse: { "--confirmed": "consent is supplied by MCP confirm: true; terminal callers must type yes" },
  rules: [
    { rule: "requires", name: "takeover-lock", with: ["break-lock"] },
    { rule: "conflicts", name: "takeover-lock", with: ["id", "limit"] },
    { rule: "requires", name: "break-lock", with: ["takeover-lock"] },
    { rule: "requires", name: "break-foreign-lock", with: ["takeover-lock"] },
  ],
  prepare: async (call) => {
    if (call.values["takeover-lock"] && !call.values.confirmed) {
      // Same typed-yes/TTY/stderr consent pattern as restore's private confirm helper.
      // Prepare also runs in runOnContext, before any target observation.
      if (process.stdin.isTTY !== true) die("metadata takeover requires typed confirmation or MCP confirm: true");
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        if ((await rl.question("Take over and release lock metadata only. Type 'yes' to continue: ")).trim() !== "yes") die("aborted");
      } finally { rl.close(); }
    }
    return {
      // The branded id is resolved by the pipeline; record existence is a target fact.
      id: call.values.id,
      limit: call.values.limit,
      json: call.values.json,
      takeoverLock: call.values["takeover-lock"],
      ...takeoverOf(call.values),
    } satisfies OperationsPlan;
  },
  async run(ctx, plan) {
    if (plan.takeoverLock) {
      const result: MetadataTakeoverReport = { mode: "takeover-lock", changed: null,
        before: null, claimed: null, after: null, acquisitionVerified: false,
        releaseVerified: false, quiescent: false };
      try {
        await takeoverMetadata(ctx, plan, result);
      } catch (error) {
        // A final read is diagnostic only; it neither repairs nor certifies release.
        try { result.after = await metadataObservation(ctx); } catch { /* unavailable */ }
        result.releaseVerified = false;
        result.quiescent = false;
        result.problem = { code: "LOCK_METADATA_TAKEOVER_UNCONFIRMED",
          detail: "Metadata takeover did not complete verification; inspect observed ownership before retrying." };
        if (plan.json || isCaptured()) emit(`${JSON.stringify(result, null, 2)}\n`);
        else warn(result.problem.detail);
        throw error;
      }
      if (plan.json || isCaptured()) emit(`${JSON.stringify(result, null, 2)}\n`);
      else log(result.changed ? "operation lock taken over and released; metadata quiescent" : "no operation lock; metadata unchanged and quiescent");
      return;
    }
    const jsonOnly = plan.json;
    const limit = plan.limit;
    const wanted = plan.id;

    if (wanted !== undefined) {
      const record = await readOperation(ctx, wanted);
      if (record === undefined) die(`no operation "${wanted}" recorded in ${operationsDir(ctx)}`);

      if (jsonOnly || isCaptured()) {
        emit(`${JSON.stringify(record, null, 2)}\n`);
        return;
      }

      log(`${record.id} — ${record.command} on ${record.deployment}`);
      info(`started   ${record.startedAt}`);
      info(`finished  ${record.finishedAt ?? "(never — the run did not reach the end)"}`);
      info(`outcome   ${record.outcome ?? "unknown"}`);
      if (record.configSnapshot !== undefined) {
        info(`snapshot  ${record.configSnapshot}`);
        info(`          put it back with: ${commandLine(["rollback", "--operation", record.id])}`);
      }
      for (const step of record.steps) {
        const line = `${step.status.padEnd(8)} ${step.id}${step.detail === undefined ? "" : `  ${step.detail}`}`;
        if (step.status === "failed") warn(line);
        else info(line);
      }
      if (record.note !== undefined) info(record.note);
      return;
    }

    const ids = (await listOperations(ctx)).slice(0, limit);
    const records = [];
    for (const id of ids) {
      const record = await readOperation(ctx, id);
      if (record !== undefined) records.push(record);
    }

    if (jsonOnly || isCaptured()) {
      emit(`${JSON.stringify({ operations: records }, null, 2)}\n`);
      return;
    }

    if (records.length === 0) {
      log("no operations recorded yet");
      info(`they appear in ${operationsDir(ctx)} once something changes the instance`);
      return;
    }

    log(`${records.length} most recent operation(s)`);
    for (const record of records) {
      // An operation with no outcome did not reach its own end — killed, disconnected, or
      // still running. Saying "unknown" is the honest answer and is also the one worth
      // noticing, so it is not dressed up as a result.
      const outcome = record.outcome ?? "unfinished";
      const failed = record.steps.filter((step) => step.status === "failed").length;
      info(`${record.id}  ${outcome}${failed > 0 ? `, ${failed} failed step(s)` : ""}`);
    }
    info(`details: ${commandLine(["operations", "<id>"])}`);
  },
});

/** The full-context entry for callers outside this group (release checks): the same
 *  declaration, parsed and run on a context they already hold. */
export const operations = (ctx: Context, args: string[]): Promise<void> => runOnContext(OPERATIONS, ctx, args);
