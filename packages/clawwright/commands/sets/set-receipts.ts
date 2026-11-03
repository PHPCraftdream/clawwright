// `clawwright set receipts` — inspect durable acceptance evidence written for a set.

import { info, log } from "#src/core/io/log.ts";
import { emit, isCaptured } from "#src/core/io/output.ts";
import { listReceipts, readReceipt, type AcceptanceReceipt } from "#src/set/artifacts/receipt.ts";
import type { Context } from "#src/core/context.ts";
import { defineAction, type ArgumentSpec, type Values } from "#src/core/command/index.ts";
import * as kinds from "#src/core/values/kinds.ts";

export const SET_RECEIPTS_ARGUMENTS = [
  {
    name: "set-id",
    summary: "Filter by set id",
    description: "With receipts: filter by immutable set id",
    kind: "option",
    valueName: "id",
    value: kinds.checksum("hex64", { expected: "a set id (64 hexadecimal characters)", invalid: (raw) => `: invalid set id "${raw}"`, example: "ab".repeat(32) }),
  },
  {
    name: "receipt",
    summary: "Show one receipt",
    description: "With receipts: show this receipt; requires --set-id",
    kind: "option",
    valueName: "id",
    value: kinds.receiptId(),
  },
  { name: "json", summary: "Emit the receipts as JSON", description: "Emit the receipts as JSON", kind: "flag" },
] as const satisfies readonly ArgumentSpec[];

function showLine(receipt: AcceptanceReceipt): void {
  log(`receipt ${receipt.receiptId}`);
  info(`set       ${receipt.setName} (${receipt.setId})`);
  info(`verdict   ${receipt.verdict} (${receipt.coverage} coverage)`);
  info(`source    ${receipt.source}`);
  info(`security  ${securitySummary(receipt)}`);
  if (receipt.recordedVerdict !== undefined) info(`recorded  ${receipt.recordedVerdict} (legacy verdict without gate evidence)`);
  info(`finished  ${receipt.finishedAt}`);
  info(`checks    ${receipt.counts.passed} passed, ${receipt.counts.failed} failed, ` +
    `${receipt.counts.notChecked} not checked, ${receipt.counts.couldNotCheck} could not check`);
  for (const [recipe, checks] of Object.entries(receipt.checks)) {
    info(`recipe    ${recipe}`);
    for (const check of checks) info(`  ${check.status.padEnd(15)} ${check.name}${check.detail === undefined ? "" : `  ${check.detail}`}`);
  }
}

function securitySummary(receipt: AcceptanceReceipt): string {
  if (receipt.security === undefined) {
    return receipt.source === "set-try" ? "not run; trial checks and runtime only" : "not recorded";
  }
  const reasons = receipt.security.reasons.length === 0 ? "" : `: ${receipt.security.reasons.join(", ")}`;
  return `${receipt.security.blocking} blocking${reasons}`;
}

/** The persistence root is deploymentDir(), while the optional root in the persistence API
 *  keeps that API independently testable. This command intentionally has no runtime calls. */
async function runSetReceipts(
  _ctx: Context,
  values: Values<typeof SET_RECEIPTS_ARGUMENTS>,
): Promise<void> {
  const { "set-id": setId, receipt: receiptId, json } = values;
  if (receiptId !== undefined && setId !== undefined) {
    const receipt = await readReceipt(setId, receiptId);
    if (json || isCaptured()) emit(`${JSON.stringify(receipt, null, 2)}\n`);
    else showLine(receipt);
    return;
  }
  const receipts = await listReceipts(setId);
  if (json || isCaptured()) {
    emit(`${JSON.stringify(receipts, null, 2)}\n`);
    return;
  }
  if (receipts.length === 0) {
    log("no acceptance receipts");
    return;
  }
  for (const receipt of receipts) {
    log(`${receipt.verdict.padEnd(12)} ${receipt.receiptId}  ${receipt.finishedAt}  ${receipt.setName}  (security: ${securitySummary(receipt)})`);
  }
}

export const SET_RECEIPTS = defineAction({
  summary: "List saved acceptance receipts",
  effect: "read",
  arguments: SET_RECEIPTS_ARGUMENTS,
  rules: [{ rule: "requires", name: "receipt", with: ["set-id"] }],
  run: runSetReceipts,
});
