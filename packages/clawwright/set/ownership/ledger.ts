// What this framework created, and therefore what it may remove.
//
// Without a record, dropping a recipe from a set changes nothing on the instance: nothing
// knows the agent/MCP registration/cron job it created were ours, and leftovers accumulate
// until "this instance is the set" stops being provably true.
//
// Inferring ownership from names, or assuming everything present is ours, is worse in both
// directions — too much deletes a hand-registered MCP server, too little cleans up nothing.
// So it is written down at creation time, the only moment the answer is known for certain.
//
// The ledger lives in the data directory (not beside the deployment) so it describes what
// is IN that directory and travels with a restore.

import { randomBytes } from "node:crypto";
import type { Context } from "#src/core/context.ts";
import { readFileCandidate } from "./candidate-file.ts";

/** The kinds of instance object this framework creates. Cron jobs, agents and MCP server
 *  registrations are OpenClaw's own objects, created through its CLI; mirrored files are
 *  ours directly. */
export type OwnedKind = "agent" | "mcp-server" | "cron-job";

export interface OwnedObject {
  readonly kind: OwnedKind;
  /** The identifier the instance knows it by: an agent id, a server name, a cron job name. */
  readonly name: string;
  /** The recipe it was created for — what makes "no longer in the set" answerable. */
  readonly recipe: string;
  /** The set that created it, when one was installed from an artifact. Absent for objects
   *  created before sets existed, or by an apply from the working tree. */
  readonly setId?: string;
  /** Top-level prompt files this agent creation installed. Absent on legacy entries: those
   *  files are deliberately never inferred from the workspace. */
  readonly promptFiles?: readonly string[];
  readonly createdAt: string;
}

export interface Ledger {
  readonly version: number;
  readonly objects: OwnedObject[];
}

export const LEDGER_VERSION = 1;

const OWNED_KINDS: readonly OwnedKind[] = ["agent", "mcp-server", "cron-job"];
const LEGACY_NAMESPACES = ["oc", "cf"] as const;

export function ledgerFile(ctx: Context): string {
  return `${ctx.settings.dataDir}/clawwright-managed.json`;
}

function legacyLedgerFiles(ctx: Context): string[] {
  return LEGACY_NAMESPACES.map((namespace) => `${ctx.settings.dataDir}/${namespace}-managed.json`);
}

type LedgerParseResult = { readonly ok: true; readonly ledger: Ledger } | { readonly ok: false };

/** Pure parse+validate, shared by the tolerant reader (readLedger) and the strict one
 *  (readLedgerStrict) below — the only difference between them is what each does with an
 *  `ok: false` result: the tolerant reader treats it as empty, the strict one refuses. */
