// `clawwright bootstrap --check` — a read-only prerequisite report for a deployment
// bootstrap has never touched: no lock, no mutation, no directory created. Everything real
// bootstrap otherwise discovers mid-mutation (docker missing, compose v2 absent, a data
// directory that needs root, the port already taken, a nearly-full disk) is answered here
// first, one line per prerequisite.
//
// The probes live in prereqs.ts; this file only owns the report's shape and exit-code
// contract.

import { log, info } from "../../../core/io/log.ts";
import { commandLine } from "../../../core/io/invocation/render.ts";
import { emit } from "../../../core/io/output.ts";
import type { Context } from "../../../core/context.ts";
import { TransportUnreachableError } from "../../../runtime/transport/transport.ts";
import { unreachableProblem } from "../../../service/inspection.ts";
import { runPrereqProbes, type PrereqResult } from "./prereqs.ts";

function statusLabel(status: PrereqResult["status"]): string {
  return status === "ok" ? "ok" : status === "warn" ? "WARN" : "FAIL";
}

function renderLine(result: PrereqResult): void {
  const label = statusLabel(result.status).padEnd(4);
  info(`${label} ${result.what}${result.next === undefined ? "" : ` — ${result.next}`}`);
}

/** `clawwright bootstrap --check`'s own run: prints one `ok`/`WARN`/`FAIL` line per prerequisite
 *  and exits non-zero only when at least one FAILed. A transport that never reaches the
 *  target is reported through the same TARGET_UNREACHABLE finding every other command uses,
 *  rather than propagating as a stack trace. */
export async function bootstrapCheck(ctx: Context, jsonOnly = false): Promise<void> {
  if (!jsonOnly) log(`bootstrap --check: ${ctx.settings.dataDir}`);

  let results: PrereqResult[];
  try {
    results = await runPrereqProbes(ctx);
  } catch (error) {
    if (!(error instanceof TransportUnreachableError)) throw error;
    const found = unreachableProblem(error);
    if (jsonOnly) {
      emit(`${JSON.stringify({ ok: false, changed: false, results: [{ status: "fail", what: found.detail, next: found.nextAction }] }, null, 2)}\n`);
    } else {
      renderLine({ status: "fail", what: found.detail, next: found.nextAction });
    }
    throw new Error(`${found.code}: could not reach the target to check prerequisites`);
  }

  const failed = results.filter((result) => result.status === "fail");
  if (jsonOnly) {
    emit(`${JSON.stringify({ ok: failed.length === 0, changed: false, results }, null, 2)}\n`);
    if (failed.length > 0) throw new Error(`${failed.length} prerequisite(s) failed: ${failed.map((result) => result.what).join("; ")}`);
    return;
  }

  for (const result of results) renderLine(result);

  if (failed.length === 0) {
    log(`no blocking prerequisites — ${commandLine("bootstrap")} should proceed without a sudo password prompt`);
    return;
  }
  throw new Error(`${failed.length} prerequisite(s) failed: ${failed.map((result) => result.what).join("; ")}`);
}
