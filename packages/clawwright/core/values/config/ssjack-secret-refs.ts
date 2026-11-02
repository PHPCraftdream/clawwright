// Reference-only declaration data; parsing is not enrollment or permission to receive values.

export const SSJACK_REFERENCE_FORMAT = "ssjack-secret-ref-v1";
export const INVALID_SSJACK_REFERENCE = "invalid ssjack secret placeholder";
export const SSJACK_DELIVERY_UNAVAILABLE = "ssjack secret placeholders require an enrolled managed consumer; delivery is unavailable";

export interface SSJackReference {
  readonly format: typeof SSJACK_REFERENCE_FORMAT;
  readonly store_id: string;
  readonly object_id: string;
  readonly version_id: string;
  readonly snapshot_id: string;
}

export interface LocatedSSJackReference {
  readonly path: readonly (string | number)[];
  readonly reference: SSJackReference;
}

const fields = ["format", "store_id", "object_id", "version_id", "snapshot_id"] as const;
const idPattern = /^[0-9a-f]{32}$/;
const zeroId = "0".repeat(32);
const maxNodes = 100000;
const maxDepth = 64;
const maxReferences = 256;

function invalid(): never { throw new Error(INVALID_SSJACK_REFERENCE); }

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return invalid();
    result[key] = descriptor.value;
  }
  return result;
}

/** Validates parsed JSON data; raw duplicate-key detection remains the raw parser's job. */
export function parseSSJackPlaceholder(value: unknown): SSJackReference | undefined {
  try {
    if (value === null || typeof value !== "object") return undefined;
    if (!Object.hasOwn(value, "$ssjack")) return undefined;
    const outer = record(value);
    if (Object.keys(outer).length !== 1) return invalid();
    const body = record(outer.$ssjack);
    if (Object.keys(body).length !== fields.length || fields.some((key) => !Object.hasOwn(body, key))) return invalid();
    if (body.format !== SSJACK_REFERENCE_FORMAT) return invalid();
    for (const key of fields.slice(1)) {
      const id = body[key];
      if (typeof id !== "string" || !idPattern.test(id) || id === zeroId) return invalid();
    }
    return Object.freeze({
      format: SSJACK_REFERENCE_FORMAT,
      store_id: body.store_id as string,
      object_id: body.object_id as string,
      version_id: body.version_id as string,
      snapshot_id: body.snapshot_id as string,
    });
  } catch { return invalid(); }
}

/** Preserves exact references and structural paths; never interpolates or reads an environment. */
export function collectSSJackReferences(value: unknown): readonly LocatedSSJackReference[] {
  const found: LocatedSSJackReference[] = [];
  const ancestors = new Set<object>();
  let visited = 0;
  function visit(node: unknown, path: readonly (string | number)[], depth: number): void {
    if (++visited > maxNodes || depth > maxDepth) return invalid();
    if (node === null || typeof node !== "object") return;
    if (ancestors.has(node)) return invalid();
    ancestors.add(node);
    try {
      const reference = parseSSJackPlaceholder(node);
      if (reference !== undefined) {
        if (found.length >= maxReferences) return invalid();
        found.push(Object.freeze({ path: Object.freeze([...path]), reference }));
        return;
      }
      if (Array.isArray(node)) {
        if (node.length > maxNodes - visited) return invalid();
        for (let index = 0; index < node.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(node, String(index));
          if (descriptor !== undefined && !("value" in descriptor)) return invalid();
          visit(descriptor?.value, [...path, index], depth + 1);
        }
      } else {
        for (const [key, child] of Object.entries(record(node))) visit(child, [...path, key], depth + 1);
      }
    } finally { ancestors.delete(node); }
  }
  try { visit(value, [], 0); }
  catch { return invalid(); }
  return Object.freeze(found);
}

/** No caller flag or parsed reference enables a secret-bearing runtime route. */
export function refuseUnenrolledSSJackReferences(value: unknown): void {
  if (collectSSJackReferences(value).length !== 0) throw new Error(SSJACK_DELIVERY_UNAVAILABLE);
}