function parseLedgerResult(text: string): LedgerParseResult {
  try {
    const parsed = JSON.parse(text) as Ledger;
    if (parsed === null || typeof parsed !== "object" || parsed.version !== LEDGER_VERSION || !Array.isArray(parsed.objects)) {
      return { ok: false };
    }
    // A partially written or hand-edited ledger is not proof of ownership. Discarding it is
    // the safe direction for a READER — it may report objects as foreign, never delete them.
    const seen = new Set<string>();
    const valid = parsed.objects.every((entry) => {
      if (entry === null || typeof entry !== "object") return false;
      const candidate = entry as Partial<OwnedObject>;
      const key = `${candidate.kind}\u0000${candidate.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return OWNED_KINDS.includes(candidate.kind as OwnedKind)
        && typeof candidate.name === "string" && candidate.name.length > 0
        && typeof candidate.recipe === "string" && candidate.recipe.length > 0
        && typeof candidate.createdAt === "string" && candidate.createdAt.length > 0
        && (candidate.setId === undefined || typeof candidate.setId === "string")
        && (candidate.promptFiles === undefined
          || (Array.isArray(candidate.promptFiles)
            && candidate.promptFiles.every((name) => typeof name === "string" && /^[^/\\]+\.md$/.test(name))));
    });
    return valid ? { ok: true, ledger: parsed } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function parseLedger(text: string | undefined): Ledger {
  if (text === undefined) return { version: LEDGER_VERSION, objects: [] };
  // No ledger yet, or one that can't be trusted, owns nothing as far as anyone can prove.
  // Safe for OBSERVATION (the framework won't remove what it can't show it created) — NOT
  // safe for a caller about to overwrite this file: see readLedgerStrict().
  const result = parseLedgerResult(text);
  return result.ok ? result.ledger : { version: LEDGER_VERSION, objects: [] };
}

export async function readLedger(ctx: Context): Promise<Ledger> {
  const primary = await readFileCandidate(ctx, ledgerFile(ctx));
  if (primary.present) return parseLedger(primary.text);
  for (const path of legacyLedgerFiles(ctx)) {
    const candidate = await readFileCandidate(ctx, path);
    if (candidate.present) return parseLedger(candidate.text);
  }
  return { version: LEDGER_VERSION, objects: [] };
}

/** Thrown by readLedgerStrict() when a ledger file is PRESENT but unreadable or fails
 *  validation — bytes exist that this process cannot prove are safe to discard. */
export class LedgerUnreadableError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(
      `${path} exists but could not be read as a valid ownership ledger. Recording or forgetting an ` +
        "object here would silently overwrite it with a ledger that has lost every entry it could not " +
        `prove — the bytes at ${path} have not been touched. Repair or restore this file, or import a ` +
        "known-good ledger, before retrying.",
    );
    this.name = "LedgerUnreadableError";
    this.path = path;
  }
}

/** Like readLedger(), but for callers about to WRITE a replacement (recordOwned,
 *  forgetOwned, updateOwnedPromptFiles): a ledger PRESENT but unreadable/invalid must stop
 *  the caller rather than read as empty — that would permanently lose every entry it
 *  couldn't prove the moment the write lands. A legitimately absent file still reads empty. */
export async function readLedgerStrict(ctx: Context): Promise<Ledger> {
  const primary = await readFileCandidate(ctx, ledgerFile(ctx));
  if (primary.present) {
    const result = primary.text === undefined ? { ok: false as const } : parseLedgerResult(primary.text);
    if (!result.ok) throw new LedgerUnreadableError(ledgerFile(ctx));
    return result.ledger;
  }
  for (const path of legacyLedgerFiles(ctx)) {
    const candidate = await readFileCandidate(ctx, path);
    if (candidate.present) {
      const result = candidate.text === undefined ? { ok: false as const } : parseLedgerResult(candidate.text);
      if (!result.ok) throw new LedgerUnreadableError(path);
      return result.ledger;
    }
  }
  return { version: LEDGER_VERSION, objects: [] };
}

/** Publishes content at `path` so an interrupted write can never leave partial bytes under
 *  the final name. Writes to a temporary sibling in the SAME directory (same filesystem,
 *  atomic rename), then `mv`s it over the final name — a crash before the rename leaves the
 *  previous file intact plus a stray sibling every reader ignores. Falls back to a direct
 *  write for transports with no exec capability. */
export async function writeFileAtomic(ctx: Context, path: string, content: string): Promise<void> {
  if (typeof ctx.transport.exec !== "function") {
    await ctx.transport.writeFile(path, content);
    return;
  }
  const temporary = `${path}.clawwright-staged-${randomBytes(8).toString("hex")}`;
  try {
    await ctx.transport.writeFile(temporary, content);
    const moved = await ctx.transport.exec("mv", ["-f", "--", temporary, path]);
    if (moved.code !== 0) {
      throw new Error(`could not publish ${path}: ${(moved.stderr || moved.stdout).trim()}`);
    }
  } catch (error) {
    await ctx.transport.remove(temporary).catch(() => {});
    throw error;
  }
}

async function writeLedger(ctx: Context, ledger: Ledger): Promise<void> {
  await writeFileAtomic(ctx, ledgerFile(ctx), `${JSON.stringify(ledger, null, 2)}\n`);
}

/** Records an object this framework just created, replacing any earlier entry for the same
 *  kind and name — provisioning is re-runnable, and a ledger that grew a duplicate per run
 *  would eventually claim to own the same job several times. */
export async function recordOwned(
  ctx: Context,
  entry: Omit<OwnedObject, "createdAt"> & { createdAt?: string },
): Promise<void> {
  const ledger = await readLedgerStrict(ctx);
  const objects = ledger.objects.filter((owned) => !(owned.kind === entry.kind && owned.name === entry.name));
  objects.push({ ...entry, createdAt: entry.createdAt ?? new Date().toISOString() });
  await writeLedger(ctx, { version: LEDGER_VERSION, objects });
}

export async function forgetOwned(ctx: Context, kind: OwnedKind, name: string): Promise<void> {
  const ledger = await readLedgerStrict(ctx);
  await writeLedger(ctx, {
    version: LEDGER_VERSION,
    objects: ledger.objects.filter((owned) => !(owned.kind === kind && owned.name === name)),
  });
}

/** Updates metadata for an already-owned agent without creating an ownership claim. This is
 *  needed when a recipe removes one of its prompt files: the old list is the only safe proof
 *  that the file was ours, while the new list is what the next reconciliation must use. */
export async function updateOwnedPromptFiles(ctx: Context, name: string, promptFiles: readonly string[]): Promise<void> {
  const ledger = await readLedgerStrict(ctx);
  const index = ledger.objects.findIndex((owned) => owned.kind === "agent" && owned.name === name);
  if (index === -1) return;
  const objects = [...ledger.objects];
  objects[index] = { ...objects[index], promptFiles: [...promptFiles] };
  await writeLedger(ctx, { version: LEDGER_VERSION, objects });
}

export function owns(ledger: Ledger, kind: OwnedKind, name: string): boolean {
  return ledger.objects.some((owned) => owned.kind === kind && owned.name === name);
}

/** The recorded owner of one instance object, if there is one. Keeping this lookup in the
 * ledger module makes the collision rule explicit at every caller: an existing object with
 * no entry is foreign, while an entry for another recipe is a name collision. */
export function ownerOf(ledger: Ledger, kind: OwnedKind, name: string): OwnedObject | undefined {
  return ledger.objects.find((owned) => owned.kind === kind && owned.name === name);
}

/** One object a recipe currently declares — what `orphanedBy` compares against. Keyed by
 *  kind+name+recipe, not recipe alone, so a rename (same recipe, new agentId) is caught. */
export interface DeclaredOwnership {
  readonly kind: OwnedKind;
  readonly name: string;
  readonly recipe: string;
}

/** What the framework created that no longer matches any current declaration — a recipe
 *  dropped entirely, or one still present but naming a different object (a rename). Only
 *  objects it can show it created: anything on the instance not in the ledger is somebody
 *  else's and never proposed for removal — clutter costs less than deleting a stranger's setup. */
export function orphanedBy(ledger: Ledger, declared: readonly DeclaredOwnership[]): OwnedObject[] {
  const separator = String.fromCharCode(0);
  const stillDeclared = new Set(declared.map((entry) => [entry.kind, entry.name, entry.recipe].join(separator)));
  return ledger.objects.filter((owned) => !stillDeclared.has([owned.kind, owned.name, owned.recipe].join(separator)));
}

/** Objects the instance has that this framework did not create. Reported so a reader can see
 *  the boundary rather than guess at it — and never acted on. */
export function foreign(ledger: Ledger, kind: OwnedKind, present: readonly string[]): string[] {
  return present.filter((name) => !owns(ledger, kind, name));
}
