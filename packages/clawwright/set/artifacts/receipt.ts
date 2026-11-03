// Durable local evidence for a set acceptance run.
//
// A receipt is an observation, not a signature or a claim made by a registry.  It binds the
// verified content id to the runtime facts the caller actually observed at that time.  The
// file is immutable and carries a content id so accidental edits are detected when it is
// read back.

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deploymentDir } from "#src/runtime/deployment.ts";
import { checksumOf } from "#src/service/checksums.ts";
import { canonicalJson } from "./model.ts";
import { readName } from "#src/core/values/names.ts";
import { ValueError, type ValueParser } from "#src/core/values/value.ts";
import type { AcceptanceStatus, AcceptanceResult } from "#src/commands/orchestration/accept.ts";

export const RECEIPT_VERSION = 1;
const SET_ID = /^[0-9a-f]{64}$/;
const RECEIPT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/;
/** The argument grammars over the same ids the file layout enforces, declared so a bad
 * --set-id or --receipt is refused at the parse stage, before the context is built. */
export function setIdValue(): ValueParser<string> {
  return {
    expected: "a set id (64 hexadecimal characters)", example: "ab".repeat(32), invalidExample: "zz",
    parse(raw) {
      if (!SET_ID.test(raw)) throw new ValueError(`: invalid set id "${raw}"`);
      return raw;
    },
  };
}

export function receiptIdValue(): ValueParser<string> {
  return {
    expected: "a receipt id", example: "fresh-1", invalidExample: "Bad_Id",
    parse(raw) {
      if (!RECEIPT_ID.test(raw) || raw === "." || raw === "..") throw new ValueError(`: invalid receipt id "${raw}"`);
      return raw;
    },
  };
}
export type ReceiptSource = "set-try" | "accept";
export type ReceiptCoverage = "complete" | "partial" | "none";
export type ReceiptVerdict = "verified" | "failed" | "not-verified";

/** Gate outcome with portable problem codes, never audit text or secret values. */
export interface ReceiptSecurity {
  readonly blocking: number;
  readonly reasons: readonly string[];
}

export interface ReceiptObservations {
  readonly frameworkVersion: string;
  readonly openclawVersion?: string;
  readonly imageId?: string;
  readonly imageDigest?: string;
}

export interface ReceiptSelection {
  /** Recipe names that were selected, in the order supplied by the caller. */
  // raw string: set/artifacts/evidence.ts feeds unbranded selections, outside this stage's editable files (S3.1 lists it for S1.3)
  readonly recipes: readonly string[];
  readonly withModel: boolean;
  /** True only when the caller ran the complete declared recipe selection. */
  readonly allRecipes: boolean;
}

export interface ReceiptCounts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly notChecked: number;
  readonly couldNotCheck: number;
}

/** The report kept for one declared check. Definitions are represented by a stable hash so
 * a receipt can be committed or copied without accidentally carrying a prompt or secret. */
export interface ReceiptCheck {
  readonly name: string;
  readonly kind: string;
  readonly status: AcceptanceStatus;
  readonly detail?: string;
  readonly definitionHash: string;
}

export interface AcceptanceReceipt {
  readonly version: number;
  readonly receiptId: string;
  readonly contentId: string;
  readonly setId: string;
  readonly setName: string;
  readonly source: ReceiptSource;
  /** The caller checked artifact binding and the required runtime identity. */
  readonly subjectVerified: boolean;
  readonly security?: ReceiptSecurity;
  /** Original verdict of legacy evidence downgraded on read; not stored or hashed. */
  readonly recordedVerdict?: ReceiptVerdict;
  readonly selection: ReceiptSelection;
  readonly observations: ReceiptObservations;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly checks: Record<string, readonly ReceiptCheck[]>;
  readonly counts: ReceiptCounts;
  readonly coverage: ReceiptCoverage;
  readonly verdict: ReceiptVerdict;
}

/** Input accepts the existing AcceptanceResult shape directly. `definition` is consumed to
 * make its stable hash and is never written; callers may provide a precomputed hash instead. */
export type ReceiptCheckInput = AcceptanceResult & {
  readonly definition?: unknown;
  readonly definitionHash?: string;
};

export interface WriteReceiptInput {
  readonly receiptId?: string;
  readonly setId: string;
  // raw string: set/artifacts/evidence.ts passes manifest.name (SetManifest's reader-side string), outside this stage's editable files (S3.1 lists it for S1.3)
  readonly setName: string;
  readonly source: ReceiptSource;
  readonly subjectVerified: boolean;
  readonly security?: ReceiptSecurity;
  readonly selection: ReceiptSelection;
  readonly observations: ReceiptObservations;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly checks: Record<string, readonly ReceiptCheckInput[]>;
}

