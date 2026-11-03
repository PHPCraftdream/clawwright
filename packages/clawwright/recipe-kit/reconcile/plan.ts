// Pure planning: adversarial inputs fail validation here and never reach a patch. All
// comparisons run on canonical JSON so key order never fakes a difference.

import { createHmac } from "node:crypto";

import { RecipeKitRefusal } from "../types.ts";
import { privatePseudonymKey, privatePseudonymKeyIfPresent } from "../../security/privacy/structured/pseudonym.ts";
import { safeReconcileSegment } from "./paths.ts";
import type {
  ReconcileEntry, ReconcileKeyChange, ReconcileKeyRef, ReconcilePlan, ReconcilePlanInput,
  ReconcilePlanView, ReconcilePlanViewOptions, ReconcileSummary, ReconcileValue, ReconcileViewEntry,
} from "./types.ts";

const MAX_KEY_LENGTH = 256;
/** Depth bound shared with the guard's protected-value walk. */
export const MAX_DEPTH = 31;
const MAX_ENTRIES = 10_000;

function reject(message: string): never {
  throw new RecipeKitRefusal("invalid-request", message);
}

/** String-keyed enumerable own DATA value, via the descriptor — a getter or an accessor
 *  property is never invoked and never accepted, so a throwing getter cannot leak. */
function ownDataValue(record: Record<string, unknown>, key: string, message: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) reject(message);
  return descriptor.value;
}

/** Same rule for an array ELEMENT: read via the index descriptor — an accessor element is
 *  refused without ever invoking its getter. */
function listElement(list: readonly unknown[], index: number, message: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(list, index);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) reject(message);
  return descriptor.value;
}

/** Plain arrays only, descriptor-validated: a real Array with a bounded own `length` DATA
 *  property (read via the descriptor — never a getter) and no extra own keys. A replaced or
 *  hostile `map` is never read, never run. */
function plainArray(value: unknown, message: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) reject(message);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
    || typeof lengthDescriptor.value !== "number" || !Number.isInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0 || lengthDescriptor.value > MAX_ENTRIES) reject(message);
  if (value.length + 1 !== Reflect.ownKeys(value).length) reject(message);
  return value as readonly unknown[];
}

/** JSON-safe walk that refuses exotic prototypes, holes and non-finite numbers. */
export function isReconcileValue(value: unknown, depth = 0): value is ReconcileValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= MAX_DEPTH || typeof value !== "object") return false;
  // Arrays (Array.prototype) and null-prototype objects are JSON-safe; anything else exotic is not.
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return false;
  // Descriptor-only array validation: the own `length` must be a plain data number and the
  // only extra own key; element reads are plain index reads on that basis (no method runs).
  if (Array.isArray(value)) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
      || typeof lengthDescriptor.value !== "number" || value.length + 1 !== Reflect.ownKeys(value).length) return false;
    for (let index = 0; index < value.length; index += 1) {
      const element = Object.getOwnPropertyDescriptor(value, index);
      if (element === undefined || !("value" in element)) return false;
      if (!isReconcileValue(element.value, depth + 1)) return false;
    }
    return true;
  }
  return Object.keys(value).every((key) => {
    const child = ownDataValue(value as Record<string, unknown>, key, "unsafe value");
    // A guarded plain read refuses Proxy get traps that throw, without leaking their error.
    try { void (value as Record<string, unknown>)[key]; } catch { return false; }
    return safeReconcileSegment(key) === key && isReconcileValue(child, depth + 1);
  });
}

function entries(value: unknown): ReconcileEntry[] {
  const list = plainArray(value, "desired must be a bounded array of entries");
  const seen = new Set<string>();
  const out: ReconcileEntry[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const item: unknown = listElement(list, index, "desired must be a bounded array of entries");
    if (item === null || typeof item !== "object" || Array.isArray(item)) reject("entry must be a plain object");
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 2 || !keys.includes("key") || !keys.includes("value")) {
      reject("entry must contain exactly key and value");
    }
    const key = ownDataValue(record, "key", "entry must contain exactly key and value");
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH || safeReconcileSegment(key) !== key) {
      reject("entry key must be a safe non-empty string");
    }
    if (seen.has(key)) reject("duplicate entry key");
    seen.add(key);
    const entryValue = ownDataValue(record, "value", "entry must contain exactly key and value");
    if (!isReconcileValue(entryValue)) reject("entry value must be JSON-safe");
    out.push({ key, value: entryValue as ReconcileValue });
  }
  return out;
}

function projection(value: unknown): Record<string, ReconcileValue> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    reject("current must be a plain JSON object or undefined");
  }
  if (!isReconcileValue(value)) reject("current must be JSON-safe");
  return value as Record<string, ReconcileValue>;
}

function keyList(value: unknown): string[] {
  if (value === undefined) return [];
  const list = plainArray(value, "provenance must be an array of keys");
  // Stored keys may be pseudonym tokens (dotted), so only the bound applies — not the path segment grammar.
  const out: string[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const key: unknown = listElement(list, index, "provenance must be an array of keys");
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) {
      reject("provenance key must be a non-empty string");
    }
    out.push(key);
  }
  return out;
}

