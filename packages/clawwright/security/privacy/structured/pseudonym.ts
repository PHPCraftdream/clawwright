// Keyed pseudonyms: HMAC-SHA-256 tokens that stand in for raw identifiers in journals.
//
// Rationale for length-prefixing: the MAC input is [u32be length][utf8 bytes] per field, so
// ("ab","c") and ("a","bc") can never produce the same byte stream and the same token.
// This is pseudonymisation, not anonymisation: a token is unlinkable to its raw value
// without the deployment key, but identical inputs always map to the identical token,
// and an operator holding the key can look a candidate value up (privatePseudonymLookup).
//
// Why no instance lock: the instance lock does not wait for siblings — a concurrent call
// REFUSES (journal.ts's documented semantics) — so locking the read-then-create sequence
// would kill a losing concurrent first-caller with PrivateDataError(io) instead of letting
// it read the winner's key. The common read path therefore takes no lock at all. Creation
// stays exclusive ACROSS PROCESSES via transport.writePrivateFile (private-file.ts
// createPrivateFile), which opens with "wx" — an exclusive-create at mode 600 on POSIX and
// Windows; the loser of that race re-reads and adopts the winner's key. Same-process
// creators serialize through a module-level per-resource promise chain, mirroring
// journal.ts's `active` set.

import { createHmac, randomBytes } from "node:crypto";
import type { Context } from "../../../core/context.ts";
import { registerSecret } from "../../../core/io/log.ts";
import { recordPrivateWrite } from "../private-paths-ledger.ts";
import { createPrivateDirectory, parentPath } from "../private-config.ts";
import { PrivateDataError, gate, readBounded, rememberPrivateSecret, safeOperation, strictJson } from "./internal.ts";

export interface PrivatePseudonymOptions {
  /** Per-recipe domain separation: the recipe name is mixed into every MAC input. */
  readonly recipe: string;
  /** Sub-domain within the recipe, e.g. what kind of identifier is being pseudonymised. */
  readonly namespace: string;
  /** The raw value; never appears in output, only in the MAC input. */
  readonly value: string;
}

const KEY_VERSION = 1;
const MIN_KEY_BYTES = 32;
const MAX_FIELD = 4096;
const MAX_KEY_FILE_BYTES = 1_048_576;
// A racer may observe the winner's create-then-write file mid-write: a short or partial
// read parses as "invalid" (never "version"), so retry a bounded number of times before
// concluding tampering. Version refusals and oversized reads still refuse immediately.
const READ_RETRIES = 10;
const READ_RETRY_DELAY_MS = 25;

function field(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_FIELD) {
    throw new PrivateDataError("invalid");
  }
  return value;
}

/** Registers a key with both the journal refusal registry and the framework redaction
 *  registry, so the key can never surface in any output. Structured modules import these
 *  directly rather than through the entry file to avoid an import cycle. */
function registerKey(key: string): void {
  rememberPrivateSecret(key);
  registerSecret(key);
}

/** Validates a strict {version,key} envelope; any deviation is a content-free refusal. */
function parseKeyEnvelope(text: string): string {
  let envelope: unknown;
  try { envelope = JSON.parse(text); } catch { throw new PrivateDataError("invalid"); }
  strictJson(envelope);
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)
    || Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, "version") || !Object.hasOwn(envelope, "key")) {
    throw new PrivateDataError("invalid");
  }
  const { version, key } = envelope as { version: unknown; key: unknown };
  if (version !== KEY_VERSION) throw new PrivateDataError("version");
  if (typeof key !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) throw new PrivateDataError("invalid");
  let decoded: Buffer;
  try { decoded = Buffer.from(key, "base64"); } catch { throw new PrivateDataError("invalid"); }
  if (decoded.length < MIN_KEY_BYTES || Buffer.from(decoded.toString("base64"), "base64").length !== decoded.length
    || decoded.toString("base64") !== key) {
    throw new PrivateDataError("invalid");
  }
  return key;
}

/** Reads the key file and validates it, tolerating the create-then-write window: a short or
 *  partial file retries a bounded number of times, everything else refuses content-free. */
async function readValidatedKey(ctx: Context, target: string): Promise<string | undefined> {
  for (let attempt = 0; ; attempt++) {
    const existing = await readBounded(ctx, target, MAX_KEY_FILE_BYTES);
    if (existing === undefined) return undefined;
    try {
      return parseKeyEnvelope(existing);
    } catch (error) {
      if (attempt >= READ_RETRIES || !(error instanceof PrivateDataError) || error.code !== "invalid") throw error;
      await new Promise(resolve => setTimeout(resolve, READ_RETRY_DELAY_MS));
    }
  }
}

// One in-flight (or recently settled) creation per transport/target, used as a promise
// chain so same-process concurrent first-callers queue instead of racing the create.
const pendingCreates = new Map<string, Promise<unknown>>();