function receiptRoot(root?: string): string {
  return resolve(root ?? deploymentDir(), "sets", "receipts");
}

function setPath(setId: string): string {
  if (!SET_ID.test(setId)) throw new Error(`invalid set id "${setId}"`);
  return setId;
}

function receiptPath(setId: string, receiptId: string, root?: string): string {
  setPath(setId);
  if (!RECEIPT_ID.test(receiptId) || receiptId === "." || receiptId === "..") {
    throw new Error(`invalid receipt id "${receiptId}"`);
  }
  return join(receiptRoot(root), setId, `${receiptId}.json`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value;
}

function isoTimestamp(value: unknown, field: string): string {
  const result = text(value, field);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${field} must be an ISO timestamp`);
  return result;
}

function safeDetail(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const detail = text(value, "check detail");
  // Details are useful diagnostics, but an absolute host path does not belong in a portable
  // receipt. Keep the report while removing the machine-specific part.
  return detail
    .replace(/\b[A-Za-z]:[\\/][^\s"']*/g, "<path>")
    .replace(/(^|[\s("'])\/(?:Users|home|private|root|tmp|var|mnt)(?:\/[^\s"']*)?/gi, "$1<path>");
}

function definitionHash(input: ReceiptCheckInput): string {
  if (input.definitionHash !== undefined) {
    if (!HASH.test(input.definitionHash)) throw new Error(`check "${input.name}" has an invalid definition hash`);
    return input.definitionHash;
  }
  if (input.definition === undefined) {
    throw new Error(`check "${input.name}" needs a definition or definitionHash`);
  }
  return checksumOf(canonicalJson(input.definition));
}

function checkInput(input: ReceiptCheckInput, recipe: string, index: number): ReceiptCheck {
  if (input === null || typeof input !== "object") throw new Error(`receipt check ${recipe}[${index}] must be an object`);
  const name = text(input.name, `receipt check ${recipe}[${index}].name`);
  const kind = text(input.kind, `receipt check ${recipe}[${index}].kind`);
  if (!["passed", "failed", "not-checked", "could-not-check"].includes(input.status)) {
    throw new Error(`receipt check ${recipe}[${index}] has an invalid status`);
  }
  const detail = safeDetail(input.detail);
  return {
    name,
    kind,
    status: input.status,
    ...(detail === undefined ? {} : { detail }),
    definitionHash: definitionHash(input),
  };
}

function normalizeChecks(input: Record<string, readonly ReceiptCheckInput[]>): Record<string, readonly ReceiptCheck[]> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("receipt checks must be an object keyed by recipe");
  const output: Record<string, readonly ReceiptCheck[]> = {};
  for (const [recipe, checks] of Object.entries(input)) {
    readName("recipe", recipe);
    if (!Array.isArray(checks)) throw new Error(`receipt checks for recipe "${recipe}" must be an array`);
    output[recipe] = checks.map((check, index) => checkInput(check, recipe, index));
  }
  return output;
}

function normalizeSelection(input: ReceiptSelection): ReceiptSelection {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("receipt selection must be an object");
  if (!Array.isArray(input.recipes) || input.recipes.some((recipe) => typeof recipe !== "string")) throw new Error("receipt selection.recipes must be an array of names");
  if (typeof input.withModel !== "boolean" || typeof input.allRecipes !== "boolean") throw new Error("receipt selection flags must be booleans");
  const recipes = input.recipes.map((recipe) => readName("recipe", recipe));
  if (new Set(recipes).size !== recipes.length) throw new Error("receipt selection.recipes must contain unique names");
  return { recipes, withModel: input.withModel, allRecipes: input.allRecipes };
}

function assertSelectionMatchesChecks(selection: ReceiptSelection, checks: Record<string, readonly ReceiptCheck[]>): void {
  const selected = new Set(selection.recipes);
  const actual = Object.keys(checks);
  if (selected.size !== actual.length || actual.some((recipe) => !selected.has(recipe))) {
    throw new Error("receipt selection.recipes must exactly match the recipe keys in checks");
  }
  for (const entries of Object.values(checks)) {
    for (const check of entries) {
      if (!selection.withModel && check.kind === "agent_answers" && (check.status === "passed" || check.status === "failed")) {
        throw new Error("agent_answers cannot be passed or failed when selection.withModel is false");
      }
    }
  }
}

function countsOf(checks: Record<string, readonly ReceiptCheck[]>): ReceiptCounts {
  const all = Object.values(checks).flat();
  return {
    total: all.length,
    passed: all.filter((check) => check.status === "passed").length,
    failed: all.filter((check) => check.status === "failed").length,
    notChecked: all.filter((check) => check.status === "not-checked").length,
    couldNotCheck: all.filter((check) => check.status === "could-not-check").length,
  };
}

function normalizeSecurity(value: unknown): ReceiptSecurity | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("receipt security must be an object");
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.blocking) || (raw.blocking as number) < 0) throw new Error("receipt security.blocking must be a non-negative integer");
  if (!Array.isArray(raw.reasons) || raw.reasons.some((reason) => typeof reason !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(reason))) {
    throw new Error("receipt security.reasons must contain only problem codes");
  }
  if (raw.reasons.length !== raw.blocking) throw new Error("receipt security reasons must match its blocking count");
  return { blocking: raw.blocking as number, reasons: [...raw.reasons] as string[] };
}

function outcome(selection: ReceiptSelection, counts: ReceiptCounts, subjectVerified: boolean, securityVerified: boolean): { coverage: ReceiptCoverage; verdict: ReceiptVerdict } {
  if (counts.total === 0) return { coverage: "none", verdict: "not-verified" };
  const complete = selection.allRecipes && counts.notChecked === 0 && counts.couldNotCheck === 0;
  const coverage = complete ? "complete" : "partial";
  if (counts.failed > 0) return { coverage, verdict: "failed" };
  if (!complete || counts.passed !== counts.total || !subjectVerified || !securityVerified) return { coverage, verdict: "not-verified" };
  return { coverage, verdict: "verified" };
}

function payloadOf(receipt: AcceptanceReceipt): Omit<AcceptanceReceipt, "contentId"> {
  const { contentId: _contentId, recordedVerdict, ...payload } = receipt;
  return { ...payload, verdict: recordedVerdict ?? receipt.verdict };
}

function contentIdOf(receipt: AcceptanceReceipt): string {
  return checksumOf(canonicalJson(payloadOf(receipt)));
}

function validateReceipt(value: unknown, expectedSetId?: string, expectedReceiptId?: string): AcceptanceReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("receipt is not an object");
  const raw = value as Record<string, unknown>;
  if (raw.version !== RECEIPT_VERSION) throw new Error("unsupported receipt version");
  const setId = text(raw.setId, "receipt setId");
  const receiptId = text(raw.receiptId, "receipt receiptId");
  setPath(setId);
  if (!RECEIPT_ID.test(receiptId)) throw new Error("invalid receipt receiptId");
  if (expectedSetId !== undefined && setId !== expectedSetId) throw new Error("receipt set id does not match its directory");
  if (expectedReceiptId !== undefined && receiptId !== expectedReceiptId) throw new Error("receipt id does not match its file");
  const setName = text(raw.setName, "receipt setName");
  readName("set", setName);
  if (raw.source !== "set-try" && raw.source !== "accept") throw new Error("receipt source must be set-try or accept");
  if (typeof raw.subjectVerified !== "boolean") throw new Error("receipt subjectVerified must be a boolean");
  const observations = raw.observations;
  if (observations === null || typeof observations !== "object" || Array.isArray(observations)) throw new Error("receipt observations must be an object");
  const obs = observations as Record<string, unknown>;
  const normalizedObservations: ReceiptObservations = {
    frameworkVersion: text(obs.frameworkVersion, "receipt observations.frameworkVersion"),
    ...(obs.openclawVersion === undefined ? {} : { openclawVersion: text(obs.openclawVersion, "receipt observations.openclawVersion") }),
    ...(obs.imageId === undefined ? {} : { imageId: text(obs.imageId, "receipt observations.imageId") }),
    ...(obs.imageDigest === undefined ? {} : { imageDigest: text(obs.imageDigest, "receipt observations.imageDigest") }),
  };
  const startedAt = isoTimestamp(raw.startedAt, "receipt startedAt");
  const finishedAt = isoTimestamp(raw.finishedAt, "receipt finishedAt");
  if (Date.parse(finishedAt) < Date.parse(startedAt)) throw new Error("receipt finishedAt precedes startedAt");
  const normalizedSelection = normalizeSelection(raw.selection as ReceiptSelection);
  const checks = normalizeChecks((raw.checks ?? {}) as Record<string, readonly ReceiptCheckInput[]>);
  assertSelectionMatchesChecks(normalizedSelection, checks);
  const counts = countsOf(checks);
  if (canonicalJson(raw.counts) !== canonicalJson(counts)) throw new Error("receipt counts do not match its checks");
  const security = normalizeSecurity(raw.security);
  const securityVerified = security === undefined ? raw.source !== "accept" : security.blocking === 0;
  const expectedOutcome = outcome(normalizedSelection, counts, raw.subjectVerified, securityVerified);
  const legacyOutcome = outcome(normalizedSelection, counts, raw.subjectVerified, true);
  const legacyVerified = raw.source === "accept" && security === undefined && raw.verdict === "verified" && legacyOutcome.verdict === "verified";
  if (raw.coverage !== expectedOutcome.coverage || (raw.verdict !== expectedOutcome.verdict && !legacyVerified)) throw new Error("receipt outcome does not match its checks, selection and security gate");
  const receipt: AcceptanceReceipt = {
    version: RECEIPT_VERSION,
    receiptId,
    contentId: text(raw.contentId, "receipt contentId"),
    setId,
    setName,
    source: raw.source,
    subjectVerified: raw.subjectVerified,
    ...(security === undefined ? {} : { security }),
    ...(legacyVerified ? { recordedVerdict: "verified" as const } : {}),
    selection: normalizedSelection,
    observations: normalizedObservations,
    startedAt,
    finishedAt,
    checks,
    counts,
    coverage: expectedOutcome.coverage,
    verdict: expectedOutcome.verdict,
  };
  if (!HASH.test(receipt.contentId) || receipt.contentId !== contentIdOf(receipt)) throw new Error("receipt content id does not match its contents");
  return receipt;
}

/** Writes one immutable receipt. The optional root is the deployment directory and exists to
 * keep this pure persistence API testable without selecting a live deployment. */
export async function writeReceipt(input: WriteReceiptInput, root?: string): Promise<AcceptanceReceipt> {
  const receiptId = input.receiptId ?? randomUUID().replaceAll("-", "");
  if (!RECEIPT_ID.test(receiptId)) throw new Error(`invalid receipt id "${receiptId}"`);
  if (!SET_ID.test(input.setId)) throw new Error(`invalid set id "${input.setId}"`);
  readName("set", input.setName);
  if (input.source !== "set-try" && input.source !== "accept") throw new Error("receipt source must be set-try or accept");
  if (typeof input.subjectVerified !== "boolean") throw new Error("receipt subjectVerified must be a boolean");
  const selection = normalizeSelection(input.selection);
  const checks = normalizeChecks(input.checks);
  assertSelectionMatchesChecks(selection, checks);
  const counts = countsOf(checks);
  const startedAt = isoTimestamp(input.startedAt, "receipt startedAt");
  const finishedAt = isoTimestamp(input.finishedAt, "receipt finishedAt");
  if (Date.parse(finishedAt) < Date.parse(startedAt)) throw new Error("receipt finishedAt precedes startedAt");
  const observations: ReceiptObservations = {
    frameworkVersion: text(input.observations.frameworkVersion, "receipt observations.frameworkVersion"),
    ...(input.observations.openclawVersion === undefined ? {} : { openclawVersion: text(input.observations.openclawVersion, "receipt observations.openclawVersion") }),
    ...(input.observations.imageId === undefined ? {} : { imageId: text(input.observations.imageId, "receipt observations.imageId") }),
    ...(input.observations.imageDigest === undefined ? {} : { imageDigest: text(input.observations.imageDigest, "receipt observations.imageDigest") }),
  };
  const security = normalizeSecurity(input.security);
  const { coverage, verdict } = outcome(selection, counts, input.subjectVerified, security === undefined ? input.source !== "accept" : security.blocking === 0);
  const withoutContent: Omit<AcceptanceReceipt, "contentId"> = {
    version: RECEIPT_VERSION,
    receiptId,
    setId: input.setId,
    setName: input.setName,
    source: input.source,
    subjectVerified: input.subjectVerified,
    ...(security === undefined ? {} : { security }),
    selection,
    observations,
    startedAt,
    finishedAt,
    checks,
    counts,
    coverage,
    verdict,
  };
  const receipt = { ...withoutContent, contentId: checksumOf(canonicalJson(withoutContent)) } as AcceptanceReceipt;
  const path = receiptPath(receipt.setId, receipt.receiptId, root);
  await mkdir(resolve(path, ".."), { recursive: true });
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  } catch (error) {
    // Do not leave a truncated record that would poison a later list operation.
    await unlink(path).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
  return receipt;
}

export async function readReceipt(setId: string, receiptId: string, root?: string): Promise<AcceptanceReceipt> {
  const path = receiptPath(setId, receiptId, root);
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  return validateReceipt(parsed, setId, receiptId);
}

/** Lists valid receipts. A malformed record is an error, never silently omitted as if no
 * evidence existed. */
export async function listReceipts(setId?: string, root?: string): Promise<AcceptanceReceipt[]> {
  const base = receiptRoot(root);
  let setIds: string[];
  if (setId !== undefined) {
    setIds = [setPath(setId)];
  } else {
    try {
      setIds = (await readdir(base, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  const found: AcceptanceReceipt[] = [];
  for (const id of setIds) {
    setPath(id);
    const dir = join(base, id);
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
      const receiptId = entry.name.slice(0, -5);
      const receipt = await readReceipt(id, receiptId, root);
      found.push(receipt);
    }
  }
  found.sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt) || a.receiptId.localeCompare(b.receiptId));
  return found;
}