export function canonical(value: ReconcileValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Pure diff of the desired set against the current projection and recorded provenance.
 *  Removal candidates are provenance-backed keys only; unprovenanced desired keys that are
 *  already present surface as overlap, never as silent adoption. */
function computeReconcilePlan(input: ReconcilePlanInput): ReconcilePlan {
  const desired = entries(input.desired);
  const current = projection(input.current);
  const present = new Set(Object.keys(current));
  const owned = new Set(keyList(input.provenance).filter((key) => present.has(key)));
  const desiredKeys = new Set(desired.map((entry) => entry.key));
  const added: ReconcileKeyChange[] = [];
  const changed: ReconcileKeyChange[] = [];
  const unchanged: ReconcileKeyRef[] = [];
  const overlap: ReconcileKeyRef[] = [];
  for (const entry of desired) {
    if (!present.has(entry.key)) {
      added.push(entry);
    } else if (!owned.has(entry.key)) {
      overlap.push({ key: entry.key });
    } else if (canonical(current[entry.key]) === canonical(entry.value)) {
      unchanged.push({ key: entry.key });
    } else {
      changed.push(entry);
    }
  }
  const removed: ReconcileKeyRef[] = [...owned].filter((key) => !desiredKeys.has(key)).map((key) => ({ key }));
  return {
    added, changed, removed, unchanged, overlap,
    summary: {
      added: added.length, changed: changed.length, removed: removed.length,
      unchanged: unchanged.length, overlap: overlap.length,
    },
  };
}

/** Adversarial boundary: ANY foreign exception from untrusted input (a throwing getter, a
 *  hostile Proxy trap, an overridden array method) becomes a content-free refusal — the
 *  underlying error, and any secret it carries, never leaks. */
export function reconcilePlan(input: ReconcilePlanInput): ReconcilePlan {
  try {
    return computeReconcilePlan(input);
  } catch (error) {
    if (error instanceof RecipeKitRefusal) throw error;
    throw new RecipeKitRefusal("invalid-request");
  }
}

/** Foreign exceptions from plan-shaped input become content-free refusals. */
function contentFree(error: unknown): never {
  if (error instanceof RecipeKitRefusal) throw error;
  throw new RecipeKitRefusal("invalid-request");
}

function refEntry(value: unknown): ReconcileKeyRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject("plan entry must be a plain object");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || !keys.includes("key")) reject("plan entry must contain exactly key");
  const key = ownDataValue(record, "key", "plan entry must contain exactly key");
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH || safeReconcileSegment(key) !== key) {
    reject("plan entry key must be a safe non-empty string");
  }
  return { key };
}

function changeEntry(value: unknown): ReconcileKeyChange {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject("plan entry must be a plain object");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("key") || !keys.includes("value")) reject("plan entry must contain exactly key and value");
  const ref = refEntry({ key: ownDataValue(record, "key", "plan entry must contain exactly key and value") });
  const entryValue = ownDataValue(record, "value", "plan entry must contain exactly key and value");
  if (!isReconcileValue(entryValue)) reject("plan entry value must be JSON-safe");
  return { key: ref.key, value: entryValue as ReconcileValue };
}

function planCategory<T>(record: Record<string, unknown>, field: string, entry: (value: unknown) => T): readonly T[] {
  const list = plainArray(ownDataValue(record, field, "plan must contain exactly the plan categories and summary"),
    `plan ${field} must be a bounded plain array`);
  const out: T[] = [];
  for (let index = 0; index < list.length; index += 1) out.push(entry(listElement(list, index, `plan ${field} must be a bounded plain array`)));
  return out;
}

const SUMMARY_NAMES = ["added", "changed", "removed", "unchanged", "overlap"] as const;

function planSummary(value: unknown): ReconcileSummary {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject("plan summary must be a plain object");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const message = "plan summary must contain exactly the five counts";
  if (keys.length !== SUMMARY_NAMES.length || !SUMMARY_NAMES.every((name) => keys.includes(name))) reject(message);
  const counts = SUMMARY_NAMES.map((name) => {
    const count = ownDataValue(record, name, message);
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      reject("plan summary counts must be non-negative integers");
    }
    return count;
  });
  return { added: counts[0], changed: counts[1], removed: counts[2], unchanged: counts[3], overlap: counts[4] };
}

const PLAN_KEYS = [...SUMMARY_NAMES, "summary"];

/** Descriptor-only structural validation of a plan argument: categories must be plain
 *  arrays (a replaced or hostile `map` is refused, never executed), entries plain own-data
 *  objects (getters refused WITHOUT being invoked), the summary five non-negative integer
 *  counts. Foreign traps that throw refuse content-free at the caller's boundary. */
export function validatePlanShape(plan: unknown): ReconcilePlan {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) reject("plan must be a plain object");
  const record = plan as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== PLAN_KEYS.length || !PLAN_KEYS.every((name) => keys.includes(name))) {
    reject("plan must contain exactly the plan categories and summary");
  }
  return {
    added: planCategory(record, "added", changeEntry),
    changed: planCategory(record, "changed", changeEntry),
    removed: planCategory(record, "removed", refEntry),
    unchanged: planCategory(record, "unchanged", refEntry),
    overlap: planCategory(record, "overlap", refEntry),
    summary: planSummary(ownDataValue(record, "summary", "plan must contain exactly the plan categories and summary")),
  };
}