function withCreateGuard<T>(resource: string, body: () => Promise<T>): Promise<T> {
  const previous = pendingCreates.get(resource) ?? Promise.resolve();
  const run = previous.then(body, body);
  const settled = run.then(() => {}, () => {});
  pendingCreates.set(resource, settled);
  return run.finally(() => { if (pendingCreates.get(resource) === settled) pendingCreates.delete(resource); });
}

/** Returns the deployment's pseudonym key, creating it exactly once. The key file lives
 *  under a declared privatePaths directory (owner-only, mode 600). Reading takes no lock
 *  and the create is exclusive across processes via the "wx" open in writePrivateFile —
 *  a losing concurrent first-caller re-reads and adopts the winner's key, so two
 *  concurrent first-callers always end with ONE key, and an existing key is never
 *  overwritten — only read and validated. Tampering (invalid JSON, wrong version, short
 *  key, wrong encoding) refuses content-free. */
export async function privatePseudonymKey(ctx: Context, dirPath: string): Promise<string> {
  return safeOperation(async () => {
    const { ledger, boundary, target } = await gate(ctx, dirPath);
    const existing = await readValidatedKey(ctx, target);
    if (existing !== undefined) {
      registerKey(existing);
      return existing;
    }
    const resource = `${ctx.transport.description}\0${target}`;
    return withCreateGuard(resource, async () => {
      // A same-process sibling may have created the key while this caller waited.
      const raced = await readValidatedKey(ctx, target);
      if (raced !== undefined) {
        registerKey(raced);
        return raced;
      }
      const key = randomBytes(MIN_KEY_BYTES).toString("base64");
      const publish = strictJson({ version: KEY_VERSION, key });
      // Recorded before anything is written: a write that cannot be remembered is refused
      // rather than made and left unprotected once its declaration disappears. Parent
      // preparation mirrors replacePrivateTargetFile: owner-only ancestors, and an existing
      // permissive parent narrowed, before the exclusive create.
      await recordPrivateWrite(ledger, boundary);
      await createPrivateDirectory(ctx, parentPath(target), boundary);
      try {
        if (ctx.transport.writePrivateFile === undefined) throw new Error("transport cannot write private files");
        await ctx.transport.writePrivateFile(target, publish);
      } catch (error) {
        // The "wx" create failed: either a cross-process sibling won (file now exists and
        // must be adopted) or the write failed for real (refuse). The losing key never
        // left memory except into the failed create, which cannot have overwritten the
        // winner ("wx" fails before any byte is written, and createPrivateFile unlinks
        // only bytes it created itself).
        const winner = await readValidatedKey(ctx, target);
        if (winner === undefined) throw error;
        registerKey(winner);
        return winner;
      }
      // Round-trip the published bytes once, so a silently corrupt publication refuses.
      const verified = await readValidatedKey(ctx, target);
      if (verified !== key) throw new PrivateDataError("io");
      registerKey(key);
      return key;
    });
  });
}

/** Read-only sibling of privatePseudonymKey: returns the deployment's pseudonym key when the
 *  key file already exists (validated like the normal read path, registered on success), and
 *  undefined when it does not. NEVER creates the key, its parents, or a ledger record — safe
 *  for dry runs and other read-only inspections. Tampering still refuses content-free. */
export async function privatePseudonymKeyIfPresent(ctx: Context, dirPath: string): Promise<string | undefined> {
  return safeOperation(async () => {
    const { target } = await gate(ctx, dirPath);
    const existing = await readValidatedKey(ctx, target);
    if (existing !== undefined) registerKey(existing);
    return existing;
  });
}

/** HMAC-SHA-256 over length-prefixed (recipe, namespace, value); deterministic per input. */
function mac(key: string, recipe: string, namespace: string, value: string): Buffer {
  const hmac = createHmac("sha256", Buffer.from(key, "base64"));
  for (const part of [recipe, namespace, value]) {
    const bytes = Buffer.from(part, "utf8");
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(bytes.length, 0);
    hmac.update(prefix);
    hmac.update(bytes);
  }
  return hmac.digest();
}

/** Returns the fixed-size token `v1.<base64url>` for a raw value; the raw value and the
 *  key never appear in the token. */
export async function privatePseudonym(ctx: Context, dirPath: string, options: PrivatePseudonymOptions): Promise<string> {
  return safeOperation(async () => {
    const recipe = field(options.recipe);
    const namespace = field(options.namespace);
    const value = field(options.value);
    const key = await privatePseudonymKey(ctx, dirPath);
    return `v1.${mac(key, recipe, namespace, value).toString("base64url")}`;
  });
}

/** Operator-local lookup: the pseudonym token for a candidate raw value, without ever
 *  returning or printing the key. Same code path as privatePseudonym. */
export async function privatePseudonymLookup(
  ctx: Context,
  dirPath: string,
  options: { readonly recipe: string; readonly namespace: string; readonly candidate: string },
): Promise<string> {
  return privatePseudonym(ctx, dirPath, { ...options, value: options.candidate });
}