/** Fingerprint of an intended value keyed by its stored token: promotion of a pending
 *  provenance key requires the config value to still hash to this exact digest. */
export function reconcileIntendedFingerprint(value: ReconcileValue, token: string): string {
  return fingerprint(value, token);
}

const FINGERPRINT_HEX_LENGTH = 16;

/** Short keyed digest of the canonical form: HMAC-SHA-256 under the supplied key —
 *  unlinkable without the key. There is NO unkeyed fallback: fingerprints exist only when
 *  derived from a key. */
function fingerprint(value: ReconcileValue, key: string): string {
  return createHmac("sha256", key).update(canonical(value)).digest("hex").slice(0, FINGERPRINT_HEX_LENGTH);
}

/** PUBLIC redacted view of a plan: each entry key becomes its pseudonym when a pseudonym
 *  context is supplied, else a stable per-plan `#<index>` marker; values become short KEYED
 *  fingerprints (an explicit fingerprintKey, else the deployment's pseudonym key via the
 *  context). Raw keys and values never appear in the output, and there is NO unkeyed
 *  digest: without any key the `fingerprint` field is omitted entirely; on a read-only view
 *  (`readOnlyKey`) whose deployment key file does not exist it is the literal
 *  `"unavailable"`, keys fall back to `#<index>` markers, and the view reports `keyed:
 *  false` — nothing is created. Every foreign access — a throwing entry getter, a getter on
 *  the options themselves, a hostile category array, and both sync throws and async
 *  rejections of the pseudonymizer — becomes a content-free refusal. */
export async function reconcilePlanView(plan: ReconcilePlan, rawOptions?: ReconcilePlanViewOptions): Promise<ReconcilePlanView> {
  let shape: ReconcilePlan;
  let pseudonymize: ReconcilePlanViewOptions["pseudonymize"];
  let explicitKey: string | undefined;
  let pseudonym: ReconcilePlanViewOptions["pseudonym"];
  let readOnly = false;
  try {
    shape = validatePlanShape(plan);
    // Options are read ONCE here, descriptor-only, inside the sanitizing boundary: a getter
    // on the options object is never invoked, so a registered secret it carries cannot leak.
    pseudonymize = optionValue(rawOptions, "pseudonymize") as ReconcilePlanViewOptions["pseudonymize"];
    explicitKey = optionValue(rawOptions, "fingerprintKey") as string | undefined;
    pseudonym = optionValue(rawOptions, "pseudonym") as ReconcilePlanViewOptions["pseudonym"];
    readOnly = optionValue(rawOptions, "readOnlyKey") === true;
  } catch (error) { contentFree(error); }
  let key = explicitKey;
  let keyAvailable = true;
  if (key === undefined && pseudonym !== undefined) {
    try {
      // Read-only mode never creates the key (or its parents, or a ledger record).
      key = await (readOnly
        ? privatePseudonymKeyIfPresent(pseudonym.ctx, pseudonym.pseudonymDir)
        : privatePseudonymKey(pseudonym.ctx, pseudonym.pseudonymDir));
    } catch { throw new RecipeKitRefusal("invalid-request"); }
    if (key === undefined) keyAvailable = false;
  }
  let index = 0;
  const viewOf = async (list: readonly (ReconcileKeyChange | ReconcileKeyRef)[]): Promise<readonly ReconcileViewEntry[]> => {
    const out: ReconcileViewEntry[] = [];
    for (const entryShape of list) {
      let marker: string;
      if (pseudonymize === undefined || !keyAvailable) marker = `#${index}`;
      else {
        try { marker = await pseudonymize(entryShape.key); }
        catch { throw new RecipeKitRefusal("invalid-request"); }
      }
      index += 1;
      // The value read and digest run inside the same content-free boundary: any foreign
      // throw (e.g. a getter that slipped through to this step) refuses without leaking.
      let entry: ReconcileViewEntry;
      try {
        entry = key === undefined
          ? (keyAvailable ? { key: marker } : { key: marker, fingerprint: "unavailable" })
          : { key: marker, fingerprint: fingerprint((entryShape as ReconcileKeyChange).value ?? entryShape.key, key) };
      } catch (error) { contentFree(error); }
      out.push(entry);
    }
    return out;
  };
  return {
    added: await viewOf(shape.added),
    changed: await viewOf(shape.changed),
    removed: await viewOf(shape.removed),
    unchanged: await viewOf(shape.unchanged),
    overlap: await viewOf(shape.overlap),
    summary: shape.summary,
    keyed: key !== undefined,
  };
}

/** Descriptor-only own data property read for option objects: accessors are refused
 *  (never invoked) by returning undefined-with-refusal via the caller's boundary. */
function optionValue(options: unknown, key: string): unknown {
  if (options === undefined || options === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(options as Record<string, unknown>, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new Error("option accessor refused");
  return descriptor.value;
}
